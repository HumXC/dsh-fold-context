export interface PressureBudgetPolicy {
    readonly thresholdRatio: number;
    readonly retainRatio: number;
    readonly retainTokens?: number | undefined;
}

/** Plan compaction against a window using an already validated model policy. */
export function planPressureBudget(window: number | undefined, policy: PressureBudgetPolicy) {
    if (window === undefined || !Number.isSafeInteger(window) || window <= 0) return null;
    const threshold = Math.max(1, Math.floor(window * policy.thresholdRatio));
    const requestedRetain = policy.retainTokens ?? Math.floor(window * policy.retainRatio);
    const retain = Math.max(0, Math.min(requestedRetain, threshold - 1));
    return { threshold, retain };
}
