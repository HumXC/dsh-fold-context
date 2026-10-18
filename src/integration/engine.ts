import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
    BasicCompactionEngine,
    type BasicCompactionConfig,
} from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedBefore, type CompactionTrigger } from "@deepseek-ai/dsh-compaction";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import { ledgerProjection, type LedgerState } from "../domain/ledger.js";
import { commitInlineReleases, estimateInlineReleases } from "./inline-release.js";
import { releaseControlProjection, RELEASE_CLEANUP_SOURCE } from "../domain/release-controls.js";
import { registerReleaseControlCleanup } from "./release-control.js";
import { canReleaseInline } from "../domain/release.js";
import { hasSummaryBusinessEvidence, isSummaryControlNotice } from "../domain/summary-evidence.js";
import { createPressureProjection, planningPressure } from "../domain/pressure.js";
import { RELEASE_TARGET_KEY } from "../domain/release-report.js";
import { planPressureBudget } from "../domain/pressure-budget.js";
import {
    describeScheduling,
    describeReleaseBatch,
    type SchedulingLimits,
    type SummaryInputEstimate,
} from "../domain/scheduling-diagnostics.js";
import {
    planReleaseReminder,
    resolveReminderPolicy,
    type ReminderPolicy,
} from "../domain/reminder.js";
import type { ReleasePolicy } from "../domain/planner.js";
import { selectedExclusions } from "../domain/exclusion.js";
import { projectSummaryInput } from "../domain/summary-projection.js";
import {
    cacheExpiryEvidence,
    planReleaseBatch,
    planScheduledCompaction,
    type ReleaseBatchPlan,
    type ReleaseCacheEvidence,
    type ReleaseOpportunity,
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
        ctx.sessionProjections.register(releaseControlProjection);
        ctx.sessionProjections.register(createPressureProjection(estimateMessage));
        // The base owns overflow retry handling, including when ordinary automation is disabled.
        super(ctx, { ...compaction, auto: true });
        this.autoEnabled = compaction.auto ?? true;
        this.releasePolicy = releasePolicy;
        this.summaryPolicy = summaryPolicy;
        this.schedulingPolicy = resolveSchedulingPolicy(scheduling);
        this.reminderPolicy = resolveReminderPolicy(reminders);
        registerReleaseControlCleanup(ctx, this);
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
        if (trigger === "context-overflow") {
            await this.releaseBatch(agent, signal, "overflow");
            return super.compactIfNeeded(agent, trigger, signal);
        }
        const requested = this.hasSummaryRequest(agent.session);
        if (this.autoEnabled) {
            const budget = await this.pressureBudget(agent, signal);
            if (budget !== null && this.measurement(agent.session).totalTokens >= budget.threshold)
                return this.compactPressure(agent, signal, requested, budget);
        }
        // Capture independent work BEFORE this batch. Its own replacements cannot
        // prove that the rebuild was already paid when reconsidering a summary.
        const opportunity = this.rebuildEvidence(agent.session);
        const rebuildFrom =
            opportunity.rebuildStartSeq === null
                ? -1
                : agent.session.surface.nodes.indexOf(SessionSeq(opportunity.rebuildStartSeq));
        const targets =
            rebuildFrom < 0
                ? []
                : estimateInlineReleases(this.ctx, agent.session, this.state(agent.session))
                      .replacements;
        const coveredRebuild =
            rebuildFrom >= 0 &&
            targets.length > 0 &&
            targets.every(
                (target) =>
                    agent.session.surface.nodes.indexOf(SessionSeq(target.seq)) >= rebuildFrom,
            );
        await this.releaseBatch(agent, signal, coveredRebuild ? "rebuild" : undefined);
        if (!this.schedulingPolicy.enabled || (!requested && !this.autoEnabled)) return null;
        if (
            !requested &&
            (!this.schedulingPolicy.proactive ||
                !this.state(agent.session).entries.some((entry) => entry.status === "queued"))
        )
            return null;
        let scheduled = await this.inspectSchedule(agent, signal, opportunity);
        signal.throwIfAborted();
        if (
            scheduled.decision !== "execute" ||
            scheduled.selection === null ||
            agent.session.seq !== scheduled.revision
        )
            return null;
        if ((await this.releaseBatch(agent, signal, "summary")) > 0) {
            scheduled = await this.inspectSchedule(agent, signal, opportunity, true);
            signal.throwIfAborted();
        }
        if (
            scheduled.decision !== "execute" ||
            scheduled.selection === null ||
            agent.session.seq !== scheduled.revision
        )
            return null;
        return super.compactRegion(
            SessionSeq(scheduled.selection.start),
            SessionSeq(scheduled.selection.end),
            agent,
            signal,
        );
    }
    private cacheEvidence(session: Session): ReleaseCacheEvidence | null {
        const measurement = this.measurement(session);
        const usageSeq = measurement.usageSeq;
        if (usageSeq === null) return null;
        const event = session.eventAt(SessionSeq(usageSeq));
        const routed = session.requestHeader()?.config;
        // A completed primary message binds both route and usage provenance.
        if (
            event?.type !== "assistant/message" ||
            event.data.usage === undefined ||
            !routed?.provider ||
            !routed.model
        )
            return null;
        const source = event.data.message.source;
        if (source.kind !== "model") return null;
        return {
            routeSignature: JSON.stringify([routed.provider, routed.model]),
            usageRouteSignature: JSON.stringify([source.provider, source.model]),
            usageAtMs: event.time,
            cacheReadTokens: event.data.usage.cacheReadTokens ?? 0,
        };
    }
    private rebuildEvidence(session: Session) {
        const measured = this.measurement(session);
        const cache = this.cacheEvidence(session);
        let independentRebuildTokens = 0;
        let changed = false;
        let rebuildStartSeq: number | null = null;
        // O(surface), never a history scan. Only an already committed native
        // replacement after the latest same-route usage proves independent work.
        if (
            cache !== null &&
            cache.routeSignature === cache.usageRouteSignature &&
            measured.usageSeq !== null
        ) {
            for (const node of measured.nodes) {
                const event = session.eventAt(SessionSeq(node.seq));
                const preceding =
                    node.seq > 0 ? session.eventAt(SessionSeq(node.seq - 1)) : undefined;
                const ownRelease =
                    preceding?.type === "compaction/prune" && RELEASE_TARGET_KEY in preceding.data;
                const ownCleanup =
                    event?.type === "developer/message" &&
                    event.data.message.source.kind === RELEASE_CLEANUP_SOURCE;
                if (
                    !ownRelease &&
                    !ownCleanup &&
                    node.seq > measured.usageSeq &&
                    event?.surfaceOp !== undefined &&
                    event.surfaceOp !== "append"
                ) {
                    changed = true;
                    rebuildStartSeq ??= node.seq;
                }
                if (changed) independentRebuildTokens += node.tokens;
            }
        }
        return {
            independentRebuildTokens,
            rebuildStartSeq,
            cacheExpired: cacheExpiryEvidence(cache, Date.now(), this.schedulingPolicy.cacheTtlMs),
        };
    }
    private releasePlan(session: Session, opportunity?: ReleaseOpportunity): ReleaseBatchPlan {
        const state = this.state(session);
        const estimate = estimateInlineReleases(this.ctx, session, state);
        const releasedIds = new Set(estimate.releasedIds);
        let oldestWaitSteps = 0;
        for (const entry of state.entries) {
            if (entry.status !== "queued" || !releasedIds.has(entry.id)) continue;
            const queuedStep = entry.queuedAtBusinessStep;
            if (queuedStep !== null && queuedStep !== undefined)
                oldestWaitSteps = Math.max(oldestWaitSteps, state.businessSteps - queuedStep);
        }
        return planReleaseBatch(
            {
                revision: estimate.revision,
                totalTokens: this.measurement(session).totalTokens,
                releaseTokens: Math.max(0, estimate.beforeTokens - estimate.afterTokens),
                releaseCount: estimate.replacementCount,
                oldestWaitSteps,
                activeCompaction: state.activeStart !== null,
                ...(opportunity === undefined ? {} : { opportunity }),
                cache: this.cacheEvidence(session),
                nowMs: Date.now(),
            },
            this.schedulingPolicy,
        );
    }
    private async releaseBatch(
        agent: Agent,
        signal: AbortSignal,
        opportunity?: ReleaseOpportunity,
    ) {
        signal.throwIfAborted();
        const session = agent.session;
        const permit = this.releasePlan(session, opportunity);
        const released = commitInlineReleases(
            this.ctx,
            session,
            this.state(session),
            signal,
            permit,
        );
        if (released > 0) {
            await this.ctx.parallel("session/flush", session);
            signal.throwIfAborted();
        }
        return released;
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
    private async compactPressure(
        agent: Agent,
        signal: AbortSignal,
        requested: boolean,
        budget: NonNullable<Awaited<ReturnType<ContextCompressionEngine["pressureBudget"]>>>,
    ) {
        let measured = this.measurement(agent.session);
        if (measured.totalTokens < budget.threshold) return null;
        if ((await this.releaseBatch(agent, signal, "pressure")) > 0) {
            const refreshed = await this.pressureBudget(agent, signal);
            if (refreshed === null) return null;
            budget = refreshed;
        }
        measured = this.measurement(agent.session);
        if (measured.totalTokens < budget.threshold) return null;
        const pruner = this.ctx.get("toolResultPruner");
        if (pruner !== undefined) {
            pruner.pruneSession(agent.session);
            measured = this.measurement(agent.session);
        }
        const failure = this.latestFailure(agent.session, this.state(agent.session));
        if (failure !== null && failure.retryAfterSteps > 0) return null;
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
        const releaseBatch = this.releasePlan(agent.session);
        return {
            policy: { ...this.schedulingPolicy },
            auto: this.autoEnabled,
            revision: snapshot.revision,
            decision: snapshot.decision,
            reason: snapshot.reason,
            limits: snapshot.limits === null ? null : { ...snapshot.limits },
            summaryInput: snapshot.summaryInput === null ? null : { ...snapshot.summaryInput },
            releaseBatch: { ...releaseBatch, diagnostic: describeReleaseBatch(releaseBatch) },
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
    private latestFailure(_session: Session, state: LedgerState): SchedulingSnapshot["failure"] {
        const failure = state.lastSummaryFailure;
        if (failure == null || failure.seq <= (state.lastSummary?.seq ?? -1)) return null;
        const stepsSinceFailure = Math.max(0, state.businessSteps - failure.businessStep);
        const cooldown = Math.max(1, Math.min(8, this.schedulingPolicy.minIntervalSteps));
        const freshIntent =
            state.entries.some(
                (entry) => entry.status === "queued" && (entry.queuedAt ?? -1) > failure.seq,
            ) || state.summaryRequests.some((request) => request.seq > failure.seq);
        return {
            seq: failure.seq,
            error: failure.error.slice(0, 1000),
            stepsSinceFailure,
            retryAfterSteps: freshIntent ? 0 : Math.max(0, cooldown - stepsSinceFailure),
        };
    }
    private async inspectSchedule(
        agent: Agent,
        signal?: AbortSignal,
        opportunity = this.rebuildEvidence(agent.session),
        plannedSummary = false,
    ): Promise<SchedulingSnapshot> {
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
        const input = (
            firstSystemSeq !== undefined && head !== null ? [head, ...region] : region
        ).filter((message) => !isSummaryControlNotice(message));
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
        const preflight = estimateInlineReleases(this.ctx, session, state);
        const measuredNodes = new Map(
            measurement.nodes.map((node) => [Number(node.seq), node.tokens]),
        );
        let totalDelta = 0;
        let outsideDelta = 0;
        let inlineReleaseTokens = 0;
        for (const replacement of preflight.replacements) {
            const tokens = measuredNodes.get(replacement.seq);
            if (tokens === undefined) continue;
            const delta =
                Math.max(0, tokens + replacement.afterTokens - replacement.beforeTokens) - tokens;
            totalDelta += delta;
            if (selected.has(replacement.seq))
                inlineReleaseTokens += Math.min(tokens, replacement.releasableTokens);
            else outsideDelta += delta;
        }
        const totalTokens = Math.max(measurement.totalTokens, measurement.surfaceTokens);
        const plan = planScheduledCompaction(
            {
                trigger: requested || plannedSummary ? "model_request" : "backlog",
                totalTokens: totalTokens + outsideDelta,
                postReleaseTokens: totalTokens + totalDelta,
                inlineReleaseTokens,
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
                independentRebuildTokens: opportunity.independentRebuildTokens,
                cacheExpired: opportunity.cacheExpired,
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
        const summaryInput = input.messages.filter((message) => !isSummaryControlNotice(message));
        const images = await this.summaryImages(summaryInput, agent, signal);
        const projectionPolicy = { reasoning: this.summaryPolicy.reasoning, images };
        const messages = projectSummaryInput(
            state,
            summaryInput,
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
}
