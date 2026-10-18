import { planReleaseBatch } from "../lib/domain/scheduler.js";
import { commitInlineReleases, estimateInlineReleases } from "../lib/integration/inline-release.js";

/** Imminent-summary permit for isolated release-application tests. */
export function forcedReleasePermit(f) {
    const state = f.engine.state(f.session);
    const estimate = estimateInlineReleases(f.ctx, f.session, state);
    return planReleaseBatch({
        revision: f.session.seq,
        totalTokens: f.meter.measure(f.session).totalTokens,
        releaseTokens: Math.max(0, estimate.beforeTokens - estimate.afterTokens),
        releaseCount: estimate.replacementCount,
        oldestWaitSteps: 0,
        nowMs: Date.now(),
        cache: null,
        opportunity: "summary",
        activeCompaction: state.activeStart !== null,
    });
}

export function commitForcedReleases(f, signal = new AbortController().signal) {
    return commitInlineReleases(
        f.ctx,
        f.session,
        f.engine.state(f.session),
        signal,
        forcedReleasePermit(f),
    );
}
