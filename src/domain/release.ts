import type { LedgerState } from "./ledger.js";

type Entry = LedgerState["entries"][number];
/** Inline edits preserve assistant provider replay records and all conversation text. */
export function canReleaseInline(state: LedgerState, entry: Entry): boolean {
    if (entry.currentSeq === null || !state.surface.includes(entry.currentSeq)) return false;
    if (entry.role === "tool") return true;
    if (entry.role !== "image" && entry.role !== "file") return false;
    const owner = state.numbering.slots.find((slot) => slot.id === entry.ownerId);
    const attachment = state.numbering.attachments.find((item) => item.id === entry.id);
    return (
        owner !== undefined &&
        owner.role !== "assistant" &&
        owner.currentSeq === entry.currentSeq &&
        attachment?.currentBlockIndex != null &&
        owner.summaryShape[attachment.currentBlockIndex]?.offloaded !== true
    );
}

export function pendingReleaseReason(
    state: LedgerState,
    entry: Entry,
    selectable: ReadonlySet<string>,
): string | null {
    if (entry.status !== "queued") return null;
    if (entry.releaseMode === "inline") {
        if (state.activeStart !== null) return "summary_in_progress";
        return canReleaseInline(state, entry) ? "awaiting_step_boundary" : "protocol_protection";
    }
    if (!selectable.has(entry.id)) return "protocol_protection";
    if (state.activeStart !== null) return "summary_in_progress";
    if (
        state.lastSummary !== null &&
        entry.queuedAt !== null &&
        entry.queuedAt < state.lastSummary.seq
    )
        return "outside_selection";
    if (state.summaryRequests.at(-1)?.status === "failed") return "summary_failed";
    return "awaiting_covering_summary";
}

/** R labels describe a visible placeholder, not a historical summary exclusion. */
export function hasInlinePlaceholder(entry: Entry | undefined): boolean {
    return (
        entry?.status === "released" && entry.releaseMode === "inline" && entry.currentSeq !== null
    );
}
