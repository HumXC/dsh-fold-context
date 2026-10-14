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
    constructor(
        ctx: Context,
        compaction: BasicCompactionConfig,
        releasePolicy: Readonly<ReleasePolicy>,
        summaryPolicy: Readonly<SummaryPolicy> = resolveSummaryPolicy(),
        scheduling: Partial<SchedulingPolicy> = {},
    ) {
        if (ctx.get("toolResultPruner") !== undefined)
            throw new Error(
                "fold-context: remove toolResultPruner in the same compaction scope before mounting",
            );
        ctx.sessionProjections.register(ledgerProjection);
        // The base owns overflow retry handling, including when ordinary automation is disabled.
        super(ctx, { ...compaction, auto: true });
        this.autoEnabled = compaction.auto ?? true;
        this.releasePolicy = releasePolicy;
        this.summaryPolicy = summaryPolicy;
        this.schedulingPolicy = resolveSchedulingPolicy(scheduling);
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
        if (trigger === "context-overflow") return super.compactIfNeeded(agent, trigger, signal);
        const requested = this.hasSummaryRequest(agent.session);
        if (!this.schedulingPolicy.enabled && requested)
            return super.compactIfNeeded(agent, "context-overflow", signal);
        if (this.autoEnabled) {
            // Official pressure must run before, and independently of, economic/cooldown gates.
            const result = await super.compactIfNeeded(agent, "pressure", signal);
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
    async schedulingStatus(
        agent: Agent,
        signal?: AbortSignal,
        limit = this.releasePolicy.catalogLimit,
    ) {
        const snapshot = await this.inspectSchedule(agent, signal);
        const plan = snapshot.plan;
        const bound = Math.max(1, Math.min(128, limit));
        return {
            policy: { ...this.schedulingPolicy },
            auto: this.autoEnabled,
            revision: snapshot.revision,
            decision: snapshot.decision,
            reason: snapshot.reason,
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
            estimates:
                "HEURISTIC token costs; latest cache usage is evidence, not a hit or TTL guarantee",
        };
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
        const info = await this.ctx.llm.resolveModelInfo(routed.provider, routed.model, signal);
        signal?.throwIfAborted();
        if (session.seq !== revision) return wait("state_changed");
        const override = this.config.modelPolicies.find(
            (policy) => policy.provider === routed.provider && policy.model === routed.model,
        );
        const window = info.context?.contextWindow;
        const reserved = routed.maxTokens ?? info.defaultMaxTokens ?? 0;
        const thresholdRatio = override?.thresholdRatio ?? this.config.thresholdRatio;
        const headroom = override?.headroomTokens ?? this.config.headroomTokens;
        if (
            !Number.isSafeInteger(window) ||
            window === undefined ||
            window <= 0 ||
            !Number.isSafeInteger(reserved) ||
            reserved < 0 ||
            window - reserved - headroom <= 0
        )
            return wait("invalid_capacity");
        const threshold = Math.floor(
            Math.min(window * thresholdRatio, window - reserved - headroom),
        );
        const retain =
            override?.retainTokens ??
            (override?.retainRatio !== undefined
                ? Math.floor((window - reserved) * override.retainRatio)
                : (this.config.retainTokens ??
                  Math.floor((window - reserved) * this.config.retainRatio!)));
        if (retain >= threshold) return wait("invalid_retention");
        const measurement = this.ctx.tokenMeter.measure(session);
        const headSeq = measurement.nodes[0]?.seq;
        const headEvent = headSeq === undefined ? undefined : session.eventAt(headSeq);
        const head = headEvent === undefined ? null : session.deriveEventMessage(headEvent);
        const firstSystemSeq = head?.role === "system" ? headSeq : undefined;
        const selection = selectScheduledRange({
            nodes: measurement.nodes,
            retainTokens: retain,
            ...(firstSystemSeq === undefined ? {} : { firstSystemSeq }),
            legalCutPredicate: (seq) => toolPairingBalancedBefore(session, SessionSeq(seq)),
        });
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
            const event = session.eventAt(node.seq);
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
        const headerOverheadTokens = Math.max(
            0,
            measurement.totalTokens - measurement.surfaceTokens,
        );
        // Include the preserved system head and request envelope in the auxiliary call estimate.
        // The fixed allowance covers the official instruction and checkpoint framing.
        const filterInputTokens =
            selection === null
                ? 0
                : projected.reduce(
                      (total, message) => total + this.ctx.tokenMeter.estimateMessage(message),
                      0,
                  ) +
                  headerOverheadTokens +
                  256;
        const usage =
            measurement.baseline.kind === "usage" ? measurement.baseline.usage : undefined;
        const cacheState =
            usage?.cacheReadTokens === undefined
                ? "unknown"
                : usage.cacheReadTokens === 0
                  ? "uncached"
                  : "cached";
        const requested = this.hasSummaryRequest(session);
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
