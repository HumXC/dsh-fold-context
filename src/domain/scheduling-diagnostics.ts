import type { ReleaseBatchPlan, ScheduledCompactionPlan, SchedulingPolicy } from "./scheduler.js";

export interface SchedulingLimits {
    readonly heuristic: "HEURISTIC";
    readonly contextWindowTokens: number;
    readonly thresholdTokens: number;
    readonly safetyTokens?: number;
    readonly configuredTargetTokens?: number | null;
    readonly targetClamped?: boolean;
    readonly retentionTokens: number;
    readonly headerOverheadTokens: number;
    readonly systemHeadTokens: number;
    readonly protectedTailTokens: number;
    readonly minimumPromptTokens: number;
}

export interface SummaryInputEstimate {
    readonly execution: "independent" | "session";
    readonly historyTokens: number;
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly framingTokens: number;
    readonly totalTokens: number;
}

interface DiagnosticInput {
    readonly reason: string;
    readonly limits: SchedulingLimits | null;
    readonly plan: ScheduledCompactionPlan | null;
    readonly retryAfterSteps: number;
}

const explanations: Readonly<Record<string, readonly [string, string]>> = {
    active_compaction: [
        "A summary transaction is already running.",
        "Wait for that transaction to finish.",
    ],
    no_route: [
        "The session has no routed provider/model.",
        "Configure the conversation route before requesting a checkpoint.",
    ],
    state_changed: [
        "The session changed during planning.",
        "Inspect again at the next stable step boundary.",
    ],
    missing_capacity: [
        "The model does not declare a context window.",
        "Provide a valid model contextWindow; no capacity is guessed.",
    ],
    invalid_capacity: [
        "The declared context window is not a positive safe integer.",
        "Correct the model contextWindow; changing output limits does not repair invalid metadata.",
    ],
    metadata_unavailable: [
        "The routed model metadata could not be resolved.",
        "Check the provider/model configuration; pressure urgency is unavailable until metadata resolves.",
    ],
    no_selection: [
        "No balanced historical prefix satisfies retention and current-task protection.",
        "Keep the active task intact; continue until an older complete prefix is available, or inspect the retention target.",
    ],
    no_request: [
        "There is no queued history or checkpoint request for proactive summarization.",
        "Release consumed tool evidence or request a checkpoint when useful.",
    ],
    disabled: [
        "This automatic scheduling path is disabled by policy.",
        "Automatic summaries are disabled; queued requests and safety recovery remain available.",
    ],
    no_business_evidence: [
        "The selectable prefix contains no new business evidence.",
        "Continue the task; repeatedly summarizing an old checkpoint cannot remove more evidence.",
    ],
    ineffective_compaction: [
        "The previous summary did not reduce provider-observed pressure, and no new business prefix is available.",
        "Inspect protected input and the last pressure effect before requesting another summary.",
    ],
    cost_optimum: [
        "The current checkpoint minimizes the bounded forecast cost per new business token.",
        "Prepare and commit the selected checkpoint.",
    ],
    cost_deferred: [
        "A later checkpoint has lower forecast cost within the window budget.",
        "Reconsider after growth, cache changes or increased window pressure.",
    ],
    window_pressure: [
        "The cost-adjusted window threshold has been reached.",
        "Prepare a checkpoint and verify the resulting prompt size.",
    ],
    no_savings: [
        "The proposed summary has no positive estimated saving.",
        "Keep the request until a useful selection exists.",
    ],
    safety_pressure: [
        "Prompt pressure reached the window threshold; economic gates are bypassed.",
        "Run the balanced summary, then verify its effect using the next primary request's usage.",
    ],
    safety_overflow: [
        "The provider reported context overflow; economic gates are bypassed.",
        "Run the bounded overflow recovery and retry the primary request.",
    ],
};

/** On-demand explanations: no session writes and no extra prompt injection. */
export function describeScheduling(input: DiagnosticInput, _policy: Readonly<SchedulingPolicy>) {
    const plan = input.plan;
    let [summary, nextAction] = explanations[input.reason] ?? [
        `Scheduling gate: ${input.reason}.`,
        "Inspect the plan and pressure verification before requesting another checkpoint.",
    ];
    if (input.reason === "failed_cooldown") {
        summary = `A summary failed; retry is deferred for ${input.retryAfterSteps} completed steps.`;
        nextAction =
            "Inspect the recorded failure and fix its cause before retrying; existing intent is preserved.";
    }
    const constraints: { code: string; message: string }[] = [];
    if (input.limits !== null) {
        const limits = input.limits;
        if (limits.headerOverheadTokens + limits.systemHeadTokens >= limits.thresholdTokens) {
            constraints.push({
                code: "fixed_overhead",
                message:
                    "The preserved system prompt and request envelope already reach the pressure threshold; history summaries alone cannot reach the target.",
            });
        } else if (limits.minimumPromptTokens >= limits.thresholdTokens) {
            constraints.push({
                code: "protected_input",
                message:
                    "The fixed prompt and protected current-task tail already reach the pressure threshold; reduce fixed input or split the active task to reach the target.",
            });
        }
    }
    return {
        summary,
        nextAction,
        constraints,
        economics:
            plan === null
                ? null
                : {
                      heuristic: "HEURISTIC" as const,
                      cacheBasis:
                          plan.cacheState === "unknown" ? "assumed_cached" : "primary_usage",
                      cacheReadRatio: plan.effectiveCacheReadRatio,
                      cacheExpiredAssumed: plan.cacheExpired,
                      independentRebuildTokens: plan.independentRebuildTokens,
                      summaryCost: plan.summaryCost,
                      incrementalRebuildPenalty: plan.initialRebuildPenalty,
                      currentUnitCost: plan.currentUnitCost,
                      bestUnitCost: plan.bestUnitCost,
                      recommendedAtTokens: plan.recommendedAtTokens,
                      latestStartTokens: plan.latestStartTokens,
                      confidence: plan.confidence,
                  },
    };
}

/** Release permission and summary economics are independent gates. */
export function describeReleaseBatch(plan: ReleaseBatchPlan) {
    const explanations: Partial<Record<ReleaseBatchPlan["reason"], string>> = {
        no_releases: "No eligible native replacements are queued.",
        active_compaction: "A summary transaction is active; releases remain queued.",
        await_summary: "Older replacements await a covering checkpoint or a cheaper rebuild.",
        economical_release:
            "The selected recent replacements can settle without rebuilding the stable prefix.",
        cache_expired:
            "Same-route primary cache-hit usage exceeds the configured TTL; expiry is assumed.",
    };
    return {
        summary:
            explanations[plan.reason] ??
            "An independently authorized summary, rebuild, or safety path grants this release batch.",
        nextAction:
            plan.decision === "execute"
                ? "Commit once at the same session revision, then remeasure before selecting a summary."
                : "Keep marks queued; reconsider at a later stable boundary.",
    };
}
