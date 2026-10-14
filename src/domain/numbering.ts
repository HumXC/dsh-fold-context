import { z } from "zod";
import type { ContextFormed, Message, UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { entryId, ID_PATTERN, CONTROL_TOOLS } from "./protocol.js";
import { characterCount } from "./summary-policy.js";
import {
    attachmentBlockSchema,
    attachmentSlotSchema,
    attachmentLabel,
    isAttachmentBlock,
} from "./attachment-numbering.js";

export const ALLOCATION_SOURCE = "fold-context-allocation";
const legacyAllocationSchema = z.object({
    version: z.literal(2),
    turn: z.number().int().positive(),
    step: z.number().int().positive(),
    inputs: z.array(z.object({ messageId: z.string(), id: z.string().regex(/^§U[1-9]\d*§$/) })),
    assistantId: z.string().regex(/^§A[1-9]\d*§$/),
});
export const allocationSchema = legacyAllocationSchema.extend({
    version: z.literal(3),
    attachments: z.array(
        z.object({
            id: z.string().regex(/^§[IF][1-9]\d*§$/),
            ownerId: z.string(),
            blockIndex: z.number().int().nonnegative(),
        }),
    ),
});
const storedAllocationSchema = z.union([
    allocationSchema,
    legacyAllocationSchema,
    legacyAllocationSchema
        .extend({
            version: z.literal(1),
            inputs: z.array(
                z.object({ messageId: z.string(), id: z.string().regex(/^§[1-9]\d*§$/) }),
            ),
            assistantId: z.string().regex(/^§[1-9]\d*§$/),
        })
        .transform((plan) => ({
            ...plan,
            version: 2 as const,
            inputs: plan.inputs.map((input) => ({ ...input, id: input.id.replace("§", "§U") })),
            assistantId: plan.assistantId.replace("§", "§A"),
        })),
]);
export type AllocationPlan = z.infer<typeof allocationSchema>;
/** Plugin-owned admission metadata; the numbering recipe stays version 3. */
export interface AllocationNoticeExtras {}
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-allocation": {
            kind: typeof ALLOCATION_SOURCE;
            allocation: AllocationPlan;
        } & ContextFormed &
            AllocationNoticeExtras;
    }
}
const slotSchema = z.object({
    id: z.string().regex(ID_PATTERN),
    role: z.enum(["user", "assistant", "tool"]),
    status: z.enum(["reserved", "bound", "abandoned", "summarized"]),
    reservationSeq: z.number().int().nonnegative(),
    sourceSeq: z.number().int().nonnegative().nullable(),
    currentSeq: z.number().int().nonnegative().nullable(),
    messageId: z.string().nullable(),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    callId: z.string().nullable(),
    callSeq: z.number().int().nonnegative().nullable(),
    tool: z.string().nullable(),
    declared: z.boolean(),
    replayProtected: z.boolean(),
    summaryShape: z
        .array(
            z.object({
                type: z.string(),
                callId: z.string().nullable(),
                attachment: attachmentBlockSchema.nullable().default(null),
                characters: z.number().int().nonnegative().default(0),
                offloaded: z.boolean().default(false),
            }),
        )
        .default([]),
});
export const numberingSchema = z.object({
    nextNumber: z.number().int().positive().safe(),
    slots: z.array(slotSchema),
    attachments: z.array(attachmentSlotSchema).default([]),
    attachmentProtocol: z.boolean().default(false),
});
export type NumberingState = z.infer<typeof numberingSchema>;
export type NumberSlot = z.infer<typeof slotSchema>;
export const initialNumbering = (): NumberingState => ({
    nextNumber: 1,
    slots: [],
    attachments: [],
    attachmentProtocol: false,
});
export function isNumberedInput(message: UserMessage): boolean {
    return ![
        ALLOCATION_SOURCE,
        "runtime-context",
        "compact-checkpoint",
        "fold-context-attachment-recovery",
    ].includes(message.source.kind);
}
function shapeOf(message: Message): NumberSlot["summaryShape"] {
    return message.content.map((block) => ({
        type: block.type,
        callId: block.type === "tool-call" ? block.id : null,
        attachment: isAttachmentBlock(block) ? attachmentBlockSchema.parse(block) : null,
        characters: block.type === "reasoning" ? characterCount(block.text) : 0,
        offloaded: block.type === "image" && block.offloaded === true,
    }));
}
function pendingAttachments(state: NumberingState) {
    return state.slots.flatMap((slot) => {
        if (slot.currentSeq === null || CONTROL_TOOLS.has(slot.tool ?? "")) return [];
        return slot.summaryShape.flatMap((shape, blockIndex) => {
            if (
                shape.attachment == null ||
                state.attachments.some(
                    (item) => item.ownerId === slot.id && item.currentBlockIndex === blockIndex,
                )
            )
                return [];
            return [{ ownerId: slot.id, blockIndex, block: shape.attachment }];
        });
    });
}
/** Pure preview; only the committed declaration consumes IDs. */
export function planAllocation(
    state: NumberingState,
    messages: readonly UserMessage[],
    turn: number,
    step: number,
): AllocationPlan {
    let number = state.nextNumber;
    const incoming = messages.filter(isNumberedInput);
    const inputs = incoming.map((message) => ({
        messageId: message.id,
        id: entryId("user", number++),
    }));
    const candidates = pendingAttachments(state);
    incoming.forEach((message, index) =>
        message.content.forEach((block, blockIndex) => {
            if (isAttachmentBlock(block))
                candidates.push({
                    ownerId: inputs[index]!.id,
                    blockIndex,
                    block: attachmentBlockSchema.parse(block),
                });
        }),
    );
    const attachments = candidates.map((item) => ({
        id: attachmentLabel(item.block.type, number++),
        ownerId: item.ownerId,
        blockIndex: item.blockIndex,
    }));
    return {
        version: 3,
        turn,
        step,
        inputs,
        attachments,
        assistantId: entryId("assistant", number),
    };
}
function bindAttachments(state: NumberingState): NumberingState {
    let nextNumber = state.nextNumber;
    const added = pendingAttachments(state).map((item) => {
        const owner = state.slots.find((slot) => slot.id === item.ownerId)!;
        if (!Number.isSafeInteger(nextNumber + 1))
            throw new Error("fold-context: numbering exhausted");
        return {
            id: attachmentLabel(item.block.type, nextNumber++),
            kind: item.block.type,
            ownerId: owner.id,
            role: owner.role,
            sourceSeq: owner.currentSeq!,
            currentSeq: owner.currentSeq,
            blockIndex: item.blockIndex,
            currentBlockIndex: item.blockIndex,
            status: "bound" as const,
            block: item.block,
        };
    });
    return added.length === 0
        ? state
        : { ...state, nextNumber, attachments: [...state.attachments, ...added] };
}
function reserve(
    state: NumberingState,
    event: SessionEvent,
    values: Pick<NumberSlot, "role" | "turn" | "step"> &
        Partial<Pick<NumberSlot, "callId" | "tool" | "declared" | "replayProtected">>,
): NumberingState {
    if (!Number.isSafeInteger(state.nextNumber + 1))
        throw new Error("fold-context: numbering exhausted");
    const slot: NumberSlot = {
        id: entryId(values.role, state.nextNumber),
        status: "reserved",
        reservationSeq: event.seq,
        sourceSeq: null,
        currentSeq: null,
        messageId: null,
        callId: null,
        callSeq: null,
        tool: null,
        declared: false,
        replayProtected: false,
        summaryShape: [],
        ...values,
    };
    return { ...state, nextNumber: state.nextNumber + 1, slots: [...state.slots, slot] };
}
function bind(slot: NumberSlot, event: SessionEvent, message: Message): NumberSlot {
    return {
        ...slot,
        status: "bound",
        sourceSeq: event.seq,
        currentSeq: event.seq,
        messageId: message.id,
        replayProtected:
            slot.replayProtected ||
            (message.role === "assistant" && message.source.replayState !== undefined),
        summaryShape: shapeOf(message),
    };
}
function abandon(state: NumberingState, matches: (slot: NumberSlot) => boolean): NumberingState {
    if (!state.slots.some((slot) => slot.status === "reserved" && matches(slot))) return state;
    return {
        ...state,
        slots: state.slots.map((slot) =>
            slot.status === "reserved" && matches(slot)
                ? { ...slot, status: "abandoned" as const }
                : slot,
        ),
    };
}
/** Allocation and binding use committed events only. Legacy declarations never gain new ordinals. */
export function foldNumbering(state: NumberingState, event: SessionEvent): NumberingState {
    const candidate: { type: string; data: unknown } = event;
    if (candidate.type === "image/offload") {
        const { targets } = z
            .object({
                targets: z.array(
                    z.object({
                        seq: z.number().int().nonnegative().safe(),
                        imageIndexes: z.array(z.number().int().nonnegative().safe()),
                    }),
                ),
            })
            .parse(candidate.data);
        const indexes = new Map<number, Set<number>>();
        for (const target of targets) {
            const selected = indexes.get(target.seq) ?? new Set<number>();
            for (const index of target.imageIndexes) selected.add(index);
            indexes.set(target.seq, selected);
        }
        return {
            ...state,
            slots: state.slots.map((slot) => {
                const selected =
                    slot.currentSeq === null ? undefined : indexes.get(slot.currentSeq);
                if (selected === undefined) return slot;
                let imageIndex = 0;
                return {
                    ...slot,
                    summaryShape: slot.summaryShape.map((block) =>
                        block.type === "image" && selected.has(imageIndex++)
                            ? { ...block, offloaded: true }
                            : block,
                    ),
                };
            }),
        };
    }
    if (event.type === "session/end-seed" || event.type === "turn/end")
        return abandon(state, () => true);
    if (event.type === "step/end")
        return abandon(
            state,
            (slot) => slot.turn === event.data.turn && slot.step === event.data.step,
        );
    if (event.surfaceOp === "append" && event.type === "user/message") {
        if (event.data.source.kind === ALLOCATION_SOURCE) {
            const plan = storedAllocationSchema.parse(event.data.source.allocation);
            const admitted = state.slots.slice(state.slots.length - plan.inputs.length);
            const inputsMatch = admitted.every(
                (slot, index) =>
                    slot.role === "user" &&
                    slot.status === "bound" &&
                    slot.id === plan.inputs[index]?.id &&
                    slot.messageId === plan.inputs[index]?.messageId,
            );
            if (!inputsMatch || admitted.length !== plan.inputs.length)
                throw new Error(
                    "fold-context: allocation does not match the admitted input sequence",
                );
            if (plan.version === 3) {
                const adopted = bindAttachments({ ...state, attachmentProtocol: true });
                const added = adopted.attachments.slice(state.attachments.length);
                if (
                    added.length !== plan.attachments.length ||
                    added.some(
                        (item, index) =>
                            item.id !== plan.attachments[index]?.id ||
                            item.ownerId !== plan.attachments[index]?.ownerId ||
                            item.currentBlockIndex !== plan.attachments[index]?.blockIndex,
                    )
                )
                    throw new Error(
                        "fold-context: attachment allocation does not match admitted content",
                    );
                state = adopted;
            }
            if (plan.assistantId !== entryId("assistant", state.nextNumber))
                throw new Error(
                    "fold-context: allocation does not match the admitted input sequence",
                );
            return reserve(state, event, {
                role: "assistant",
                turn: plan.turn,
                step: plan.step,
                declared: true,
            });
        }
        if (!isNumberedInput(event.data)) return state;
        const next = reserve(state, event, { role: "user", turn: 0, step: 0 });
        return {
            ...next,
            slots: [...next.slots.slice(0, -1), bind(next.slots.at(-1)!, event, event.data)],
        };
    }
    if (event.surfaceOp === "append" && event.type === "assistant/message") {
        const { turn, step, message } = event.data;
        let index = state.slots.findLastIndex(
            (slot) =>
                slot.role === "assistant" &&
                slot.status === "reserved" &&
                slot.turn === turn &&
                slot.step === step,
        );
        let next = state;
        if (index < 0) {
            next = reserve(next, event, { role: "assistant", turn, step });
            index = next.slots.length - 1;
        }
        next = {
            ...next,
            slots: next.slots.map((slot, offset) =>
                offset === index ? bind(slot, event, message) : slot,
            ),
        };
        for (const block of message.content)
            if (block.type === "tool-call")
                next = reserve(next, event, {
                    role: "tool",
                    turn,
                    step,
                    callId: block.id,
                    tool: block.name,
                    replayProtected: message.source.replayState !== undefined,
                });
        return next.attachmentProtocol ? bindAttachments(next) : next;
    }
    if (event.type === "tool/call") {
        const { turn, step, callId, name } = event.data;
        let index = state.slots.findIndex(
            (slot) =>
                slot.role === "tool" &&
                slot.status === "reserved" &&
                slot.turn === turn &&
                slot.step === step &&
                slot.callId === callId &&
                slot.callSeq === null,
        );
        let next = state;
        if (index < 0) {
            next = reserve(next, event, { role: "tool", turn, step, callId, tool: name });
            index = next.slots.length - 1;
        }
        return {
            ...next,
            slots: next.slots.map((slot, offset) =>
                offset === index ? { ...slot, callSeq: event.seq } : slot,
            ),
        };
    }
    if (event.surfaceOp === "append" && event.type === "tool/result") {
        const { turn, step, message } = event.data;
        const index = state.slots.findIndex(
            (slot) =>
                slot.role === "tool" &&
                (slot.status === "reserved" || slot.status === "abandoned") &&
                slot.turn === turn &&
                slot.step === step &&
                slot.callId === message.source.callId &&
                (event.sourceEventSeqs === undefined ||
                    event.sourceEventSeqs.some((seq) => seq === slot.callSeq)),
        );
        if (index < 0) throw new Error("fold-context: tool result has no preceding allocation");
        const next = {
            ...state,
            slots: state.slots.map((slot, offset) =>
                offset === index ? bind(slot, event, message) : slot,
            ),
        };
        return next.attachmentProtocol ? bindAttachments(next) : next;
    }
    return state;
}
/** Original attachment occurrence remains addressable after its owner's surface disappears. */
export function replaceNumberedSurface(
    state: NumberingState,
    event: SessionEvent,
    removed: readonly number[],
): NumberingState {
    if (removed.length === 0) return state;
    const affected = state.slots.filter(
        (slot) => slot.currentSeq !== null && removed.includes(slot.currentSeq),
    );
    const message =
        event.type === "user/message"
            ? event.data
            : event.type === "assistant/message" || event.type === "tool/result"
              ? event.data.message
              : null;
    const slots = state.slots.map((slot) => {
        if (slot.currentSeq === null || !removed.includes(slot.currentSeq)) return slot;
        if (affected.length === 1 && message?.role === slot.role && message.id === slot.messageId)
            return { ...slot, currentSeq: event.seq, summaryShape: shapeOf(message) };
        return { ...slot, currentSeq: null, status: "summarized" as const };
    });
    const used = new Set<string>();
    const attachments = state.attachments.map((item) => {
        if (item.currentSeq === null || !removed.includes(item.currentSeq)) return item;
        const owner = slots.find((slot) => slot.id === item.ownerId);
        if (owner?.currentSeq === event.seq) {
            const matches = owner.summaryShape.flatMap((shape, index) =>
                shape.attachment?.type === item.block.type &&
                JSON.stringify(shape.attachment.attachment) ===
                    JSON.stringify(item.block.attachment) &&
                !used.has(`${owner.id}:${index}`)
                    ? [index]
                    : [],
            );
            const index = matches.includes(item.currentBlockIndex ?? -1)
                ? item.currentBlockIndex!
                : matches[0];
            if (index !== undefined) {
                used.add(`${owner.id}:${index}`);
                return { ...item, currentSeq: event.seq, currentBlockIndex: index };
            }
        }
        return {
            ...item,
            currentSeq: null,
            currentBlockIndex: null,
            status: "summarized" as const,
        };
    });
    const next = { ...state, slots, attachments };
    return next.attachmentProtocol ? bindAttachments(next) : next;
}
