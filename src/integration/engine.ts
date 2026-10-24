import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
    nativeCompactionConfig,
    resolveFoldCompactionConfig,
    type FoldCompactionConfig,
} from "../config.js";
import {
    summaryCandidates,
    sameSummaryRoute,
    type SummaryModel,
} from "../domain/summary-models.js";
import { conversationRoute, isSummaryModelFailure, requestSummary } from "./summarizer.js";
import {
    toolPairingBalancedBefore,
    toolPairingBalancedAfter,
    type CompactionTrigger,
} from "@deepseek-ai/dsh-compaction";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import { observeSessionCut, type SessionCut } from "./session-cut.js";
import { SessionSummaryCoordinator, hasSessionDriver } from "./session-summary.js";
import { validateSummaryRange } from "../domain/summary-range.js";
import { MAX_SUMMARY_STEPS, type SessionSummaryPlan } from "../domain/session-summary.js";
import { sessionSummaryStamp } from "../domain/summary-policy.js";
import { ledgerProjection, type LedgerState } from "../domain/ledger.js";
import { commitInlineReleases, estimateInlineReleases } from "./inline-release.js";
import { releaseControlProjection, RELEASE_CLEANUP_SOURCE } from "../domain/release-controls.js";
import { SESSION_SUMMARY_CLEANUP_SOURCE } from "../domain/session-summary-controls.js";
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
import type { PolicyValues } from "../domain/settings-catalog.js";
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

interface EnginePolicySnapshot {
    fold: ReturnType<typeof resolveFoldCompactionConfig>;
    summary: Readonly<SummaryPolicy>;
    scheduling: Readonly<SchedulingPolicy>;
    reminders: Readonly<ReminderPolicy>;
    models: SummaryModel[];
}
export class ContextCompressionEngine extends BasicCompactionEngine {
    readonly releasePolicy: Readonly<ReleasePolicy>;
    private policyState: EnginePolicySnapshot;
    private readonly policyScope = new AsyncLocalStorage<{
        session: Session;
        snapshot: EnginePolicySnapshot;
    }>();
    private readonly sessionPolicies = new WeakMap<Session, EnginePolicySnapshot>();
    private get policySnapshot() {
        return this.policyScope.getStore()?.snapshot ?? this.policyState;
    }
    get summaryPolicy() {
        return this.policySnapshot.summary;
    }
    get schedulingPolicy() {
        return this.policySnapshot.scheduling;
    }
    get autoEnabled() {
        return this.policySnapshot.fold.auto;
    }
    get reminderPolicy() {
        return this.policySnapshot.reminders;
    }
    private get foldPolicy() {
        return this.policySnapshot.fold;
    }
    private readonly sessionSummaries: SessionSummaryCoordinator;
    private readonly windowBudgets = new WeakMap<Session, { threshold: number; safety: number }>();
    private readonly preparedSessionSummaries = new WeakMap<
        Session,
        { plan: SessionSummaryPlan; summary: string | null }
    >();
    constructor(
        ctx: Context,
        compaction: FoldCompactionConfig,
        releasePolicy: Readonly<ReleasePolicy>,
        summaryPolicy: Readonly<SummaryPolicy> = resolveSummaryPolicy(),
        scheduling: Partial<SchedulingPolicy> = {},
        reminders: Partial<ReminderPolicy> = {},
        private readonly readSummaryModels: () => SummaryModel[] = () => [],
        private readonly readPolicies?: () => PolicyValues,
    ) {
        ctx.sessionProjections.register(ledgerProjection);
        ctx.sessionProjections.register(releaseControlProjection);
        ctx.sessionProjections.register(createPressureProjection(estimateMessage));
        // The base owns overflow retry handling, including when ordinary automation is disabled.
        super(ctx, nativeCompactionConfig(compaction));
        this.releasePolicy = releasePolicy;
        this.policyState = {
            fold: resolveFoldCompactionConfig(compaction),
            summary: summaryPolicy,
            scheduling: resolveSchedulingPolicy(scheduling),
            reminders: resolveReminderPolicy(reminders),
            models: structuredClone(this.readSummaryModels()),
        };
        registerReleaseControlCleanup(ctx, this);
        this.sessionSummaries = new SessionSummaryCoordinator(ctx, this);
    }
    private withPolicy<T>(session: Session, operation: () => T, refresh = true): T {
        if (this.policyScope.getStore()?.session === session) return operation();
        const pinned = this.sessionPolicies.get(session);
        const active =
            this.state(session).activeStart !== null || this.hasSessionSummaryWork(session);
        let snapshot = pinned ?? this.policyState;
        if (refresh && !active) {
            const policy = this.readPolicies ? structuredClone(this.readPolicies()) : null;
            snapshot = policy
                ? {
                      fold: resolveFoldCompactionConfig(policy.compaction),
                      summary: resolveSummaryPolicy(policy.summary),
                      scheduling: resolveSchedulingPolicy(policy.scheduling),
                      reminders: resolveReminderPolicy(policy.reminders),
                      models: structuredClone(this.readSummaryModels()),
                  }
                : { ...snapshot, models: structuredClone(this.readSummaryModels()) };
            this.sessionPolicies.set(session, snapshot);
            this.policyState = snapshot;
        }
        return this.policyScope.run({ session, snapshot }, operation);
    }
    override compactRegion(...args: Parameters<BasicCompactionEngine["compactRegion"]>) {
        return this.withPolicy(args[2].session, () => super.compactRegion(...args));
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
    sessionSummaryStatus(session: Session) {
        const active = this.sessionSummaries.state(session).active;
        if (!active) return null;
        return {
            checkpointId: active.plan.checkpointId,
            phase: active.phase,
            provider: active.plan.provider,
            model: active.plan.model,
            steps: active.steps,
            maxSteps: MAX_SUMMARY_STEPS,
            manual: active.plan.manual,
            messageCount: active.plan.range.messages.length,
            attachmentCount: active.plan.range.attachments.length,
            previousCheckpointCount: active.plan.range.checkpoints.length,
            compactionId: active.compactionId,
            reason: active.reason,
        };
    }
    hasSessionSummaryWork(session: Session): boolean {
        return this.sessionSummaries.pending(session);
    }
    sessionSummaryTarget(agent: Agent) {
        const current = conversationRoute(agent);
        const target = summaryCandidates(this.policySnapshot.models, current)[0];
        if (
            !target ||
            (!target.useSessionAgent && !target.onlyWhenSessionMatches) ||
            !sameSummaryRoute(target, current)
        )
            return null;
        return { ...target, maxTokens: this.foldPolicy.summaryMaxTokens };
    }
    async manualSessionSummaryRange(session: Session, signal?: AbortSignal) {
        using cut = await observeSessionCut(this.ctx, session, signal);
        if (!cut.current(session)) return null;
        const nodes = cut.surface.map(SessionSeq);
        const head = nodes[0] === undefined ? undefined : cut.events.get(nodes[0]);
        const start = head && session.deriveEventMessage(head)?.role === "system" ? 1 : 0;
        if (nodes[start] === undefined || !toolPairingBalancedBefore(session, nodes[start]))
            return null;
        for (let end = nodes.length - 1; end >= start; end--) {
            if (!toolPairingBalancedAfter(session, nodes[end]!)) continue;
            if (this.selectionHasBusinessEvidence(session, nodes[start]!, nodes[end]!, cut))
                return { start: Number(nodes[start]), end: Number(nodes[end]) };
        }
        return null;
    }
    override compactNow(...args: Parameters<BasicCompactionEngine["compactNow"]>) {
        return this.withPolicy(args[0].session, () => this.compactNowWithPolicy(...args));
    }
    private async compactNowWithPolicy(
        agent: Parameters<BasicCompactionEngine["compactNow"]>[0],
        signal: AbortSignal,
        sourceCommandId?: Parameters<BasicCompactionEngine["compactNow"]>[2],
    ) {
        if (!hasSessionDriver(agent) || !this.sessionSummaryTarget(agent))
            return super.compactNow(agent, signal, sourceCommandId);
        const result = await this.sessionSummaries.manual(agent, signal, sourceCommandId);
        if (result !== null)
            return sourceCommandId === undefined ? result : { ...result, sourceCommandId };
        return super.compactNow(agent, signal, sourceCommandId);
    }
    private async compactSelectedRange(
        start: SessionSeq,
        end: SessionSeq,
        agent: Agent,
        signal: AbortSignal,
    ) {
        if (await this.sessionSummaries.prepare(agent, { start, end }, signal)) return null;
        return super.compactRegion(start, end, agent, signal);
    }
    commitSessionSummary(
        agent: Agent,
        plan: SessionSummaryPlan,
        summary: string | null,
        signal: AbortSignal,
    ) {
        return this.withPolicy(agent.session, () =>
            this.commitSessionSummaryWithPolicy(agent, plan, summary, signal),
        );
    }
    private async commitSessionSummaryWithPolicy(
        agent: Agent,
        plan: SessionSummaryPlan,
        summary: string | null,
        signal: AbortSignal,
    ) {
        using cut = await observeSessionCut(this.ctx, agent.session, signal);
        if (!cut.current(agent.session))
            throw new Error("fold-context: checkpoint observation changed");
        const valid = validateSummaryRange(
            agent.session,
            this.state(agent.session).numbering,
            plan.range,
            cut,
        );
        if (!valid.valid)
            throw new Error(`fold-context: checkpoint range changed: ${valid.reason}`);
        signal.throwIfAborted();
        if (this.state(agent.session).activeStart !== null)
            throw new Error("fold-context: another compaction transaction is active");
        this.preparedSessionSummaries.set(agent.session, { plan, summary });
        try {
            const result = await super.compactRegion(
                SessionSeq(plan.range.seqs[0]!),
                SessionSeq(plan.range.seqs.at(-1)!),
                agent,
                signal,
            );
            await this.ctx.sessions.flush(agent.session);
            return result;
        } finally {
            this.preparedSessionSummaries.delete(agent.session);
        }
    }
    override compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) {
        return this.withPolicy(agent.session, () =>
            this.compactIfNeededWithPolicy(agent, trigger, signal),
        );
    }
    private async compactIfNeededWithPolicy(
        agent: Agent,
        trigger: CompactionTrigger,
        signal: AbortSignal,
    ) {
        const continued = await this.sessionSummaries.continue(agent, trigger, signal);
        if (continued.handled) return continued.result;
        signal.throwIfAborted();
        if (trigger === "context-overflow") {
            await this.releaseBatch(agent, signal, "overflow");
            return super.compactIfNeeded(agent, trigger, signal);
        }
        const requested = this.hasSummaryRequest(agent.session);
        const budget = await this.pressureBudget(agent, signal);
        if (budget !== null) this.windowBudgets.set(agent.session, budget);
        else this.windowBudgets.delete(agent.session);
        if (
            budget !== null &&
            this.measurement(agent.session).totalTokens +
                (this.observedGrowth(agent.session) ??
                    Math.max(1, Math.ceil(budget.threshold / 64))) >=
                budget.safety
        )
            return this.compactPressure(agent, signal, requested, budget);
        // Capture independent work BEFORE this batch. Its own replacements cannot
        // prove that the rebuild was already paid when reconsidering a summary.
        using cut = await observeSessionCut(this.ctx, agent.session, signal);
        if (!cut.current(agent.session)) return null;
        const opportunity = this.rebuildEvidence(agent.session, cut);
        const rebuildFrom =
            opportunity.rebuildStartSeq === null
                ? -1
                : agent.session.surface.nodes.indexOf(SessionSeq(opportunity.rebuildStartSeq));
        const targets =
            rebuildFrom < 0
                ? []
                : estimateInlineReleases(this.ctx, agent.session, this.state(agent.session), cut)
                      .replacements;
        const coveredRebuild =
            rebuildFrom >= 0 &&
            targets.length > 0 &&
            targets.every(
                (target) =>
                    agent.session.surface.nodes.indexOf(SessionSeq(target.seq)) >= rebuildFrom,
            );
        await this.releaseBatch(agent, signal, coveredRebuild ? "rebuild" : undefined);
        if (!requested && !this.autoEnabled) return null;
        // Release may have changed pressure. Skip auxiliary planning only when
        // fresh pressure and pending intent both rule out ordinary compaction.
        if (
            !requested &&
            budget !== null &&
            this.measurement(agent.session).totalTokens < budget.threshold &&
            !this.state(agent.session).entries.some((entry) => entry.status === "queued")
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
        // Covered marks settle with the summary; do not rewrite the prefix twice.
        return this.compactSelectedRange(
            SessionSeq(scheduled.selection.start),
            SessionSeq(scheduled.selection.end),
            agent,
            signal,
        );
    }
    private cacheEvidence(session: Session, cut: SessionCut): ReleaseCacheEvidence | null {
        const measurement = this.measurement(session);
        const usageSeq = measurement.usageSeq;
        if (usageSeq === null) return null;
        const event = cut.events.get(usageSeq);
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
    private rebuildEvidence(session: Session, cut: SessionCut) {
        const measured = this.measurement(session);
        const cache = this.cacheEvidence(session, cut);
        let independentRebuildTokens = 0;
        let changed = false;
        let rebuildStartSeq: number | null = null;
        // Price only the observed surface. The public observation owns the raw cut.
        if (
            cache !== null &&
            cache.routeSignature === cache.usageRouteSignature &&
            measured.usageSeq !== null
        ) {
            for (const node of measured.nodes) {
                const event = cut.events.get(node.seq);
                const preceding = cut.events.get(node.seq - 1);
                const ownRelease =
                    preceding?.type === "compaction/prune" && RELEASE_TARGET_KEY in preceding.data;
                const ownCleanup =
                    event?.type === "developer/message" &&
                    (event.data.message.source.kind === RELEASE_CLEANUP_SOURCE ||
                        event.data.message.source.kind === SESSION_SUMMARY_CLEANUP_SOURCE);
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
    private releasePlan(
        session: Session,
        cut: SessionCut,
        opportunity?: ReleaseOpportunity,
    ): ReleaseBatchPlan {
        const state = this.state(session);
        const estimate = estimateInlineReleases(this.ctx, session, state, cut);
        const measurement = this.measurement(session);
        const positions = new Map(
            measurement.nodes.map((node, index) => [Number(node.seq), index]),
        );
        const suffixes = new Array<number>(measurement.nodes.length);
        let suffix = 0;
        for (let index = measurement.nodes.length - 1; index >= 0; index--) {
            suffixes[index] = suffix;
            suffix += measurement.nodes[index]!.tokens;
        }
        return planReleaseBatch(
            {
                revision: estimate.revision,
                totalTokens: measurement.totalTokens,
                ...(this.windowBudgets.get(session)
                    ? {
                          targetTokens: this.windowBudgets.get(session)!.threshold,
                          safetyTokens: this.windowBudgets.get(session)!.safety,
                      }
                    : {}),
                candidates: estimate.replacements.flatMap((item) => {
                    const index = positions.get(item.seq);
                    if (index === undefined) return [];
                    const before = measurement.nodes[index]!.tokens;
                    return [
                        {
                            seq: item.seq,
                            savingTokens: Math.max(
                                0,
                                Math.min(before, item.beforeTokens - item.afterTokens),
                            ),
                            replacementTokens: Math.max(
                                0,
                                before + item.afterTokens - item.beforeTokens,
                            ),
                            suffixTokens: suffixes[index]!,
                        },
                    ];
                }),
                activeCompaction: state.activeStart !== null,
                ...(opportunity === undefined ? {} : { opportunity }),
                cache: this.cacheEvidence(session, cut),
                nowMs: Date.now(),
            },
            this.routeCosts(session),
        );
    }
    private routeCosts(session: Session): Readonly<SchedulingPolicy> {
        const route = session.requestHeader()?.config;
        const override = this.foldPolicy.modelPolicies.find(
            (item) => item.provider === route?.provider && item.model === route?.model,
        );
        return {
            ...this.schedulingPolicy,
            cacheReadRatio: override?.cacheReadRatio ?? this.foldPolicy.cacheReadRatio,
        };
    }
    private observedGrowth(session: Session): number | undefined {
        const effect = this.pressureState(session).effect;
        const route = session.requestHeader()?.config;
        if (
            !effect ||
            effect.route?.provider !== route?.provider ||
            effect.route?.model !== route?.model
        )
            return undefined;
        const steps = this.committedStepsAfter(this.state(session), effect.seq);
        const baseline = effect.observedPromptTokens ?? effect.afterTokens;
        if (steps < 2 || baseline === null) return undefined;
        const growth = this.measurement(session).totalTokens - baseline;
        return growth > 0 ? Math.max(1, Math.ceil(growth / steps)) : undefined;
    }
    private async releaseBatch(
        agent: Agent,
        signal: AbortSignal,
        opportunity?: ReleaseOpportunity,
    ) {
        signal.throwIfAborted();
        const session = agent.session;
        using cut = await observeSessionCut(this.ctx, session, signal);
        if (!cut.current(session)) return 0;
        const permit = this.releasePlan(session, cut, opportunity);
        const released = commitInlineReleases(
            this.ctx,
            session,
            this.state(session),
            signal,
            permit,
            cut,
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
        cut: SessionCut,
    ): boolean {
        const nodes = cut.surface;
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
            const event = cut.events.get(seq);
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
        const override = this.foldPolicy.modelPolicies.find(
            (item) => item.provider === provider && item.model === model,
        );
        const budget = planPressureBudget(window, {
            targetTokens: override?.targetTokens ?? this.foldPolicy.targetTokens,
            summaryMaxTokens: this.foldPolicy.summaryMaxTokens,
        });
        return budget === null ? null : { ...budget, retries: 1 };
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
    private protectedTailStart(session: Session, cut: SessionCut) {
        const nodes = cut.surface;
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
            const event = cut.events.get(seq);
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
        cut: SessionCut,
        protectedStart = this.protectedTailStart(session, cut),
    ) {
        const allowedCuts = new Set(cut.surface.slice(0, protectedStart + 1));
        const headSeq = measurement.nodes[0]?.seq;
        const headEvent = headSeq === undefined ? undefined : cut.events.get(headSeq);
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
        using initialCut = await observeSessionCut(this.ctx, agent.session, signal);
        if (!initialCut.current(agent.session)) return null;
        const opportunity = this.rebuildEvidence(agent.session, initialCut);
        let measured = this.measurement(agent.session);
        if ((await this.releaseBatch(agent, signal, "pressure")) > 0) {
            const refreshed = await this.pressureBudget(agent, signal);
            if (refreshed === null) return null;
            budget = refreshed;
        }
        measured = this.measurement(agent.session);
        const pruner = this.ctx.get("toolResultPruner");
        if (pruner !== undefined) {
            pruner.pruneSession(agent.session);
            measured = this.measurement(agent.session);
        }
        const safetyPressure = () =>
            measured.totalTokens +
                (this.observedGrowth(agent.session) ??
                    Math.max(1, Math.ceil(budget.threshold / 64))) >=
            budget.safety;
        if (!safetyPressure()) {
            if (measured.totalTokens < budget.threshold || (!requested && !this.autoEnabled))
                return null;
            const scheduled = await this.inspectSchedule(agent, signal, opportunity);
            signal.throwIfAborted();
            if (
                scheduled.decision !== "execute" ||
                scheduled.selection === null ||
                agent.session.seq !== scheduled.revision
            )
                return null;
            return this.compactSelectedRange(
                SessionSeq(scheduled.selection.start),
                SessionSeq(scheduled.selection.end),
                agent,
                signal,
            );
        }
        let result: Awaited<ReturnType<BasicCompactionEngine["compactRegion"]>> | null = null;
        let retain = this.retentionTokens(agent.session, budget.retain, budget.threshold);
        for (let attempt = 0; attempt <= budget.retries && safetyPressure(); attempt++) {
            signal.throwIfAborted();
            using cut = await observeSessionCut(this.ctx, agent.session, signal);
            if (!cut.current(agent.session)) return result;
            measured = this.measurement(agent.session);
            const range = this.pressureRange(agent.session, measured, retain, cut);
            if (range === null) return result;
            if (
                !(requested && result === null) &&
                !this.selectionHasBusinessEvidence(
                    agent.session,
                    SessionSeq(range.start),
                    SessionSeq(range.end),
                    cut,
                )
            )
                return result;
            const before = measured.totalTokens;
            result = await this.compactSelectedRange(
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
    schedulingStatus(agent: Agent, signal?: AbortSignal, limit = this.releasePolicy.catalogLimit) {
        return this.withPolicy(
            agent.session,
            () => this.schedulingStatusWithPolicy(agent, signal, limit),
            false,
        );
    }
    private async schedulingStatusWithPolicy(
        agent: Agent,
        signal?: AbortSignal,
        limit = this.releasePolicy.catalogLimit,
    ) {
        using cut = await observeSessionCut(this.ctx, agent.session, signal);
        if (!cut.current(agent.session))
            throw new Error("fold-context: scheduling observation changed");
        const pressure = this.pressureStatus(agent.session);
        const snapshot = await this.inspectScheduleCut(agent, cut, signal);
        if (snapshot.limits?.safetyTokens)
            this.windowBudgets.set(agent.session, {
                threshold: snapshot.limits.thresholdTokens,
                safety: snapshot.limits.safetyTokens,
            });
        const releaseBatch = this.releasePlan(agent.session, cut);
        const plan = snapshot.plan;
        const bound = Math.max(1, Math.min(128, limit));
        const effect = pressure.effect;
        const threshold = snapshot.thresholdTokens;
        return {
            policy: { ...this.routeCosts(agent.session) },
            window: {
                targetTokens: snapshot.thresholdTokens,
                safetyTokens: snapshot.limits?.safetyTokens ?? null,
                configuredTargetTokens: snapshot.limits?.configuredTargetTokens ?? null,
                targetClamped: snapshot.limits?.targetClamped ?? false,
            },
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
    releaseReminder(agent: Agent, signal?: AbortSignal) {
        return this.withPolicy(
            agent.session,
            () => this.releaseReminderWithPolicy(agent, signal),
            false,
        );
    }
    private async releaseReminderWithPolicy(agent: Agent, signal?: AbortSignal) {
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
        const suffixTokens = new Map<number, number>();
        let remaining = 0;
        for (const node of [...measurement.nodes].reverse()) {
            suffixTokens.set(Number(node.seq), remaining);
            remaining += node.tokens;
        }
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
                    suffixTokens: suffixTokens.get(entry.currentSeq!) ?? measurement.totalTokens,
                    seq: entry.currentSeq!,
                },
            ];
        });
        const plan = planReleaseReminder(
            {
                step: state.businessSteps,
                ...(threshold === null ? {} : { targetTokens: threshold }),
                cacheReadRatio: this.routeCosts(session).cacheReadRatio,
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
        const cooldown = 4;
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
        opportunity?: ReturnType<ContextCompressionEngine["rebuildEvidence"]>,
    ): Promise<SchedulingSnapshot> {
        using cut = await observeSessionCut(this.ctx, agent.session, signal);
        return await this.inspectScheduleCut(agent, cut, signal, opportunity);
    }
    private async inspectScheduleCut(
        agent: Agent,
        cut: SessionCut,
        signal?: AbortSignal,
        opportunity?: ReturnType<ContextCompressionEngine["rebuildEvidence"]>,
    ): Promise<SchedulingSnapshot> {
        signal?.throwIfAborted();
        const session = agent.session;
        const revision = cut.revision;
        let failure: SchedulingSnapshot["failure"] = null;
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
        if (!cut.current(session)) return wait("state_changed");
        const state = this.state(session);
        failure = this.latestFailure(session, state);
        opportunity ??= this.rebuildEvidence(session, cut);
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
        const headEvent = headSeq === undefined ? undefined : cut.events.get(headSeq);
        const head = headEvent === undefined ? null : session.deriveEventMessage(headEvent);
        const firstSystemSeq = head?.role === "system" ? headSeq : undefined;
        const retentionTokens = this.retentionTokens(session, retain, threshold);
        const protectedStart = this.protectedTailStart(session, cut);
        const selection = this.pressureRange(
            session,
            measurement,
            retentionTokens,
            cut,
            protectedStart,
        );
        const headerOverheadTokens = Math.max(
            0,
            measurement.totalTokens - measurement.surfaceTokens,
        );
        const systemHeadTokens = firstSystemSeq === undefined ? 0 : measurement.nodes[0]!.tokens;
        const protectedSeqs = new Set<number>(cut.surface.slice(protectedStart));
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
            safetyTokens: budget.safety,
            configuredTargetTokens: budget.configuredTarget,
            targetClamped: budget.targetClamped,
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
                cut,
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
            const event = cut.events.get(node.seq);
            const message = event === undefined ? null : session.deriveEventMessage(event);
            return message === null ? [] : [message];
        });
        const input = firstSystemSeq !== undefined && head !== null ? [head, ...region] : region;
        const candidates = summaryCandidates(this.policySnapshot.models, conversationRoute(agent));
        if (candidates.length === 0) return wait("no_matching_summary_model");
        const nativeAdmission =
            selection === null
                ? null
                : await this.sessionSummaries.estimate(
                      agent,
                      { start: selection.start, end: selection.end },
                      signal ?? new AbortController().signal,
                  );
        signal?.throwIfAborted();
        if (session.seq !== revision) return wait("state_changed");
        const target =
            nativeAdmission !== null
                ? candidates[0]!
                : candidates.find((item) => !item.onlyWhenSessionMatches);
        if (!target) return wait("session_summary_unavailable");
        const currentInputTokens = Math.max(measurement.totalTokens, measurement.surfaceTokens);
        const systemTokens =
            selection === null || firstSystemSeq === undefined
                ? 0
                : this.ctx.tokenMeter.estimateMessage(head!);
        let images: "native" | "references" = "native";
        let summaryInput: SummaryInputEstimate | null = null;
        if (nativeAdmission === null) {
            images = await this.summaryImages(
                input.filter((message) => !isSummaryControlNotice(message)),
                target,
                signal,
            );
            signal?.throwIfAborted();
            if (session.seq !== revision) return wait("state_changed");
            if (selection !== null) {
                const projected = this.summaryProjection(input, agent, revision, images).messages;
                const projectedTokens = projected.reduce(
                    (total, message) => total + this.ctx.tokenMeter.estimateMessage(message),
                    0,
                );
                // Include the preserved head, tools and official instruction framing.
                summaryInput = {
                    execution: "independent",
                    historyTokens: projectedTokens - systemTokens,
                    systemTokens,
                    toolsTokens: this.pressureState(session).toolsTokens,
                    framingTokens: 256,
                    totalTokens: projectedTokens + this.pressureState(session).toolsTokens + 256,
                };
            }
        }
        if (nativeAdmission !== null) {
            const toolsTokens = this.pressureState(session).toolsTokens;
            const framingTokens = Math.max(0, nativeAdmission.inputTokens - currentInputTokens);
            summaryInput = {
                execution: "session",
                historyTokens: Math.max(0, currentInputTokens - systemTokens - toolsTokens),
                systemTokens,
                toolsTokens,
                framingTokens,
                totalTokens: nativeAdmission.inputTokens,
            };
        }
        const cache = this.cacheEvidence(session, cut);
        let stablePrefixTokens = headerOverheadTokens;
        for (const node of measurement.nodes) {
            if (measurement.usageSeq === null || node.seq >= measurement.usageSeq) break;
            stablePrefixTokens += node.tokens;
        }
        const cachedSummaryTokens =
            nativeAdmission !== null &&
            !opportunity.cacheExpired &&
            cache !== null &&
            cache.routeSignature === cache.usageRouteSignature
                ? Math.min(cache.cacheReadTokens, stablePrefixTokens, currentInputTokens)
                : 0;
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
        const totalTokens = Math.max(measurement.totalTokens, measurement.surfaceTokens);
        const plan = planScheduledCompaction(
            {
                trigger: requested ? "model_request" : "backlog",
                totalTokens,
                postReleaseTokens: totalTokens,
                inlineReleaseTokens: 0,
                selectedTokens: selectedNodes.reduce((total, node) => total + node.tokens, 0),
                prefixTokens: firstSystemSeq === undefined ? 0 : measurement.nodes[0]!.tokens,
                filterInputTokens,
                stepsSinceSummary: this.committedStepsAfter(state, state.lastSummary?.seq ?? 0),
                markedIds: excluded
                    .filter((entry) => entry.status === "queued")
                    .map((entry) => entry.id),
                routeSignature: JSON.stringify({
                    request: {
                        provider: routed.provider,
                        model: routed.model,
                        maxTokens: routed.maxTokens ?? null,
                    },
                    summaryModels: candidates,
                    images,
                }),
                cacheState,
                independentRebuildTokens: opportunity.independentRebuildTokens,
                cacheExpired: opportunity.cacheExpired,
                headerOverheadTokens,
                auto: this.autoEnabled,
                targetTokens: threshold,
                safetyTokens: budget.safety,
                growthTokens: this.observedGrowth(session),
                summaryMaxTokens: nativeAdmission?.maxTokens ?? this.foldPolicy.summaryMaxTokens,
                summaryCacheShare: cachedSummaryTokens / Math.max(1, filterInputTokens),
            },
            this.routeCosts(session),
        );
        const cooling =
            plan.reason !== "safety_pressure" && failure !== null && failure.retryAfterSteps > 0;
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
    private async summaryImages(
        messages: readonly Message[],
        target: SummaryModel,
        signal?: AbortSignal,
    ) {
        if (
            this.summaryPolicy.images !== "auto" ||
            !messages.some((message) => message.content.some((block) => block.type === "image"))
        )
            return "references" as const;
        try {
            const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
            return info.inputModalities?.includes("image")
                ? ("native" as const)
                : ("references" as const);
        } catch (error) {
            signal?.throwIfAborted();
            if (!isSummaryModelFailure(error)) throw error;
            // Capability lookup failure must not prevent later candidates from being attempted.
            return "references" as const;
        }
    }
    private summaryProjection(
        input: readonly Message[],
        agent: Agent,
        cutoff: number,
        images: "native" | "references",
    ) {
        const state = this.state(agent.session);
        const policy = { reasoning: this.summaryPolicy.reasoning, images };
        return { messages: projectSummaryInput(state, input, cutoff, policy), policy };
    }
    protected override async summarize(
        input: SummaryInput,
        agent: Agent,
        signal?: AbortSignal,
    ): Promise<SummaryResult> {
        const state = this.state(agent.session);
        if (state.activeStart === null || state.activeCompactionId === null)
            throw new Error(
                "fold-context: summarization requires an official compaction transaction",
            );
        const prepared = this.preparedSessionSummaries.get(agent.session);
        if (prepared) {
            using cut = await observeSessionCut(this.ctx, agent.session, signal);
            if (
                !cut.current(agent.session) ||
                this.state(agent.session).activeCompactionId !== state.activeCompactionId
            )
                throw new Error("fold-context: prepared summary observation changed");
            const valid = validateSummaryRange(
                agent.session,
                this.state(agent.session).numbering,
                prepared.plan.range,
                cut,
            );
            if (!valid.valid)
                throw new Error(`fold-context: prepared summary range changed: ${valid.reason}`);
            const expected = prepared.plan.range.nodes.flatMap((node) =>
                node.messageId === null ? [] : [node.messageId],
            );
            const first = input.messages[0];
            const actual = input.messages
                .slice(first?.role === "system" && !expected.includes(first.id) ? 1 : 0)
                .map((message) => message.id);
            if (
                actual.length !== expected.length ||
                actual.some((id, index) => id !== expected[index])
            )
                throw new Error(
                    "fold-context: official summary selection differs from the prepared range",
                );
        }
        if (prepared && prepared.summary !== null) {
            return {
                provider: prepared.plan.provider,
                model: prepared.plan.model,
                maxTokens: prepared.plan.maxTokens,
                summary: [
                    {
                        type: "text",
                        text: sessionSummaryStamp(
                            state.activeCompactionId,
                            prepared.plan.checkpointId,
                        ),
                    },
                    { type: "text", text: prepared.summary },
                ],
            };
        }
        const current = conversationRoute(agent);
        const candidates = summaryCandidates(this.policySnapshot.models, current);
        const cap = this.foldPolicy.summaryMaxTokens;
        const failures: Error[] = [];
        for (const target of candidates) {
            signal?.throwIfAborted();
            if (target.onlyWhenSessionMatches) {
                failures.push(
                    new Error(
                        `${target.provider}/${target.model}: session-only summary unavailable; independent fallback is disabled`,
                    ),
                );
                continue;
            }
            try {
                const images = await this.summaryImages(
                    input.messages.filter((message) => !isSummaryControlNotice(message)),
                    target,
                    signal,
                );
                const projected = this.summaryProjection(
                    input.messages,
                    agent,
                    state.activeStart,
                    images,
                );
                const result = await requestSummary(
                    this.ctx,
                    { ...input, messages: projected.messages },
                    agent,
                    target,
                    cap,
                    signal,
                );
                signal?.throwIfAborted();
                return {
                    ...result,
                    summary: [
                        {
                            type: "text",
                            text: projectionStamp(
                                projected.policy,
                                state.activeCompactionId,
                                images,
                                prepared?.plan.checkpointId,
                            ),
                        },
                        ...result.summary,
                    ],
                };
            } catch (error) {
                signal?.throwIfAborted();
                if (!isSummaryModelFailure(error)) throw error;
                failures.push(
                    new Error(
                        `${target.provider}/${target.model}${target.reasoningEffort ? ` (${target.reasoningEffort})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
                        { cause: error },
                    ),
                );
            }
        }
        throw new AggregateError(
            failures,
            candidates.length === 0
                ? "fold-context: no summary model matches this session; configured session-only models were skipped"
                : `fold-context: all summary models failed: ${failures.map((error) => error.message).join("; ")}`,
        );
    }
}
