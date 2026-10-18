import { planReleaseBatch } from "../lib/domain/scheduler.js";
import { commitInlineReleases, estimateInlineReleases } from "../lib/integration/inline-release.js";

/** Explicit user-compaction opportunity for tests of release application, not timing. */
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
        opportunity: "user_compact",
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

/** Isolate release/recovery semantics from default scheduling in real-loop tests. */
export function installForcedReleaseBoundary(f) {
    return f.ctx.on("agent/pre-step", async (context, next) => {
        commitForcedReleases(
            {
                ctx: f.ctx,
                engine: f.engine,
                session: context.agent.session,
                meter: f.ctx.tokenMeter,
            },
            context.signal,
        );
        return next();
    });
}
