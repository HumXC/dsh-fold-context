import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
    BasicCompactionEngine,
    type BasicCompactionConfig,
} from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedBefore, type CompactionTrigger } from "@deepseek-ai/dsh-compaction";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { ScopeKey } from "@deepseek-ai/dsh-scope";
import { ledgerProjection, type LedgerState } from "../domain/ledger.js";
import { commitInlineReleases } from "./inline-release.js";
import { canReleaseInline } from "../domain/release.js";
import { hasSummaryBusinessEvidence } from "../domain/summary-evidence.js";
import { createPressureProjection, planningPressure } from "../domain/pressure.js";
import { planPressureBudget } from "../domain/pressure-budget.js";
import {
    describeScheduling,
    type SchedulingLimits,
    type SummaryInputEstimate,
} from "../domain/scheduling-diagnostics.js";
import {
    planReleaseReminder,
    resolveReminderPolicy,
    type ReminderPolicy,
} from "../domain/reminder.js";
import { catalog, type ReleasePolicy } from "../domain/planner.js";
import { selectedExclusions } from "../domain/exclusion.js";
import { projectSummaryInput } from "../domain/summary-projection.js";
import {
    planScheduledCompaction,
    resolveSchedulingPolicy,
    selectScheduledRange,
    type ScheduledCompactionPlan,
    type ScheduledRange,
    type SchedulingPolicy,
} from "../domain/scheduler.js";
import {
    projectionStamp,
    resolveSummaryPolicy,
    type SummaryPolicy,
} from "../domain/summary-policy.js";

interface SummaryInput {
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly Message[];
}
type SummaryResult = {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
} & (
    | { rawOutput: ContentBlock[]; llmStreamCall: true }
    | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
);
interface SchedulingSnapshot {
    readonly revision: number;
    readonly limits: SchedulingLimits | null;
    readonly summaryInput: SummaryInputEstimate | null;
    readonly thresholdTokens: number | null;
    readonly selection: ScheduledRange | null;
    readonly plan: ScheduledCompactionPlan | null;
    readonly decision: "execute" | "wait";
    readonly reason: string;
    readonly failure: {
        seq: number;
        error: string;
        stepsSinceFailure: number;
        retryAfterSteps: number;
    } | null;
}

export class ContextCompressionEngine extends BasicCompactionEngine {
    private readonly agentsByScope = new WeakMap<ScopeKey, Agent>();
    readonly releasePolicy: Readonly<ReleasePolicy>;
    readonly summaryPolicy: Readonly<SummaryPolicy>;
    readonly schedulingPolicy: Readonly<SchedulingPolicy>;
    readonly autoEnabled: boolean;
    readonly reminderPolicy: Readonly<ReminderPolicy>;
    constructor(
        ctx: Context,
        compaction: BasicCompactionConfig,
        releasePolicy: Readonly<ReleasePolicy>,
        summaryPolicy: Readonly<SummaryPolicy> = resolveSummaryPolicy(),
        scheduling: Partial<SchedulingPolicy> = {},
        reminders: Partial<ReminderPolicy> = {},
    ) {
        ctx.sessionProjections.register(ledgerProjection);
        ctx.sessionProjections.register(
            createPressureProjection((message) => ctx.tokenMeter.estimateMessage(message)),
        );
        // The base owns overflow retry handling, including when ordinary automation is disabled.
        super(ctx, { ...compaction, auto: true });
        this.autoEnabled = compaction.auto ?? true;
        this.releasePolicy = releasePolicy;
        this.summaryPolicy = summaryPolicy;
        this.schedulingPolicy = resolveSchedulingPolicy(scheduling);
        this.reminderPolicy = resolveReminderPolicy(reminders);
    }
    state(session: Session) {
        const state = this.ctx.sessionProjections.stateOf(session, "contextCompression");
        if (state === undefined)
            throw new Error("fold-context: ledger projection is not registered");
        return state;
    }
    hasSummaryRequest(session: Session): boolean {
        const state = this.state(session);
        return state.summaryRequests.some(
            (request) =>
                (request.status === "queued" ||
                    (request.status === "failed" && request.retryable)) &&
                request.seq > (state.lastSummary?.seq ?? -1),
        );
    }
    override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) {
        signal.throwIfAborted();
        this.agentsByScope.set(agent, agent);
        if (commitInlineReleases(this.ctx, agent.session, this.state(agent.session), signal) > 0) {
            await this.ctx.parallel("session/flush", agent.session);
            signal.throwIfAborted();
        }
        if (trigger === "context-overflow") return super.compactIfNeeded(agent, trigger, signal);
        const requested = this.hasSummaryRequest(agent.session);
        if (!this.schedulingPolicy.enabled && requested)
            return super.compactIfNeeded(agent, "context-overflow", signal);
        if (this.autoEnabled) {
            const result = await this.compactPressure(agent, signal, requested);
            if (result !== null) return result;
        }
        if (!this.schedulingPolicy.enabled || (!requested && !this.autoEnabled)) return null;
        if (
            !requested &&
            (!this.schedulingPolicy.proactive ||
                !this.state(agent.session).entries.some((entry) => entry.status === "queued"))
        )
            return null;
        const scheduled = await this.inspectSchedule(agent, signal);
        signal.throwIfAborted();
        if (scheduled.decision !== "execute" || scheduled.selection === null) return null;
        // Metadata resolution may yield; never apply a decision to a different surface revision.
        if (agent.session.seq !== scheduled.revision) return null;
        return super.compactRegion(
            SessionSeq(scheduled.selection.start),
            SessionSeq(scheduled.selection.end),
            agent,
            signal,
        );
    }
    private selectionHasBusinessEvidence(
        session: Session,
        start: SessionSeq,
        end: SessionSeq,
    ): boolean {
        const nodes = session.surface.nodes;
        const first = nodes.indexOf(start);
        const last = nodes.indexOf(end);
        if (first < 0 || last < first) return false;
        const snapshots = new Map(
            this.pressureState(session).nodes.map((node) => [node.seq, node.snapshotEvidence]),
        );
        const tools = new Map(
            this.state(session).numbering.slots.map((slot) => [slot.currentSeq, slot.tool]),
        );
        return nodes.slice(first, last + 1).some((seq) => {
            const event = session.eventAt(seq);
            const message = event === undefined ? null : session.deriveEventMessage(event);
            return (
                message !== null &&
                hasSummaryBusinessEvidence(
                    message,
                    tools.get(seq) ?? null,
                    snapshots.get(seq) ?? undefined,
                )
            );
        });
    }
    private pressureState(session: Session) {
        const state = this.ctx.sessionProjections.stateOf(session, "contextCompressionPressure");
        if (state === undefined)
            throw new Error("fold-context: pressure projection is not registered");
        return state;
    }
    pressureStatus(session: Session) {
        const state = this.pressureState(session);
        const { nodes: _nodes, ...pressure } = planningPressure(
            state,
            this.ctx.tokenMeter.measure(session),
        );
        return { ...pressure, retentionPenalty: state.retentionPenalty, effect: state.effect };
    }
    private measurement(session: Session) {
        const native = this.ctx.tokenMeter.measure(session);
        return { ...native, ...planningPressure(this.pressureState(session), native) };
    }
    private modelPressureBudget(window: number | undefined, provider: string, model: string) {
        const override = this.config.modelPolicies.find(
            (item) => item.provider === provider && item.model === model,
        );
        const budget = planPressureBudget(window, {
            thresholdRatio: override?.thresholdRatio ?? this.config.thresholdRatio,
            retainRatio: override?.retainRatio ?? this.config.retainRatio ?? 0,
            retainTokens:
                override?.retainTokens ??
                (override?.retainRatio === undefined ? this.config.retainTokens : undefined),
        });
        return budget === null
            ? null
            : { ...budget, retries: override?.compactionRetries ?? this.config.compactionRetries };
    }
    private async pressureModelInfo(provider: string, model: string, signal?: AbortSignal) {
        try {
            const info = await this.ctx.llm.resolveModelInfo(provider, model, signal);
            signal?.throwIfAborted();
            return info;
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            return null;
        }
    }
    private async pressureBudget(agent: Agent, signal?: AbortSignal) {
        const header = agent.session.requestHeader()?.config;
        if (!header?.provider || !header.model) return null;
        const revision = agent.session.seq;
        const info = await this.pressureModelInfo(header.provider, header.model, signal);
        if (agent.session.seq !== revision || info === null) return null;
        return this.modelPressureBudget(info.context?.contextWindow, header.provider, header.model);
    }
    private retentionTokens(session: Session, retain: number, threshold: number) {
        const state = this.pressureState(session);
        const effect = state.effect;
        const missedTarget =
            effect?.observedPromptTokens !== null &&
            effect?.observedPromptTokens !== undefined &&
            effect.observedPromptTokens >= threshold &&
            effect.route?.provider === state.route?.provider &&
            effect.route?.model === state.route?.model;
        // A provider-confirmed budget miss uses the widest balanced prefix on the next pass.
        // Repeating a fixed half-tail can otherwise strand the same expensive replay forever.
        return missedTarget ? 0 : Math.floor(retain / 2 ** state.retentionPenalty);
    }
    private protectedTailStart(session: Session) {
        const nodes = session.surface.nodes;
        const tools = new Map(
            this.state(session).numbering.slots.map((slot) => [slot.currentSeq, slot.tool]),
        );
        const snapshots = new Map(
            this.pressureState(session).nodes.map((node) => [node.seq, node.snapshotEvidence]),
        );
        let latestBusiness = nodes.length - 1;
        let latestHuman = -1;
        let latestBusinessAssistant = -1;
        for (let index = 0; index < nodes.length; index++) {
            const seq = nodes[index]!;
            const event = session.eventAt(seq);
            const message = event === undefined ? null : session.deriveEventMessage(event);
            if (message === null) continue;
            if (message.role === "user" && message.source.kind === "user") latestHuman = index;
            if (
                hasSummaryBusinessEvidence(
                    message,
                    tools.get(seq) ?? null,
                    snapshots.get(seq) ?? undefined,
                )
            ) {
                latestBusiness = index;
                if (message.role === "assistant") latestBusinessAssistant = index;
            }
        }
        return latestHuman > latestBusinessAssistant
            ? Math.min(latestBusiness, latestHuman)
            : latestBusiness;
    }
    private pressureRange(
        session: Session,
        measurement: ReturnType<ContextCompressionEngine["measurement"]>,
        retain: number,
    ) {
        const allowedCuts = new Set(
            session.surface.nodes.slice(0, this.protectedTailStart(session) + 1),
        );
        const headSeq = measurement.nodes[0]?.seq;
        const headEvent = headSeq === undefined ? undefined : session.eventAt(SessionSeq(headSeq));
        const head = headEvent === undefined ? null : session.deriveEventMessage(headEvent);
        return selectScheduledRange({
            nodes: measurement.nodes,
            retainTokens: retain,
            ...(head?.role === "system" && headSeq !== undefined
                ? { firstSystemSeq: headSeq }
                : {}),
            legalCutPredicate: (seq) =>
                allowedCuts.has(SessionSeq(seq)) &&
                toolPairingBalancedBefore(session, SessionSeq(seq)),
        });
    }
    private async compactPressure(agent: Agent, signal: AbortSignal, requested: boolean) {
        const budget = await this.pressureBudget(agent, signal);
        if (budget === null) return null;
        let measured = this.measurement(agent.session);
        if (measured.totalTokens < budget.threshold) return null;
        const pruner = this.ctx.get("toolResultPruner");
        if (pruner !== undefined) {
            pruner.pruneSession(agent.session);
            measured = this.measurement(agent.session);
        }
        let result: Awaited<ReturnType<BasicCompactionEngine["compactRegion"]>> | null = null;
        let retain = this.retentionTokens(agent.session, budget.retain, budget.threshold);
        for (
            let attempt = 0;
            attempt <= budget.retries && measured.totalTokens >= budget.threshold;
            attempt++
        ) {
            signal.throwIfAborted();
            const range = this.pressureRange(agent.session, measured, retain);
            if (range === null) return result;
            if (
                !(requested && result === null) &&
                !this.selectionHasBusinessEvidence(
                    agent.session,
                    SessionSeq(range.start),
                    SessionSeq(range.end),
                )
            )
                return result;
            const before = measured.totalTokens;
            result = await super.compactRegion(
                SessionSeq(range.start),
                SessionSeq(range.end),
                agent,
                signal,
            );
            measured = this.measurement(agent.session);
            if (measured.totalTokens >= before) return result;
            retain = Math.floor(retain / 2);
        }
        return result;
    }
    async schedulingStatus(
        agent: Agent,
        signal?: AbortSignal,
        limit = this.releasePolicy.catalogLimit,
    ) {
        const snapshot = await this.inspectSchedule(agent, signal);
        const plan = snapshot.plan;
        const bound = Math.max(1, Math.min(128, limit));
        const pressure = this.pressureStatus(agent.session);
        const effect = pressure.effect;
        const threshold = snapshot.thresholdTokens;
        return {
            policy: { ...this.schedulingPolicy },
            auto: this.autoEnabled,
            revision: snapshot.revision,
            decision: snapshot.decision,
            reason: snapshot.reason,
            limits: snapshot.limits === null ? null : { ...snapshot.limits },
            summaryInput: snapshot.summaryInput === null ? null : { ...snapshot.summaryInput },
            diagnostic: describeScheduling(
                { ...snapshot, retryAfterSteps: snapshot.failure?.retryAfterSteps ?? 0 },
                this.schedulingPolicy,
            ),
            selection: snapshot.selection === null ? null : { ...snapshot.selection },
            failure: snapshot.failure === null ? null : { ...snapshot.failure },
            plan:
                plan === null
                    ? null
                    : {
                          ...plan,
                          markedIds: plan.markedIds.slice(0, bound),
                          markedIdsOmitted: Math.max(0, plan.markedIds.length - bound),
                      },
            pressure: {
                ...pressure,
                thresholdTokens: threshold,
                estimatedBelowThreshold:
                    threshold === null ? null : pressure.totalTokens < threshold,
                verification:
                    effect === null
                        ? "no_compaction"
                        : effect.status === "awaiting_usage" ||
                            effect.status === "awaiting_replacement"
                          ? effect.status
                          : effect.status === "route_changed"
                            ? "route_changed"
                            : threshold === null
                              ? "unknown_target"
                              : effect.observedPromptTokens! < threshold
                                ? "below_threshold"
                                : "above_threshold",
            },
            estimates:
                "HEURISTIC planning costs; replay output usage is a conservative estimate; effect remains unverified until a later primary request reports usage",
        };
    }
    async releaseReminder(agent: Agent, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const session = agent.session;
        const header = session.requestHeader()?.config;
        let threshold: number | null = null;
        if (this.reminderPolicy.enabled && header?.provider && header.model) {
            const info = await this.pressureModelInfo(header.provider, header.model, signal);
            signal?.throwIfAborted();
            const current = session.requestHeader()?.config;
            if (
                info !== null &&
                current?.provider === header.provider &&
                current.model === header.model &&
                current.maxTokens === header.maxTokens
            ) {
                threshold =
                    this.modelPressureBudget(
                        info.context?.contextWindow,
                        header.provider,
                        header.model,
                    )?.threshold ?? null;
            }
        }
        const state = this.state(session);
        const measurement = this.measurement(session);
        const tokens = new Map(measurement.nodes.map((node) => [node.seq as number, node.tokens]));
        const candidates = state.entries.flatMap((entry) => {
            if (
                entry.role !== "tool" ||
                entry.status !== "available" ||
                !canReleaseInline(state, entry)
            )
                return [];
            return [
                {
                    id: entry.id,
                    tool: entry.tool,
                    preview: entry.preview,
                    tokens: Math.max(0, Math.floor(tokens.get(entry.currentSeq!) ?? 0)),
                    ageSteps: Math.max(0, state.businessSteps - entry.admittedAtBusinessStep),
                    seq: entry.currentSeq!,
                },
            ];
        });
        const plan = planReleaseReminder(
            {
                step: state.businessSteps,
                candidates,
                previous: state.reminderState,
                progressSeq: state.lastReleaseProgressSeq,
                activeCompaction: state.activeStart !== null,
                pressure:
                    threshold !== null && threshold > 0
                        ? measurement.totalTokens / threshold
                        : null,
            },
            this.reminderPolicy,
        );
        return { ...plan, businessSteps: state.businessSteps, thresholdTokens: threshold };
    }
    private committedStepsAfter(state: LedgerState, seq: number): number {
        return state.numbering.slots.filter(
            (slot) => slot.role === "assistant" && slot.sourceSeq !== null && slot.sourceSeq > seq,
        ).length;
    }
    private latestFailure(session: Session, state: LedgerState): SchedulingSnapshot["failure"] {
        const lastSummary = state.lastSummary?.seq ?? 0;
        for (let seq = session.seq - 1; seq > lastSummary; seq--) {
            const event = session.eventAt(SessionSeq(seq));
            if (event?.type !== "compaction/end" || event.data.error === undefined) continue;
            const stepsSinceFailure = this.committedStepsAfter(state, event.seq);
            const cooldown = Math.max(1, Math.min(8, this.schedulingPolicy.minIntervalSteps));
            const freshIntent =
                state.entries.some(
                    (entry) => entry.status === "queued" && (entry.queuedAt ?? 0) > event.seq,
                ) || state.summaryRequests.some((request) => request.seq > event.seq);
            return {
                seq: event.seq,
                error: event.data.error.slice(0, 1000),
                stepsSinceFailure,
                retryAfterSteps: freshIntent ? 0 : Math.max(0, cooldown - stepsSinceFailure),
            };
        }
        return null;
    }
    private async inspectSchedule(agent: Agent, signal?: AbortSignal): Promise<SchedulingSnapshot> {
        signal?.throwIfAborted();
        const session = agent.session;
        const revision = session.seq;
        const state = this.state(session);
        const failure = this.latestFailure(session, state);
        const wait = (reason: string): SchedulingSnapshot => ({
            thresholdTokens: null,
            limits: null,
            summaryInput: null,
            revision,
            selection: null,
            plan: null,
            decision: "wait",
            reason,
            failure,
        });
        if (state.activeStart !== null) return wait("active_compaction");
        const header = session.requestHeader();
        const routed = header?.config;
        if (!routed?.provider || !routed.model) return wait("no_route");
        const info = await this.pressureModelInfo(routed.provider, routed.model, signal);
        if (session.seq !== revision) return wait("state_changed");
        if (info === null) return wait("metadata_unavailable");
        const window = info.context?.contextWindow;
        if (window === undefined) return wait("missing_capacity");
        const budget = this.modelPressureBudget(window, routed.provider, routed.model);
        if (budget === null) return wait("invalid_capacity");
        const { threshold, retain } = budget;
        const measurement = this.measurement(session);
        const headSeq = measurement.nodes[0]?.seq;
        const headEvent = headSeq === undefined ? undefined : session.eventAt(SessionSeq(headSeq));
        const head = headEvent === undefined ? null : session.deriveEventMessage(headEvent);
        const firstSystemSeq = head?.role === "system" ? headSeq : undefined;
        const retentionTokens = this.retentionTokens(session, retain, threshold);
        const selection = this.pressureRange(session, measurement, retentionTokens);
        const headerOverheadTokens = Math.max(
            0,
            measurement.totalTokens - measurement.surfaceTokens,
        );
        const systemHeadTokens = firstSystemSeq === undefined ? 0 : measurement.nodes[0]!.tokens;
        const protectedSeqs = new Set<number>(
            session.surface.nodes.slice(this.protectedTailStart(session)),
        );
        const protectedTailTokens = measurement.nodes.reduce(
            (total, node) =>
                total +
                (node.seq !== firstSystemSeq && protectedSeqs.has(node.seq) ? node.tokens : 0),
            0,
        );
        const limits: SchedulingLimits = {
            heuristic: "HEURISTIC",
            contextWindowTokens: window,
            thresholdTokens: threshold,
            retentionTokens,
            headerOverheadTokens,
            systemHeadTokens,
            protectedTailTokens,
            minimumPromptTokens: headerOverheadTokens + systemHeadTokens + protectedTailTokens,
        };
        if (
            selection !== null &&
            this.autoEnabled &&
            measurement.totalTokens >= threshold &&
            !this.hasSummaryRequest(session) &&
            !this.selectionHasBusinessEvidence(
                session,
                SessionSeq(selection.start),
                SessionSeq(selection.end),
            )
        )
            return {
                ...wait(
                    this.pressureState(session).effect?.status === "ineffective"
                        ? "ineffective_compaction"
                        : "no_business_evidence",
                ),
                thresholdTokens: threshold,
                limits,
                selection,
            };
        const start =
            selection === null
                ? -1
                : measurement.nodes.findIndex((node) => node.seq === selection.start);
        const end =
            selection === null
                ? -1
                : measurement.nodes.findIndex((node) => node.seq === selection.end);
        const selectedNodes = start < 0 ? [] : measurement.nodes.slice(start, end + 1);
        const selected = new Set(selectedNodes.map((node) => node.seq));
        const excluded = selectedExclusions(state, selected, revision, "transcript");
        const region = selectedNodes.flatMap((node) => {
            const event = session.eventAt(SessionSeq(node.seq));
            const message = event === undefined ? null : session.deriveEventMessage(event);
            return message === null ? [] : [message];
        });
        const input = firstSystemSeq !== undefined && head !== null ? [head, ...region] : region;
        const images = await this.summaryImages(input, agent, signal);
        signal?.throwIfAborted();
        if (session.seq !== revision) return wait("state_changed");
        const projected =
            selection === null
                ? []
                : projectSummaryInput(state, input, revision, {
                      reasoning: this.summaryPolicy.reasoning,
                      images,
                  });
        // Include the preserved system head and request envelope in the auxiliary call estimate.
        // The fixed allowance covers the official instruction and checkpoint framing.
        const projectedTokens = projected.reduce(
            (total, message) => total + this.ctx.tokenMeter.estimateMessage(message),
            0,
        );
        const systemTokens =
            selection === null || firstSystemSeq === undefined
                ? 0
                : this.ctx.tokenMeter.estimateMessage(head!);
        const summaryInput: SummaryInputEstimate | null =
            selection === null
                ? null
                : {
                      historyTokens: projectedTokens - systemTokens,
                      systemTokens,
                      toolsTokens: this.pressureState(session).toolsTokens,
                      framingTokens: 256,
                      totalTokens: projectedTokens + this.pressureState(session).toolsTokens + 256,
                  };
        const filterInputTokens = summaryInput?.totalTokens ?? 0;
        const usage =
            measurement.baseline.kind === "usage" ? measurement.baseline.usage : undefined;
        const cacheState =
            usage?.cacheReadTokens === undefined
                ? "unknown"
                : usage.cacheReadTokens === 0
                  ? "uncached"
                  : "cached";
        const requested = this.hasSummaryRequest(session);
        const override = this.config.modelPolicies.find(
            (policy) => policy.provider === routed.provider && policy.model === routed.model,
        );
        const plan = planScheduledCompaction(
            {
                trigger: requested ? "model_request" : "backlog",
                totalTokens: Math.max(measurement.totalTokens, measurement.surfaceTokens),
                selectedTokens: selectedNodes.reduce((total, node) => total + node.tokens, 0),
                prefixTokens: firstSystemSeq === undefined ? 0 : measurement.nodes[0]!.tokens,
                filterInputTokens,
                stepsSinceSummary: this.committedStepsAfter(state, state.lastSummary?.seq ?? 0),
                markedIds: excluded.map((entry) => entry.id),
                routeSignature: JSON.stringify({
                    request: {
                        provider: routed.provider,
                        model: routed.model,
                        maxTokens: routed.maxTokens ?? null,
                    },
                    summaryProvider:
                        override?.summarizationProvider ?? this.config.summarizationProvider,
                    summaryModel: override?.summarizationModel ?? this.config.summarizationModel,
                    images,
                }),
                cacheState,
                headerOverheadTokens,
                auto: this.autoEnabled,
                ...(this.autoEnabled && measurement.totalTokens >= threshold
                    ? { forceSafety: "pressure" as const }
                    : {}),
            },
            this.schedulingPolicy,
        );
        const cooling =
            plan.forceSafety === null && failure !== null && failure.retryAfterSteps > 0;
        return {
            revision,
            thresholdTokens: threshold,
            limits,
            summaryInput,
            selection,
            plan,
            decision: cooling ? "wait" : plan.decision,
            reason: cooling ? "failed_cooldown" : plan.reason,
            failure,
        };
    }
    private async summaryImages(messages: readonly Message[], agent: Agent, signal?: AbortSignal) {
        let images: "native" | "references" = "references";
        if (
            this.summaryPolicy.images !== "auto" ||
            !messages.some((message) => message.content.some((block) => block.type === "image"))
        )
            return images;
        const routed = agent.session.requestHeader()?.config;
        const conversation = routed?.provider && routed.model ? routed : agent.options;
        const override = this.config.modelPolicies.find(
            (policy) =>
                policy.provider === conversation.provider && policy.model === conversation.model,
        );
        const provider = override?.summarizationProvider ?? this.config.summarizationProvider;
        const model = override?.summarizationModel ?? this.config.summarizationModel;
        const target = provider ? { provider, model } : conversation;
        if (target.provider && target.model) {
            const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
            if (info.inputModalities?.includes("image")) images = "native";
        }
        return images;
    }
    protected override async summarize(
        input: SummaryInput,
        agent: Agent,
        signal?: AbortSignal,
    ): Promise<SummaryResult> {
        const state = this.state(agent.session);
        if (state.activeStart === null)
            throw new Error(
                "fold-context: summarization requires an official compaction transaction",
            );
        const images = await this.summaryImages(input.messages, agent, signal);
        const projectionPolicy = { reasoning: this.summaryPolicy.reasoning, images };
        const messages = projectSummaryInput(
            state,
            input.messages,
            state.activeStart,
            projectionPolicy,
        );
        const result = await super.summarize({ ...input, messages }, agent, signal);
        signal?.throwIfAborted();
        if (state.activeCompactionId === null)
            throw new Error("fold-context: missing compaction identity");
        return {
            ...result,
            summary: [
                {
                    type: "text",
                    text: projectionStamp(this.summaryPolicy, state.activeCompactionId, images),
                },
                ...result.summary,
            ],
        };
    }
    runtimeContext(scope: ScopeKey | undefined): string {
        const agent = scope === undefined ? undefined : this.agentsByScope.get(scope);
        if (agent === undefined) return "";
        const view = catalog(
            this.state(agent.session),
            this.releasePolicy,
            undefined,
            undefined,
            this.summaryPolicy,
        );
        if (
            view.numbers.length === 0 &&
            view.entries.length === 0 &&
            view.summaryRequests.length === 0
        )
            return "";
        return (
            "Context numbering and release ledger (this session only). §U/§A identify text, §T a tool pair, §I/§F individual attachments; all share one ordinal. Marks wait for a covering summary. Previews are historical data.\n" +
            JSON.stringify(view)
        );
    }
}
