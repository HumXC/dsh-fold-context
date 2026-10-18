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
export type SchedulingSafetyReason = "pressure" | "overflow" | "user_compact";
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
    | "legacy_request"
    | "safety_pressure"
    | "safety_overflow"
    | "safety_user_compact";

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
    readonly stepsSinceSummary: number;
    /** Marks covered by the candidate selection, not unrelated queued marks. */
    readonly markedIds: readonly string[];
    readonly routeSignature?: string | null;
    readonly cacheState?: SchedulingCacheState;
    readonly effectiveCacheReadRatio?: number;
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
        stepsSinceSummary: tokenCountSchema,
        markedIds: z.array(z.string().min(1)),
        routeSignature: z.string().nullable().default(null),
        cacheState: z.enum(["unknown", "cached", "uncached"]).default("unknown"),
        effectiveCacheReadRatio: ratioSchema.max(1).optional(),
        headerOverheadTokens: tokenCountSchema.default(0),
        auto: z.boolean().default(true),
        forceSafety: z.enum(["pressure", "overflow", "user_compact"]).optional(),
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
    readonly stepsSinceSummary: number;
    readonly predictedSummaryTokens: number;
    readonly netSavingTokens: number;
    /** Fraction of the current total prompt saved by replacing the whole span. */
    readonly savingsRatio: number;
    readonly retainedSurfaceTokens: number;
    readonly headerOverheadTokens: number;
    readonly rebuiltSuffixTokens: number;
    readonly initialRebuildPenalty: number;
    readonly summaryCost: number;
    readonly perTurnSaving: number;
    /** Null means no positive savings or no representable finite payback. */
    readonly breakEvenTurns: number | null;
}

/**
 * Deterministic gate for low-pressure model requests and marked backlog.
 * Unknown cache state conservatively assumes a cached prefix and uses the
 * configured read ratio. An explicitly uncached estimate defaults to ratio 1
 * with no rebuild penalty. Route signatures are provenance only; this module
 * never infers provider hits, TTL, pricing, pressure, or transaction authority.
 *
 * Safety overrides skip economics. auto:false still disables pressure, while
 * overflow and explicit requests remain allowed. /compact should call the base
 * compactNow directly; safety_user_compact is available only for reporting.
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
    const netSavingTokens = Math.max(0, input.selectedTokens - predictedSummaryTokens);
    const retainedSurfaceTokens =
        input.totalTokens - input.prefixTokens - input.selectedTokens - input.headerOverheadTokens;
    const rebuiltSuffixTokens = checkEstimate(
        predictedSummaryTokens + retainedSurfaceTokens + input.headerOverheadTokens,
        "rebuiltSuffixTokens",
    );
    const cachedPrefixAssumed = input.cacheState !== "uncached";
    const effectiveCacheReadRatio =
        input.effectiveCacheReadRatio ?? (cachedPrefixAssumed ? policy.cacheReadRatio : 1);
    const initialRebuildPenalty = cachedPrefixAssumed
        ? checkEstimate(
              rebuiltSuffixTokens * (1 - effectiveCacheReadRatio),
              "initialRebuildPenalty",
          )
        : 0;
    const summaryCost = checkEstimate(
        filterInputTokens * policy.summaryInputRatio +
            predictedSummaryTokens * policy.summaryOutputRatio,
        "summaryCost",
    );
    const perTurnSaving = checkEstimate(netSavingTokens * effectiveCacheReadRatio, "perTurnSaving");
    const upfrontCost = checkEstimate(initialRebuildPenalty + summaryCost, "upfrontCost");
    const payback = perTurnSaving > 0 ? Math.ceil(upfrontCost / perTurnSaving) : null;
    const breakEvenTurns = payback !== null && Number.isSafeInteger(payback) ? payback : null;
    const savingsRatio = input.totalTokens > 0 ? netSavingTokens / input.totalTokens : 0;
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
    } else if (!policy.enabled && input.trigger === "model_request") {
        reason = "legacy_request";
        decision = "execute";
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
        stepsSinceSummary: input.stepsSinceSummary,
        predictedSummaryTokens,
        netSavingTokens,
        savingsRatio,
        retainedSurfaceTokens,
        headerOverheadTokens: input.headerOverheadTokens,
        rebuiltSuffixTokens,
        initialRebuildPenalty,
        summaryCost,
        perTurnSaving,
        breakEvenTurns,
    };
}
