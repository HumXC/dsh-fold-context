import { createHash } from "node:crypto";
import { z } from "zod";

const countSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = countSchema.positive();

export const reminderPolicySchema = z
    .object({
        enabled: z.boolean().default(true),
        minAgeSteps: countSchema.default(2),
        /** Ranking hint only: a single large output never triggers a reminder. */
        largeOutputTokens: positiveCountSchema.default(8000),
        backlogTokens: positiveCountSchema.default(16000),
        staleTokens: positiveCountSchema.default(4000),
        staleSteps: countSchema.default(8),
        pressureRatio: z.number().finite().min(0).max(1).default(0.8),
        minIntervalSteps: positiveCountSchema.default(6),
        pressureIntervalSteps: positiveCountSchema.default(4),
        ignoredBackoffSteps: z
            .array(positiveCountSchema)
            .min(1)
            .max(16)
            .refine((steps) =>
                steps.every((step, index) => index === 0 || step >= steps[index - 1]!),
            )
            .default([12, 24]),
        rearmGrowthTokens: positiveCountSchema.default(8000),
        maxCandidates: positiveCountSchema.default(5),
    })
    .strict();

export type ReminderPolicy = z.infer<typeof reminderPolicySchema>;

export function resolveReminderPolicy(
    value: Partial<ReminderPolicy> = {},
): Readonly<ReminderPolicy> {
    const policy = reminderPolicySchema.parse(value);
    Object.freeze(policy.ignoredBackoffSteps);
    return Object.freeze(policy);
}

export interface ReminderCandidate {
    readonly id: string;
    readonly tool: string | null;
    readonly preview: string;
    readonly tokens: number;
    readonly ageSteps: number;
    readonly seq: number;
}

/** Bounded, JSON-serializable state; no candidate IDs or growing history are retained. */
export interface ReminderState {
    readonly backlogSinceStep: number | null;
    readonly lastReminderStep: number | null;
    /** SHA-256 of canonical IDs of the full ready pool at the last outstanding reminder. */
    readonly lastFingerprint: string | null;
    readonly ignoredCount: number;
    readonly tokensAtLastReminder: number;
    readonly lastProgressSeq: number;
}

export function initialReminderState(): ReminderState {
    return {
        backlogSinceStep: null,
        lastReminderStep: null,
        lastFingerprint: null,
        ignoredCount: 0,
        tokensAtLastReminder: 0,
        lastProgressSeq: 0,
    };
}

export interface ReleaseReminderInput {
    /** Business steps only; control/reminder tool calls must not advance this clock. */
    readonly step: number;
    /** Caller excludes queued/protected/control evidence before passing candidates. */
    readonly candidates: readonly ReminderCandidate[];
    readonly previous: ReminderState;
    /** Seq of the last newly accepted semantic release; duplicates/no-ops leave it unchanged. */
    readonly progressSeq: number;
    /** Measured prompt tokens / actual official compaction threshold, or null if unknown. */
    readonly pressure: number | null;
    readonly activeCompaction?: boolean;
}

export interface ReleaseReminderPlan {
    readonly decision: "remind" | "wait";
    readonly reason: string;
    readonly state: ReminderState;
    /** At most maxCandidates suggestions; never an instruction to release automatically. */
    readonly candidates: ReminderCandidate[];
    /** Total ready-pool estimate, before truncating suggestions. */
    readonly candidateTokens: number;
}

function checkCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`fold-context reminder: ${name} must be a nonnegative safe integer`);
    }
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pure advisory planner. Prefer estimated reclaim, then newer equal-size evidence:
 * mutating earlier evidence can rebuild a larger cached suffix. The large-output
 * flag affects ranking only. Fingerprint the entire ready pool, not its displayed
 * prefix, so ordering, previews and top-K truncation cannot change its identity.
 * A changed fingerprint alone is neither semantic progress nor sufficient growth.
 */
export function planReleaseReminder(
    input: ReleaseReminderInput,
    config: Partial<ReminderPolicy> = {},
): ReleaseReminderPlan {
    const policy = resolveReminderPolicy(config);
    checkCount(input.step, "step");
    checkCount(input.progressSeq, "progressSeq");
    const previous = input.previous;
    checkCount(previous.ignoredCount, "previous.ignoredCount");
    checkCount(previous.tokensAtLastReminder, "previous.tokensAtLastReminder");
    checkCount(previous.lastProgressSeq, "previous.lastProgressSeq");
    if (previous.backlogSinceStep !== null)
        checkCount(previous.backlogSinceStep, "backlogSinceStep");
    if (previous.lastReminderStep !== null)
        checkCount(previous.lastReminderStep, "lastReminderStep");
    if (input.pressure !== null && (!Number.isFinite(input.pressure) || input.pressure < 0)) {
        throw new RangeError(
            "fold-context reminder: pressure must be finite and nonnegative or null",
        );
    }

    const ready = input.candidates.filter(
        (candidate) =>
            Number.isFinite(candidate.tokens) &&
            candidate.tokens > 0 &&
            Number.isFinite(candidate.ageSteps) &&
            candidate.ageSteps >= policy.minAgeSteps,
    );
    const ids = new Set<string>();
    let candidateTokens = 0;
    for (const candidate of ready) {
        checkCount(candidate.tokens, "candidate.tokens");
        checkCount(candidate.ageSteps, "candidate.ageSteps");
        checkCount(candidate.seq, "candidate.seq");
        if (!candidate.id || ids.has(candidate.id)) {
            throw new RangeError(
                "fold-context reminder: ready candidate IDs must be nonempty and unique",
            );
        }
        ids.add(candidate.id);
        candidateTokens += candidate.tokens;
        checkCount(candidateTokens, "candidateTokens");
    }
    ready.sort(
        (left, right) =>
            Number(right.tokens >= policy.largeOutputTokens) -
                Number(left.tokens >= policy.largeOutputTokens) ||
            right.tokens - left.tokens ||
            right.seq - left.seq ||
            compareIds(left.id, right.id),
    );
    const candidates = ready.slice(0, policy.maxCandidates);
    const hasProgress = input.progressSeq > previous.lastProgressSeq;
    const hasGrowth =
        previous.lastReminderStep !== null &&
        candidateTokens - previous.tokensAtLastReminder >= policy.rearmGrowthTokens;
    const maxIgnored = policy.ignoredBackoffSteps.length + 1;
    let state: ReminderState = {
        ...previous,
        backlogSinceStep:
            candidateTokens >= policy.staleTokens
                ? (previous.backlogSinceStep ?? input.step)
                : null,
        ignoredCount: hasProgress || hasGrowth ? 0 : Math.min(previous.ignoredCount, maxIgnored),
        lastFingerprint: hasProgress || hasGrowth ? null : previous.lastFingerprint,
        lastProgressSeq: Math.max(previous.lastProgressSeq, input.progressSeq),
    };
    const wait = (reason: string): ReleaseReminderPlan => ({
        decision: "wait",
        reason,
        state,
        candidates,
        candidateTokens,
    });
    if (!policy.enabled) return wait("disabled");
    if (input.activeCompaction) return wait("active_compaction");
    if (ready.length === 0) return wait("empty");

    const pressure =
        input.pressure !== null &&
        input.pressure >= policy.pressureRatio &&
        candidateTokens >= policy.staleTokens;
    const stale =
        state.backlogSinceStep !== null && input.step - state.backlogSinceStep >= policy.staleSteps;
    const reason =
        candidateTokens >= policy.backlogTokens
            ? "backlog"
            : pressure
              ? "pressure"
              : stale
                ? "stale"
                : null;
    if (reason === null) return wait("below_threshold");

    // Count an ignored reminder once, when replacing it with another reminder.
    // Waits and repeated/no-op calls cannot accrue ignores or move the cooldown.
    const ignoredCount =
        state.lastFingerprint === null
            ? state.ignoredCount
            : Math.min(state.ignoredCount + 1, maxIgnored);
    const normalInterval = pressure ? policy.pressureIntervalSteps : policy.minIntervalSteps;
    const backoff = ignoredCount >= 2 ? (policy.ignoredBackoffSteps[ignoredCount - 2] ?? 0) : 0;
    // Growth rearms the ordinary minimum even if pressure is also present.
    const interval = Math.max(hasGrowth ? policy.minIntervalSteps : normalInterval, backoff);
    if (state.lastReminderStep !== null && input.step - state.lastReminderStep < interval) {
        return wait(backoff > normalInterval ? "ignored_backoff" : "min_interval");
    }

    const fingerprint = createHash("sha256")
        .update(JSON.stringify([...ids].sort(compareIds)))
        .digest("hex");
    state = {
        ...state,
        lastReminderStep: input.step,
        lastFingerprint: fingerprint,
        ignoredCount,
        tokensAtLastReminder: candidateTokens,
    };
    return { decision: "remind", reason, state, candidates, candidateTokens };
}
