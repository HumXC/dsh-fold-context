import { createHash } from "node:crypto";
import { z } from "zod";

export const reminderPolicySchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type ReminderPolicy = z.infer<typeof reminderPolicySchema>;
export function resolveReminderPolicy(
    value: Partial<ReminderPolicy> = {},
): Readonly<ReminderPolicy> {
    return Object.freeze(reminderPolicySchema.parse(value));
}
export interface ReminderCandidate {
    readonly id: string;
    readonly tool: string | null;
    readonly preview: string;
    readonly tokens: number;
    readonly ageSteps: number;
    readonly seq: number;
    /** Retained suffix potentially invalidated by this replacement; omit when unknown. */
    readonly suffixTokens?: number;
}
/** Fixed-size durable state; proposals are persisted only when admitted. */
export interface ReminderState {
    readonly backlogSinceStep: number | null;
    readonly lastReminderStep: number | null;
    /** Highest notified pressure band plus canonical pool digest, at most 64 characters. */
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
    /** Business steps only; management calls must not advance this clock. */
    readonly step: number;
    /** Caller excludes queued, protected and control evidence. Advice never authorizes release. */
    readonly candidates: readonly ReminderCandidate[];
    readonly previous: ReminderState;
    /** Last newly accepted semantic release; duplicate/no-op requests do not advance it. */
    readonly progressSeq: number;
    /** Measured prompt / soft target, null when unavailable. */
    readonly pressure: number | null;
    readonly targetTokens?: number;
    readonly cacheReadRatio?: number;
    readonly activeCompaction?: boolean;
}
export interface ReleaseReminderPlan {
    readonly decision: "remind" | "wait";
    readonly reason: string;
    readonly state: ReminderState;
    /** At most five advisory suggestions. */
    readonly candidates: ReminderCandidate[];
    readonly candidateTokens: number;
}
function checkCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`fold-context reminder: ${name} must be a nonnegative safe integer`);
}
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
function pressureBand(pressure: number | null): number {
    return pressure === null
        ? 0
        : pressure >= 1.35
          ? 4
          : pressure >= 1.15
            ? 3
            : pressure >= 1
              ? 2
              : pressure >= 0.9
                ? 1
                : 0;
}
/** Pure advisory planner: elapsed time and identity churn alone never rearm reminders. */
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
    if (input.pressure !== null && (!Number.isFinite(input.pressure) || input.pressure < 0))
        throw new RangeError("fold-context reminder: invalid pressure");
    if (input.targetTokens !== undefined) {
        checkCount(input.targetTokens, "targetTokens");
        if (input.targetTokens === 0)
            throw new RangeError("fold-context reminder: targetTokens must be positive");
    }
    const ratio = input.cacheReadRatio ?? 0.1;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
        throw new RangeError("fold-context reminder: invalid cacheReadRatio");
    const ready = input.candidates.filter(
        (candidate) =>
            Number.isFinite(candidate.tokens) &&
            candidate.tokens > 0 &&
            Number.isFinite(candidate.ageSteps) &&
            candidate.ageSteps >= 2,
    );
    const ids = new Set<string>();
    let candidateTokens = 0;
    for (const candidate of ready) {
        checkCount(candidate.tokens, "candidate.tokens");
        checkCount(candidate.ageSteps, "candidate.ageSteps");
        checkCount(candidate.seq, "candidate.seq");
        if (candidate.suffixTokens !== undefined)
            checkCount(candidate.suffixTokens, "candidate.suffixTokens");
        if (!candidate.id || ids.has(candidate.id))
            throw new RangeError("ready candidate IDs must be nonempty and unique");
        ids.add(candidate.id);
        candidateTokens += candidate.tokens;
        checkCount(candidateTokens, "candidateTokens");
    }
    // Unknown suffix cost is not evidence that replacement would be free.
    const benefit = (candidate: ReminderCandidate) =>
        candidate.suffixTokens === undefined
            ? 0
            : ratio * candidate.tokens - (1 - ratio) * candidate.suffixTokens;
    ready.sort(
        (left, right) =>
            benefit(right) - benefit(left) ||
            right.tokens - left.tokens ||
            right.seq - left.seq ||
            compareIds(left.id, right.id),
    );
    const candidates = ready.slice(0, 5);
    const target = input.targetTokens;
    const massFloor =
        target === undefined ? 16000 : Math.max(2048, Math.min(16000, Math.ceil(target * 0.05)));
    const pressureFloor =
        target === undefined ? 2048 : Math.max(512, Math.min(2048, Math.ceil(target * 0.01)));
    const band = pressureBand(input.pressure);
    const previousBand = /^[0-4]:/.test(previous.lastFingerprint ?? "")
        ? Number(previous.lastFingerprint![0])
        : 0;
    const hasProgress = input.progressSeq > previous.lastProgressSeq;
    const growthFloor = Math.max(
        2048,
        Math.min(8192, Math.ceil((target ?? 400000) * 0.02)),
        Math.ceil(previous.tokensAtLastReminder * 0.25),
    );
    const hasGrowth =
        previous.lastReminderStep !== null &&
        candidateTokens - previous.tokensAtLastReminder >= growthFloor;
    const escalation = band > previousBand;
    let state: ReminderState = {
        ...previous,
        backlogSinceStep: ready.length ? (previous.backlogSinceStep ?? input.step) : null,
        ignoredCount: hasProgress ? 0 : Math.min(previous.ignoredCount, 3),
        lastFingerprint: hasProgress ? null : previous.lastFingerprint,
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
    if (!ready.length) return wait("empty");
    const reason =
        band > 0 && candidateTokens >= pressureFloor
            ? "pressure"
            : ready.some((candidate) => candidate.tokens >= 2048 && benefit(candidate) > 0)
              ? "benefit"
              : candidateTokens >= massFloor
                ? "backlog"
                : null;
    if (reason === null) return wait("below_threshold");
    if (state.lastFingerprint !== null && !hasGrowth && !escalation) return wait("unchanged");
    // Bounded dampening of genuine changes, not periodic reminders of old evidence.
    const interval =
        hasProgress || state.lastFingerprint === null
            ? 4
            : [4, 8, 16, 24][Math.min(state.ignoredCount, 3)]!;
    if (state.lastReminderStep !== null && input.step - state.lastReminderStep < interval)
        return wait(interval > 4 ? "ignored_backoff" : "min_interval");
    const fingerprint =
        `${Math.max(previousBand, band)}:` +
        createHash("sha256")
            .update(JSON.stringify([...ids].sort(compareIds)))
            .digest("hex")
            .slice(0, 62);
    state = {
        ...state,
        lastReminderStep: input.step,
        lastFingerprint: fingerprint,
        ignoredCount: state.lastFingerprint === null ? 0 : Math.min(state.ignoredCount + 1, 3),
        tokensAtLastReminder: candidateTokens,
    };
    return { decision: "remind", reason, state, candidates, candidateTokens };
}
