import type { LedgerState } from "./ledger.js";
import { displayId } from "./protocol.js";
import { pendingReleaseReason } from "./release.js";

/** Presentation metadata on the final prune; Client waits for its paired replacement. */
export const RELEASE_REPORT_KEY = "foldContextRelease";
export const RELEASE_REPORT_VERSION = 1;

export function releaseReport(
    state: LedgerState,
    releasedIds: ReadonlySet<string>,
    batchId: string,
) {
    const item = (entry: LedgerState["entries"][number], released: boolean) => ({
        id: entry.id,
        displayId: displayId(entry.id, released),
        tool: entry.tool,
        kind: entry.role,
        ownerId: entry.ownerId,
        preview: Array.from(entry.preview).slice(0, 120).join(""),
        reason:
            entry.reason ??
            state.entries.find((owner) => owner.id === entry.ownerId)?.reason ??
            null,
        pendingReason: released ? null : pendingReleaseReason(state, entry, new Set()),
        sourceSeq: entry.sourceSeq,
    });
    return {
        version: RELEASE_REPORT_VERSION,
        batchId,
        released: state.entries
            .filter((entry) => releasedIds.has(entry.id))
            .map((entry) => item(entry, true)),
        pending: state.entries
            .filter((entry) => entry.status === "queued" && !releasedIds.has(entry.id))
            .map((entry) => item(entry, false)),
    };
}
