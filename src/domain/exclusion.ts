import type { Message } from "@deepseek-ai/dsh-llm";
import type { LedgerState } from "./ledger.js";

/** Pure selection shared by request filtering and replay-time commit settlement. */
export function selectedExclusions(
    state: LedgerState,
    selected: ReadonlySet<number>,
    cutoff: number,
    mode: "native" | "transcript" = "native",
) {
    const slots = new Map(state.numbering.slots.map((slot) => [slot.id, slot]));
    const owners = new Map(
        state.numbering.slots
            .filter((slot) => slot.role === "assistant")
            .map((slot) => [slot.sourceSeq, slot]),
    );
    const eligible = state.entries.filter((entry) => {
        if (
            !(
                entry.status === "queued" ||
                (entry.status === "released" && entry.role === "tool")
            ) ||
            entry.queuedAt === null ||
            entry.queuedAt >= cutoff ||
            entry.currentSeq === null ||
            !selected.has(entry.currentSeq)
        )
            return false;
        if (entry.role === "image" || entry.role === "file") {
            if (mode !== "transcript") return false;
            const attachment = state.numbering.attachments.find((item) => item.id === entry.id);
            const owner = attachment === undefined ? undefined : slots.get(attachment.ownerId);
            const shape =
                attachment?.currentBlockIndex == null
                    ? undefined
                    : owner?.summaryShape[attachment.currentBlockIndex]?.attachment;
            return (
                attachment?.currentSeq === entry.currentSeq &&
                shape?.type === entry.role &&
                shape.attachment.attachmentId === attachment.block.attachment.attachmentId
            );
        }
        const slot = slots.get(entry.id);
        if (mode === "native" && slot?.replayProtected) return false;
        if (entry.role !== "tool")
            return slot?.summaryShape.some((block) => block.type === "text") ?? false;
        const owner = owners.get(slot?.reservationSeq ?? -1);
        return (
            slot !== undefined &&
            slot.callSeq !== null &&
            owner?.currentSeq != null &&
            (mode === "transcript" || !owner.replayProtected) &&
            selected.has(owner.currentSeq) &&
            (owner.summaryShape ?? []).filter(
                (block) => block.type === "tool-call" && block.callId === entry.callId,
            ).length === 1
        );
    });
    if (mode === "transcript") return eligible;
    const excludedText = new Set(
        eligible.filter((entry) => entry.role === "assistant").map((entry) => entry.id),
    );
    const toolsByOwner = new Map<number, typeof eligible>();
    for (const entry of eligible) {
        if (entry.role !== "tool") continue;
        const ownerSeq = slots.get(entry.id)!.reservationSeq;
        const group = toolsByOwner.get(ownerSeq) ?? [];
        group.push(entry);
        toolsByOwner.set(ownerSeq, group);
    }
    const blocked = new Set<string>();
    for (const owner of owners.values()) {
        if (owner.currentSeq === null || !selected.has(owner.currentSeq)) continue;
        const toolEntries = toolsByOwner.get(owner.sourceSeq ?? -1) ?? [];
        const calls = new Set(toolEntries.map((entry) => entry.callId));
        const remaining = (owner.summaryShape ?? []).filter(
            (block) =>
                !(block.type === "text" && excludedText.has(owner.id)) &&
                !(block.type === "tool-call" && calls.has(block.callId)),
        );
        if (remaining.length > 0 && remaining.every((block) => block.type === "reasoning")) {
            blocked.add(owner.id);
            for (const entry of toolEntries) blocked.add(entry.id);
        }
    }
    return eligible.filter((entry) => !blocked.has(entry.id));
}

/** Only the temporary summary request changes. No original message or event is mutated. */
export function summaryInput(
    state: LedgerState,
    messages: readonly Message[],
    cutoff: number,
): Message[] {
    const messageIds = new Set<string>(messages.map((message) => message.id));
    const selected = new Set(
        state.numbering.slots.flatMap((slot) =>
            slot.currentSeq !== null && slot.messageId !== null && messageIds.has(slot.messageId)
                ? [slot.currentSeq]
                : [],
        ),
    );
    const exclusions = selectedExclusions(state, selected, cutoff);
    const textIds = new Set(
        exclusions.filter((entry) => entry.role !== "tool").map((entry) => entry.messageId),
    );
    const resultIds = new Set(
        exclusions.filter((entry) => entry.role === "tool").map((entry) => entry.messageId),
    );
    const slots = new Map(state.numbering.slots.map((slot) => [slot.id, slot]));
    const owners = new Map(
        state.numbering.slots
            .filter((slot) => slot.role === "assistant")
            .map((slot) => [slot.sourceSeq, slot]),
    );
    const calls = new Map<string, Set<string>>();
    for (const entry of exclusions) {
        if (entry.role !== "tool" || entry.callId === null) continue;
        const owner = owners.get(slots.get(entry.id)?.reservationSeq ?? -1);
        if (owner?.messageId == null) continue;
        const ids = calls.get(owner.messageId) ?? new Set<string>();
        ids.add(entry.callId);
        calls.set(owner.messageId, ids);
    }
    return messages.flatMap<Message>((message) => {
        if (message.role === "tool" && resultIds.has(message.id)) return [];
        const content = message.content.filter(
            (block) =>
                !(block.type === "text" && textIds.has(message.id)) &&
                !(
                    message.role === "assistant" &&
                    block.type === "tool-call" &&
                    calls.get(message.id)?.has(block.id)
                ),
        );
        if (content.length === message.content.length) return [message];
        if (content.length === 0) return [];
        // Retained adapter state and nontext blocks are never altered or reassigned.
        return [{ ...message, content }];
    });
}
