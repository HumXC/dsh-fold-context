import type { LedgerState } from "./ledger.js";

/** Recorded release provenance for recovered bodies and attachments. */
export function recoveryReleaseMetadata(state: LedgerState, id: string) {
    const entry = state.entries.find((item) => item.id === id);
    const owner = entry?.ownerId
        ? state.entries.find((item) => item.id === entry.ownerId)
        : undefined;
    const reason =
        entry?.status === "released"
            ? (entry.reason ?? (owner?.status === "released" ? owner.reason : null))
            : null;
    return {
        releaseStatus: entry?.status ?? null,
        ...(typeof reason === "string" && reason.trim() ? { releaseReason: reason } : {}),
    };
}
