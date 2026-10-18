import type { NumberingState } from "./numbering.js";

/** Message declarations follow admission order, independently of reserved ordinal order. */
export function unannouncedMessages(state: NumberingState): string[] {
    return state.slots
        .filter((slot) => !slot.declared && slot.currentSeq !== null)
        .sort((left, right) => left.sourceSeq! - right.sourceSeq!)
        .map((slot) => slot.id);
}
export function attachmentOrdinal(
    state: NumberingState,
    ownerId: string,
    blockIndex: number,
): number {
    const owner = state.slots.find((slot) => slot.id === ownerId);
    if (owner === undefined) throw new Error("fold-context: attachment owner is missing");
    return owner.summaryShape.slice(0, blockIndex + 1).filter((block) => block.attachment !== null)
        .length;
}
