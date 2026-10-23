import { z } from "zod";

const tokenCountSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ratioSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Relative costs only. Timing, batching and prediction are internal policy. */
export const schedulingPolicySchema = z
    .object({
        cacheReadRatio: ratioSchema.max(1).default(0.1),
        summaryInputRatio: ratioSchema.default(1),
        summaryOutputRatio: ratioSchema.default(1),
        cacheTtlMs: tokenCountSchema.default(0),
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

export interface ScheduledCompactionInput {
    readonly trigger: ScheduledTrigger;
    readonly totalTokens: number;
    readonly selectedTokens: number;
    readonly prefixTokens: number;
    readonly filterInputTokens?: number;
    readonly excludedTokens?: number;
    readonly inlineReleaseTokens?: number;
    readonly postReleaseTokens?: number;
    readonly stepsSinceSummary: number;
    readonly markedIds: readonly string[];
    readonly routeSignature?: string | null;
    readonly cacheState?: SchedulingCacheState;
    readonly independentRebuildTokens?: number;
    readonly cacheExpired?: boolean;
    readonly headerOverheadTokens?: number;
    readonly auto?: boolean;
    readonly forceSafety?: SchedulingSafetyReason;
    readonly targetTokens: number;
    readonly safetyTokens: number;
    /** Observed business growth per primary request, not a configurable request horizon. */
    readonly growthTokens?: number | undefined;
    readonly summaryRatio?: number;
    readonly summaryMaxTokens?: number;
    /** Cache share of summary INPUT only; independent summary calls default to uncached. */
    readonly summaryCacheShare?: number;
}
const compactionInputSchema = z
    .object({
        trigger: z.enum(["backlog", "model_request"]),
        totalTokens: tokenCountSchema,
        selectedTokens: tokenCountSchema,
        prefixTokens: tokenCountSchema,
        filterInputTokens: tokenCountSchema.optional(),
        excludedTokens: tokenCountSchema.optional(),
        inlineReleaseTokens: tokenCountSchema.default(0),
        postReleaseTokens: tokenCountSchema.optional(),
        stepsSinceSummary: tokenCountSchema,
        markedIds: z.array(z.string()),
        routeSignature: z.string().nullable().default(null),
        cacheState: z.enum(["unknown", "cached", "uncached"]).default("unknown"),
        independentRebuildTokens: tokenCountSchema.default(0),
        cacheExpired: z.boolean().default(false),
        headerOverheadTokens: tokenCountSchema.default(0),
        auto: z.boolean().default(true),
        forceSafety: z.enum(["pressure", "overflow"]).optional(),
        targetTokens: tokenCountSchema.positive(),
        safetyTokens: tokenCountSchema.positive(),
        growthTokens: tokenCountSchema.positive().optional(),
        summaryRatio: z.number().min(0).max(1).default(0.2),
        summaryCacheShare: z.number().min(0).max(1).default(0),
        summaryMaxTokens: tokenCountSchema.positive().default(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (input.targetTokens >= input.safetyTokens)
            ctx.addIssue({ code: "custom", message: "target must be below safety boundary" });
        if (
            input.prefixTokens + input.headerOverheadTokens + input.selectedTokens >
            input.totalTokens
        )
            ctx.addIssue({
                code: "custom",
                message: "selected span and fixed input exceed totalTokens",
            });
        if (
            (input.excludedTokens ?? 0) > input.selectedTokens ||
            input.inlineReleaseTokens > input.selectedTokens
        )
            ctx.addIssue({ code: "custom", message: "excluded content exceeds selected span" });
    });

/** Compare renewable cycles in equal units: cost per newly accumulated business token.
 * A cycle reads an approximately linearly growing prompt, then replaces history.
 * This is a bounded forecast, not an assertion of provider billing or task duration.
 * Pressure bounds how long the economic optimum may be deferred.
 */
export function planScheduledCompaction(
    value: ScheduledCompactionInput,
    config: Partial<SchedulingPolicy> = {},
) {
    const policy = resolveSchedulingPolicy(config);
    const input = compactionInputSchema.parse(value);
    const r = policy.cacheReadRatio;
    const growthTokens = input.growthTokens ?? Math.max(1, Math.ceil(input.targetTokens / 64));
    const ratio = input.summaryRatio;
    const filterInputTokens =
        input.filterInputTokens ?? input.selectedTokens - (input.excludedTokens ?? 0);
    const predictedSummaryTokens = Math.min(
        input.summaryMaxTokens,
        Math.ceil(filterInputTokens * ratio),
    );
    const netSavingTokens = Math.max(
        0,
        input.selectedTokens - input.inlineReleaseTokens - predictedSummaryTokens,
    );
    const postReleaseTokens = input.postReleaseTokens ?? input.totalTokens;
    const retainedSurfaceTokens =
        input.totalTokens - input.prefixTokens - input.headerOverheadTokens - input.selectedTokens;
    // Request envelope and stable system head precede the changed historical span.
    const rebuiltSuffixTokens = predictedSummaryTokens + retainedSurfaceTokens;
    const initialRebuildPenalty =
        Math.max(0, rebuiltSuffixTokens - input.independentRebuildTokens) *
        (input.cacheExpired ? 0 : 1 - r);
    const inputWeight = policy.summaryInputRatio * (1 - input.summaryCacheShare * (1 - r));
    const summaryCost =
        filterInputTokens * inputWeight + predictedSummaryTokens * policy.summaryOutputRatio;
    const predictedAfterTokens = Math.max(0, postReleaseTokens - netSavingTokens);
    const urgency = Math.max(
        0,
        Math.min(
            1,
            (postReleaseTokens - input.targetTokens) / (input.safetyTokens - input.targetTokens),
        ),
    );
    // Cheap cache permits more of the soft-to-safe band, but never the next-request reserve.
    const latestStartTokens = Math.max(
        input.targetTokens,
        Math.min(
            input.safetyTokens - growthTokens,
            input.targetTokens + (input.safetyTokens - input.targetTokens) * (1 - r),
        ),
    );
    const cycleCost = (additional: number) => {
        const extraSummary = Math.max(
            0,
            Math.min(
                input.summaryMaxTokens - predictedSummaryTokens,
                Math.ceil(additional * ratio),
            ),
        );
        const before = postReleaseTokens + additional;
        const after = predictedAfterTokens + extraSummary;
        const work = before - after;
        if (work <= 0) return Number.MAX_SAFE_INTEGER;
        const summary =
            summaryCost + additional * inputWeight + extraSummary * policy.summaryOutputRatio;
        const rebuild = initialRebuildPenalty + extraSummary * (input.cacheExpired ? 0 : 1 - r);
        return checkEstimate(
            (summary + rebuild) / work + (r * (before + after)) / (2 * growthTokens),
            "cycleCost",
        );
    };
    const currentUnitCost = cycleCost(0);
    const remaining = Math.max(0, latestStartTokens - postReleaseTokens);
    let recommendedAtTokens = postReleaseTokens;
    let bestUnitCost = currentUnitCost;
    for (let index = 1; index <= 16; index++) {
        const additional = Math.ceil((remaining * index) / 16);
        const cost = cycleCost(additional);
        if (cost < bestUnitCost) {
            bestUnitCost = cost;
            recommendedAtTokens = postReleaseTokens + additional;
        }
    }
    if (r === 0 && !input.cacheExpired) recommendedAtTokens = Math.ceil(latestStartTokens);
    const safety =
        input.forceSafety !== undefined || postReleaseTokens + growthTokens >= input.safetyTokens;
    let reason: string;
    let decision: "execute" | "wait" = "wait";
    if (input.selectedTokens === 0) reason = "no_selection";
    else if (netSavingTokens <= 0) reason = "no_savings";
    else if (safety) {
        decision = "execute";
        reason = input.forceSafety === "overflow" ? "safety_overflow" : "safety_pressure";
    } else if (!input.auto && input.trigger !== "model_request") reason = "disabled";
    else if (
        input.trigger !== "model_request" &&
        postReleaseTokens < input.targetTokens &&
        input.markedIds.length === 0
    )
        reason = "no_request";
    else if (postReleaseTokens >= latestStartTokens) {
        decision = "execute";
        reason = "window_pressure";
    } else if (recommendedAtTokens <= postReleaseTokens) {
        decision = "execute";
        reason = "cost_optimum";
    } else reason = "cost_deferred";
    return {
        heuristic: "HEURISTIC" as const,
        decision,
        reason,
        trigger: input.trigger,
        forceSafety: input.forceSafety ?? null,
        routeSignature: input.routeSignature,
        markedIds: [...new Set(input.markedIds)],
        cacheState: input.cacheState,
        effectiveCacheReadRatio: r,
        cacheExpired: input.cacheExpired,
        totalTokens: input.totalTokens,
        postReleaseTokens,
        selectedTokens: input.selectedTokens,
        prefixTokens: input.prefixTokens,
        headerOverheadTokens: input.headerOverheadTokens,
        filterInputTokens,
        predictedSummaryTokens,
        predictedAfterTokens,
        netSavingTokens,
        inlineReleaseTokens: input.inlineReleaseTokens,
        retainedSurfaceTokens,
        rebuiltSuffixTokens,
        independentRebuildTokens: input.independentRebuildTokens,
        initialRebuildPenalty,
        summaryCost,
        targetTokens: input.targetTokens,
        safetyTokens: input.safetyTokens,
        growthTokens,
        urgency,
        latestStartTokens: Math.floor(latestStartTokens),
        recommendedAtTokens,
        currentUnitCost,
        bestUnitCost,
        confidence:
            input.growthTokens === undefined
                ? ("cold_start" as const)
                : ("observed_growth" as const),
    };
}
export type ScheduledCompactionPlan = ReturnType<typeof planScheduledCompaction>;

export interface ReleaseCacheEvidence {
    readonly routeSignature: string;
    readonly usageRouteSignature: string;
    readonly usageAtMs: number;
    readonly cacheReadTokens: number;
}
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
export interface ReleaseCandidate {
    readonly seq: number;
    readonly savingTokens: number;
    readonly replacementTokens: number;
    /** Existing measured suffix strictly after this message. */
    readonly suffixTokens: number;
}
export interface ReleaseBatchInput {
    readonly revision: number;
    readonly totalTokens: number;
    readonly candidates: readonly ReleaseCandidate[];
    readonly targetTokens?: number;
    readonly safetyTokens?: number;
    readonly activeCompaction?: boolean;
    readonly opportunity?: ReleaseOpportunity;
    readonly cache?: ReleaseCacheEvidence | null;
    readonly nowMs: number;
}
export function planReleaseBatch(input: ReleaseBatchInput, config: Partial<SchedulingPolicy> = {}) {
    const policy = resolveSchedulingPolicy(config);
    checkCount(input.revision, "revision");
    checkCount(input.totalTokens, "totalTokens");
    const cacheExpired = cacheExpiryEvidence(input.cache, input.nowMs, policy.cacheTtlMs);
    const seen = new Set<number>();
    const candidates = [...input.candidates].sort(
        (a, b) => a.suffixTokens - b.suffixTokens || b.seq - a.seq,
    );
    for (const candidate of candidates) {
        for (const key of ["seq", "savingTokens", "replacementTokens", "suffixTokens"] as const)
            checkCount(candidate[key], key);
        if (seen.has(candidate.seq)) throw new RangeError("duplicate release replacement");
        seen.add(candidate.seq);
    }
    const r = policy.cacheReadRatio;
    const target = input.targetTokens ?? input.totalTokens;
    const safety = input.safetyTokens ?? Math.max(target + 1, input.totalTokens + 1);
    const urgency = Math.max(
        0,
        Math.min(1, (input.totalTokens - target) / Math.max(1, safety - target)),
    );
    let selectedSeqs: number[] = [];
    let releaseTokens = 0;
    let rebuildTokens = 0;
    // Keep nonpositive replacements deferred, including negative deltas clamped by the caller.
    // Their original bodies remain in suffixTokens and must not receive a savings deduction.
    const beneficial = candidates.filter((candidate) => candidate.savingTokens > 0);
    // Evaluate suffix batches, allowing cheap recent replacements past an expensive older mark.
    let saving = 0;
    for (let index = 0; index < beneficial.length; index++) {
        const candidate = beneficial[index]!;
        saving += candidate.savingTokens;
        const suffix =
            Math.max(0, candidate.suffixTokens - (saving - candidate.savingTokens)) +
            candidate.replacementTokens;
        const penalty = suffix * (cacheExpired ? 0 : 1 - r);
        const recent = suffix <= Math.max(1, Math.min(target * 0.025, saving));
        if (
            saving > 0 &&
            (input.opportunity !== undefined ||
                cacheExpired ||
                recent ||
                penalty * (1 - urgency) <= r * saving)
        ) {
            selectedSeqs = beneficial.slice(0, index + 1).map((item) => item.seq);
            releaseTokens = saving;
            rebuildTokens = suffix;
        }
    }
    if (input.activeCompaction) {
        selectedSeqs = [];
        releaseTokens = 0;
        rebuildTokens = 0;
    }
    const decision = selectedSeqs.length > 0 ? ("execute" as const) : ("wait" as const);
    const reason = input.activeCompaction
        ? "active_compaction"
        : candidates.length === 0
          ? "no_releases"
          : decision === "wait"
            ? "await_summary"
            : input.opportunity !== undefined
              ? `opportunity_${input.opportunity}`
              : cacheExpired
                ? "cache_expired"
                : "economical_release";
    return {
        revision: input.revision,
        decision,
        reason,
        cacheExpired,
        selectedSeqs,
        releaseTokens,
        releaseCount: selectedSeqs.length,
        deferredCount: candidates.length - selectedSeqs.length,
        deferredTokens:
            candidates.reduce((sum, item) => sum + item.savingTokens, 0) - releaseTokens,
        rebuildTokens,
        rebuildCost: rebuildTokens * (cacheExpired ? 0 : 1 - r),
    };
}
export type ReleaseBatchPlan = ReturnType<typeof planReleaseBatch>;
