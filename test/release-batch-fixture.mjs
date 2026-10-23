import { planReleaseBatch } from "../lib/domain/scheduler.js";
import { commitInlineReleases, estimateInlineReleases } from "../lib/integration/inline-release.js";
import { withSessionCut } from "../lib/integration/session-cut.js";

function permitAtCut(f, cut) {
    const state = f.engine.state(f.session);
    const estimate = estimateInlineReleases(f.ctx, f.session, state, cut);
    const planned = planReleaseBatch({
        revision: cut.revision,
        totalTokens: f.meter.measure(f.session).totalTokens,
        candidates: estimate.replacements.map((item) => ({
            seq: item.seq,
            savingTokens: Math.max(0, item.beforeTokens - item.afterTokens),
            replacementTokens: item.afterTokens,
            suffixTokens: 0,
        })),
        nowMs: Date.now(),
        cache: null,
        opportunity: "summary",
        activeCompaction: state.activeStart !== null,
    });
    // This fixture tests the transaction committer independently of economic admission,
    // including placeholders whose cost exceeds a tiny original body.
    return {
        ...planned,
        decision: state.activeStart === null ? "execute" : "wait",
        selectedSeqs: estimate.replacements.map((item) => item.seq),
        releaseCount: estimate.replacementCount,
    };
}

/** Imminent-summary permit priced from one exact public observation. */
export function forcedReleasePermit(f) {
    return withSessionCut(f.ctx, f.session, (cut) => permitAtCut(f, cut));
}

export function commitForcedReleases(f, signal = new AbortController().signal) {
    return withSessionCut(
        f.ctx,
        f.session,
        (cut) =>
            commitInlineReleases(
                f.ctx,
                f.session,
                f.engine.state(f.session),
                signal,
                permitAtCut(f, cut),
                cut,
            ),
        signal,
    );
}
