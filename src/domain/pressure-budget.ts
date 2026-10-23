export interface PressureBudgetPolicy {
    readonly targetTokens?: number | undefined;
    readonly summaryMaxTokens?: number | undefined;
}

/** A soft target and a conservative input boundary. Never subtract an adapter's
 * oversized default maxTokens from a context window: input/output metadata varies.
 * Reserve bounded preparation/growth space; real usage and overflow remain authoritative.
 */
export function planPressureBudget(window: number | undefined, policy: PressureBudgetPolicy = {}) {
    if (window === undefined || !Number.isSafeInteger(window) || window < 4) return null;
    if (
        policy.targetTokens !== undefined &&
        (!Number.isSafeInteger(policy.targetTokens) || policy.targetTokens < 1)
    )
        throw new RangeError("targetTokens must be a positive safe integer");
    const output = policy.summaryMaxTokens ?? 8192;
    if (!Number.isSafeInteger(output) || output < 1)
        throw new RangeError("summaryMaxTokens must be positive");
    const reserve = Math.min(
        Math.floor(window / 3),
        Math.max(Math.ceil(window * 0.1), output + Math.ceil(window / 32)),
    );
    const safety = Math.max(2, window - reserve);
    const threshold = Math.min(
        safety - 1,
        policy.targetTokens ?? Math.max(1, Math.floor((window * 2) / 3)),
    );
    // Keep room for a fresh business segment; protected task evidence is enforced separately.
    const retain = Math.max(0, Math.floor(threshold * 0.25));
    return {
        threshold,
        safety,
        retain,
        configuredTarget: policy.targetTokens ?? null,
        targetClamped: policy.targetTokens !== undefined && policy.targetTokens !== threshold,
    };
}
