import { z } from "zod";

const tokenCountSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = tokenCountSchema.positive();
const ratioSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Costs are HEURISTIC normalized uncached-token units, never provider prices. */
export const schedulingPolicySchema = z
    .object({
        enabled: z.boolean().default(true),
        proactive: z.boolean().default(true),
        minIntervalSteps: tokenCountSchema.default(8),
        minSavingsTokens: tokenCountSchema.default(2048),
        minSavingsRatio: ratioSchema.max(1).default(0.2),
        expectedSummaryRatio: ratioSchema.default(0.2),
        paybackTurns: positiveCountSchema.default(24),
        cacheReadRatio: ratioSchema.max(1).default(0.1),
        summaryInputRatio: ratioSchema.default(1),
        summaryOutputRatio: ratioSchema.default(1),
        releaseMinTokens: tokenCountSchema.default(2048),
        releaseMaxWaitSteps: positiveCountSchema.default(16),
        releaseBacklogRatio: ratioSchema.positive().max(1).default(0.15),
        /** Zero disables time-based cache expiry assumptions. */
        cacheTtlMs: tokenCountSchema.default(300_000),
    })
    .strict();

export type SchedulingPolicy = z.infer<typeof schedulingPolicySchema>;

export function resolveSchedulingPolicy(
    value: Partial<SchedulingPolicy> = {},
): Readonly<SchedulingPolicy> {
    return Object.freeze(schedulingPolicySchema.parse(value));
}

export interface ScheduledSurfaceNode {
    readonly seq: number;
    readonly tokens: number;
}

export interface ScheduledRangeInput {
    readonly nodes: readonly ScheduledSurfaceNode[];
    readonly retainTokens: number;
    /** Supply only when the first surface node is a system message. */
    readonly firstSystemSeq?: number;
    /** Each seq names the first RETAINED node, not the last selected node. */
    readonly legalCuts?: ReadonlySet<number>;
    readonly legalCutPredicate?: (firstRetainedSeq: number) => boolean;
}

export interface ScheduledRange {
    readonly start: number;
    readonly end: number;
}

function checkCount(value: number, name: string, positive = false): void {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
        throw new RangeError(
            `fold-context scheduling: ${name} must be a ${positive ? "positive" : "nonnegative"} safe integer`,
        );
    }
}

function checkEstimate(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
            `fold-context scheduling: ${name} exceeds the finite safe estimate range`,
        );
    }
    return value;
}

/**
 * Pure positional parity with the official tail-retention selector. The caller
 * supplies authoritative tool-pair legality; without it selection fails closed.
 * If both legal-cut forms are supplied, both must accept the boundary. A supplied
 * system head that is absent or no longer first also fails closed. This only
 * proposes a range: the official transaction must validate and compact it.
 */
export function selectScheduledRange(input: ScheduledRangeInput): ScheduledRange | null {
    checkCount(input.retainTokens, "retainTokens");
    if (input.firstSystemSeq !== undefined) checkCount(input.firstSystemSeq, "firstSystemSeq");
    const seen = new Set<number>();
    let surfaceTokens = 0;
    for (const node of input.nodes) {
        checkCount(node.seq, "node.seq");
        checkCount(node.tokens, "node.tokens");
        if (seen.has(node.seq))
            throw new RangeError("fold-context scheduling: duplicate surface seq");
        seen.add(node.seq);
        surfaceTokens = checkEstimate(surfaceTokens + node.tokens, "surfaceTokens");
    }
    if (input.legalCuts !== undefined) {
        for (const seq of input.legalCuts) checkCount(seq, "legalCuts seq");
    }
    const head = input.nodes[0];
    if (head === undefined) return null;
    if (input.firstSystemSeq !== undefined && input.firstSystemSeq !== head.seq) return null;
    if (input.legalCuts === undefined && input.legalCutPredicate === undefined) return null;
    const firstIndex = input.firstSystemSeq === undefined ? 0 : 1;
    let retainedTokens = 0;
    let keepFromIndex = input.nodes.length;
    for (let index = input.nodes.length - 1; index >= 0; index--) {
        const node = input.nodes[index];
        if (node === undefined) return null;
        retainedTokens += node.tokens;
        keepFromIndex = index;
        if (retainedTokens >= input.retainTokens) break;
    }
    while (keepFromIndex > firstIndex) {
        const retained = input.nodes[keepFromIndex];
        if (retained === undefined) return null;
        const legal =
            (input.legalCuts === undefined || input.legalCuts.has(retained.seq)) &&
            (input.legalCutPredicate === undefined || input.legalCutPredicate(retained.seq));
        if (legal) break;
        keepFromIndex--;
    }
    if (keepFromIndex <= firstIndex) return null;
    const first = input.nodes[firstIndex];
    const last = input.nodes[keepFromIndex - 1];
    if (first === undefined || last === undefined) return null;
    return { start: first.seq, end: last.seq };
}

export type ScheduledTrigger = "backlog" | "model_request";
export type SchedulingSafetyReason = "pressure" | "overflow";
export type SchedulingCacheState = "unknown" | "cached" | "uncached";
export type SchedulingReason =
    | "disabled"
    | "no_selection"
    | "no_marks"
    | "min_interval"
    | "min_savings"
    | "min_ratio"
    | "not_paid_back"
    | "eligible"
    | "safety_pressure"
    | "safety_overflow";

export interface ScheduledCompactionInput {
    readonly trigger: ScheduledTrigger;
    /** Current measured prompt tokens, including the preserved head. */
    readonly totalTokens: number;
    /** Whole selected span, including unmarked history. */
    readonly selectedTokens: number;
    /** Fixed head tokens preserved outside the selected span. */
    readonly prefixTokens: number;
    readonly excludedTokens?: number;
    /** Estimate after all summary-input filters; overrides selected minus excluded. */
    readonly filterInputTokens?: number;
    /** Selected content removable inline; never credit it as summary savings. */
    readonly inlineReleaseTokens?: number;
    /** Actual prompt estimate after the pending inline batch, for the ratio gate. */
    readonly postReleaseTokens?: number;
    readonly stepsSinceSummary: number;
    /** Marks covered by the candidate selection, not unrelated queued marks. */
    readonly markedIds: readonly string[];
    readonly routeSignature?: string | null;
    readonly cacheState?: SchedulingCacheState;
    readonly effectiveCacheReadRatio?: number;
    /** Credit only a rebuild required independently before this batch was planned. */
    readonly independentRebuildTokens?: number;
    readonly cacheExpired?: boolean;
    readonly headerOverheadTokens?: number;
    readonly auto?: boolean;
    /** Caller-authorized safety path, never inferred from economic estimates. */
    readonly forceSafety?: SchedulingSafetyReason;
}

const compactionInputSchema = z
    .object({
        trigger: z.enum(["backlog", "model_request"]),
        totalTokens: tokenCountSchema,
        selectedTokens: tokenCountSchema,
        prefixTokens: tokenCountSchema,
        excludedTokens: tokenCountSchema.optional(),
        filterInputTokens: tokenCountSchema.optional(),
        inlineReleaseTokens: tokenCountSchema.default(0),
        postReleaseTokens: tokenCountSchema.optional(),
        stepsSinceSummary: tokenCountSchema,
        markedIds: z.array(z.string().min(1)),
        routeSignature: z.string().nullable().default(null),
        cacheState: z.enum(["unknown", "cached", "uncached"]).default("unknown"),
        effectiveCacheReadRatio: ratioSchema.max(1).optional(),
        independentRebuildTokens: tokenCountSchema.default(0),
        cacheExpired: z.boolean().default(false),
        headerOverheadTokens: tokenCountSchema.default(0),
        auto: z.boolean().default(true),
        forceSafety: z.enum(["pressure", "overflow"]).optional(),
    })
    .strict()
    .superRefine((input, context) => {
        if (
            input.prefixTokens > input.totalTokens ||
            input.selectedTokens >
                input.totalTokens - input.prefixTokens - input.headerOverheadTokens
        ) {
            context.addIssue({
                code: "custom",
                message: "selected span, preserved head and header overhead exceed totalTokens",
            });
        }
        if (input.excludedTokens !== undefined && input.excludedTokens > input.selectedTokens) {
            context.addIssue({ code: "custom", message: "excludedTokens exceed selectedTokens" });
        }
        if (input.inlineReleaseTokens > input.selectedTokens) {
            context.addIssue({
                code: "custom",
                message: "inlineReleaseTokens exceed selectedTokens",
            });
        }
    });

export interface ScheduledCompactionPlan {
    readonly heuristic: "HEURISTIC";
    readonly decision: "execute" | "wait";
    readonly reason: SchedulingReason;
    readonly trigger: ScheduledTrigger;
    readonly forceSafety: SchedulingSafetyReason | null;
    readonly routeSignature: string | null;
    readonly markedIds: readonly string[];
    readonly cacheState: SchedulingCacheState;
    readonly cachedPrefixAssumed: boolean;
    readonly effectiveCacheReadRatio: number;
    readonly totalTokens: number;
    readonly selectedTokens: number;
    readonly prefixTokens: number;
    readonly excludedTokens: number | null;
    readonly filterInputTokens: number;
    readonly inlineReleaseTokens: number;
    readonly postReleaseTokens: number;
    readonly stepsSinceSummary: number;
    readonly predictedSummaryTokens: number;
    readonly netSavingTokens: number;
    /** Fraction of the current total prompt saved by replacing the whole span. */
    readonly savingsRatio: number;
    readonly retainedSurfaceTokens: number;
    readonly headerOverheadTokens: number;
    readonly rebuiltSuffixTokens: number;
    readonly independentRebuildTokens: number;
    readonly cacheExpired: boolean;
    readonly initialRebuildPenalty: number;
    readonly summaryCost: number;
    readonly perTurnSaving: number;
    /** Null means no positive savings or no representable finite payback. */
    readonly breakEvenTurns: number | null;
}

/**
 * Deterministic gate for low-pressure requests and marked backlog. A historical
 * cache miss describes one call, never future billing. Only independently
 * required rebuild work or evidenced TTL expiry reduces the rebuild penalty;
 * the auxiliary summary call is always charged exactly once.
 */
export function planScheduledCompaction(
    value: ScheduledCompactionInput,
    config: Partial<SchedulingPolicy> = {},
): ScheduledCompactionPlan {
    const policy = resolveSchedulingPolicy(config);
    const input = compactionInputSchema.parse(value);
    const filterInputTokens =
        input.filterInputTokens ?? input.selectedTokens - (input.excludedTokens ?? 0);
    const predictedSummaryTokens = checkEstimate(
        Math.ceil(
            checkEstimate(filterInputTokens * policy.expectedSummaryRatio, "summary prediction"),
        ),
        "predictedSummaryTokens",
    );
    const netSavingTokens = Math.max(
        0,
        input.selectedTokens - predictedSummaryTokens - input.inlineReleaseTokens,
    );
    const retainedSurfaceTokens =
        input.totalTokens - input.prefixTokens - input.selectedTokens - input.headerOverheadTokens;
    const rebuiltSuffixTokens = checkEstimate(
        predictedSummaryTokens + retainedSurfaceTokens + input.headerOverheadTokens,
        "rebuiltSuffixTokens",
    );
    const cachedPrefixAssumed = !input.cacheExpired;
    const effectiveCacheReadRatio = input.effectiveCacheReadRatio ?? policy.cacheReadRatio;
    const initialRebuildPenalty = checkEstimate(
        Math.max(0, rebuiltSuffixTokens - input.independentRebuildTokens) *
            (input.cacheExpired ? 0 : 1 - effectiveCacheReadRatio),
        "initialRebuildPenalty",
    );
    const summaryCost = checkEstimate(
        filterInputTokens * policy.summaryInputRatio +
            predictedSummaryTokens * policy.summaryOutputRatio,
        "summaryCost",
    );
    const perTurnSaving = checkEstimate(netSavingTokens * effectiveCacheReadRatio, "perTurnSaving");
    const upfrontCost = checkEstimate(initialRebuildPenalty + summaryCost, "upfrontCost");
    const payback = perTurnSaving > 0 ? Math.ceil(upfrontCost / perTurnSaving) : null;
    const breakEvenTurns = payback !== null && Number.isSafeInteger(payback) ? payback : null;
    const postReleaseTokens = input.postReleaseTokens ?? input.totalTokens;
    const savingsRatio = postReleaseTokens > 0 ? netSavingTokens / postReleaseTokens : 0;
    const markedIds = [...new Set(input.markedIds)];
    let reason: SchedulingReason;
    let decision: ScheduledCompactionPlan["decision"] = "wait";
    if (input.selectedTokens === 0) {
        reason = "no_selection";
    } else if (
        input.forceSafety !== undefined &&
        (input.forceSafety !== "pressure" || input.auto)
    ) {
        reason = `safety_${input.forceSafety}`;
        decision = "execute";
    } else if (input.forceSafety === "pressure") {
        reason = "disabled";
    } else if (
        !policy.enabled ||
        (input.trigger === "backlog" && (!input.auto || !policy.proactive))
    ) {
        reason = "disabled";
    } else if (input.trigger === "backlog" && markedIds.length === 0) {
        reason = "no_marks";
    } else if (input.stepsSinceSummary < policy.minIntervalSteps) {
        reason = "min_interval";
    } else if (netSavingTokens === 0 || netSavingTokens < policy.minSavingsTokens) {
        reason = "min_savings";
    } else if (savingsRatio < policy.minSavingsRatio) {
        reason = "min_ratio";
    } else if (breakEvenTurns === null || breakEvenTurns > policy.paybackTurns) {
        reason = "not_paid_back";
    } else {
        reason = "eligible";
        decision = "execute";
    }
    return {
        heuristic: "HEURISTIC",
        decision,
        reason,
        trigger: input.trigger,
        forceSafety: input.forceSafety ?? null,
        routeSignature: input.routeSignature,
        markedIds,
        cacheState: input.cacheState,
        cachedPrefixAssumed,
        effectiveCacheReadRatio,
        totalTokens: input.totalTokens,
        selectedTokens: input.selectedTokens,
        prefixTokens: input.prefixTokens,
        excludedTokens: input.excludedTokens ?? null,
        filterInputTokens,
        inlineReleaseTokens: input.inlineReleaseTokens,
        postReleaseTokens,
        stepsSinceSummary: input.stepsSinceSummary,
        predictedSummaryTokens,
        netSavingTokens,
        savingsRatio,
        retainedSurfaceTokens,
        headerOverheadTokens: input.headerOverheadTokens,
        rebuiltSuffixTokens,
        independentRebuildTokens: input.independentRebuildTokens,
        cacheExpired: input.cacheExpired,
        initialRebuildPenalty,
        summaryCost,
        perTurnSaving,
        breakEvenTurns,
    };
}

export interface ReleaseCacheEvidence {
    readonly routeSignature: string;
    readonly usageRouteSignature: string;
    readonly usageAtMs: number;
    readonly cacheReadTokens: number;
}

/** TTL is an explicit heuristic, anchored to a same-route cache HIT, never a miss. */
export function cacheExpiryEvidence(
    evidence: ReleaseCacheEvidence | null | undefined,
    nowMs: number,
    ttlMs: number,
): boolean {
    checkCount(ttlMs, "cacheTtlMs");
    return (
        ttlMs > 0 &&
        evidence != null &&
        evidence.routeSignature.length > 0 &&
        evidence.routeSignature === evidence.usageRouteSignature &&
        Number.isFinite(evidence.usageAtMs) &&
        evidence.usageAtMs >= 0 &&
        Number.isFinite(nowMs) &&
        nowMs >= evidence.usageAtMs &&
        Number.isFinite(evidence.cacheReadTokens) &&
        evidence.cacheReadTokens > 0 &&
        nowMs - evidence.usageAtMs >= ttlMs
    );
}

export type ReleaseOpportunity = SchedulingSafetyReason | "summary" | "rebuild";
export type ReleaseBatchReason =
    | "no_releases"
    | "active_compaction"
    | "hot_cache"
    | "min_release"
    | "cache_expired"
    | "max_wait"
    | "backlog_watermark"
    | `opportunity_${ReleaseOpportunity}`;
export interface ReleaseBatchInput {
    readonly revision: number;
    readonly totalTokens: number;
    /** Net savings of complete native replacements; price overlapping owners once. */
    readonly releaseTokens: number;
    readonly releaseCount: number;
    readonly oldestWaitSteps: number;
    readonly activeCompaction?: boolean;
    readonly opportunity?: ReleaseOpportunity;
    readonly cache?: ReleaseCacheEvidence | null;
    readonly nowMs: number;
}
export interface ReleaseBatchPlan {
    readonly revision: number;
    readonly decision: "execute" | "wait";
    readonly reason: ReleaseBatchReason;
    readonly cacheExpired: boolean;
    readonly releaseTokens: number;
    readonly releaseCount: number;
    readonly oldestWaitSteps: number;
}

/** Marks alone never create a paid rebuild; this planner cannot mutate a session. */
export function planReleaseBatch(
    input: ReleaseBatchInput,
    config: Partial<SchedulingPolicy> = {},
): ReleaseBatchPlan {
    const policy = resolveSchedulingPolicy(config);
    for (const key of [
        "revision",
        "totalTokens",
        "releaseTokens",
        "releaseCount",
        "oldestWaitSteps",
    ] as const)
        checkCount(input[key], key);
    const cacheExpired = cacheExpiryEvidence(input.cache, input.nowMs, policy.cacheTtlMs);
    let reason: ReleaseBatchReason;
    let decision: ReleaseBatchPlan["decision"] = "wait";
    if (input.activeCompaction) reason = "active_compaction";
    else if (input.releaseCount === 0) reason = "no_releases";
    else if (input.opportunity !== undefined) {
        reason = `opportunity_${input.opportunity}`;
        decision = "execute";
    } else if (input.releaseTokens === 0) reason = "min_release";
    else if (input.oldestWaitSteps >= policy.releaseMaxWaitSteps) {
        reason = "max_wait";
        decision = "execute";
    } else if (input.releaseTokens < policy.releaseMinTokens) reason = "min_release";
    else if (
        input.totalTokens > 0 &&
        input.releaseTokens / input.totalTokens >= policy.releaseBacklogRatio
    ) {
        reason = "backlog_watermark";
        decision = "execute";
    } else if (cacheExpired) {
        reason = "cache_expired";
        decision = "execute";
    } else reason = "hot_cache";
    return {
        revision: input.revision,
        decision,
        reason,
        cacheExpired,
        releaseTokens: input.releaseTokens,
        releaseCount: input.releaseCount,
        oldestWaitSteps: input.oldestWaitSteps,
    };
}
