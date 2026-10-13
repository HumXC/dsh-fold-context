import { z } from "zod";
import type { ContextFormed, Message, UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { entryId } from "./protocol.js";

export const ALLOCATION_SOURCE = "fold-context-allocation";
export const allocationSchema = z.object({
    version: z.literal(1),
    turn: z.number().int().positive(),
    step: z.number().int().positive(),
    inputs: z.array(z.object({ messageId: z.string(), id: z.string().regex(/^§[1-9]\d*§$/) })),
    assistantId: z.string().regex(/^§[1-9]\d*§$/),
});
export type AllocationPlan = z.infer<typeof allocationSchema>;
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-allocation": {
            kind: typeof ALLOCATION_SOURCE;
            allocation: AllocationPlan;
        } & ContextFormed;
    }
}
const slotSchema = z.object({
    id: z.string(),
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
});
export const numberingSchema = z.object({
    nextNumber: z.number().int().positive().safe(),
    slots: z.array(slotSchema),
});
export type NumberingState = z.infer<typeof numberingSchema>;
export type NumberSlot = z.infer<typeof slotSchema>;
export const initialNumbering = (): NumberingState => ({ nextNumber: 1, slots: [] });

export function isNumberedInput(message: UserMessage): boolean {
    return ![ALLOCATION_SOURCE, "runtime-context", "compact-checkpoint"].includes(
        message.source.kind,
    );
}
/** Pure preview: only admission of the declaration consumes its assistant ID. */
export function planAllocation(
    state: NumberingState,
    messages: readonly UserMessage[],
    turn: number,
    step: number,
): AllocationPlan {
    let number = state.nextNumber;
    const inputs = messages.filter(isNumberedInput).map((message) => ({
        messageId: message.id,
        id: entryId(number++),
    }));
    return { version: 1, turn, step, inputs, assistantId: entryId(number) };
}
function reserve(
    state: NumberingState,
    event: SessionEvent,
    values: Pick<NumberSlot, "role" | "turn" | "step"> &
        Partial<Pick<NumberSlot, "callId" | "tool" | "declared">>,
): NumberingState {
    if (!Number.isSafeInteger(state.nextNumber + 1))
        throw new Error("fold-context: numbering exhausted");
    const slot: NumberSlot = {
        id: entryId(state.nextNumber),
        status: "reserved",
        reservationSeq: event.seq,
        sourceSeq: null,
        currentSeq: null,
        messageId: null,
        callId: null,
        callSeq: null,
        tool: null,
        declared: false,
        ...values,
    };
    return { nextNumber: state.nextNumber + 1, slots: [...state.slots, slot] };
}
function bind(slot: NumberSlot, event: SessionEvent, message: Message): NumberSlot {
    return {
        ...slot,
        status: "bound",
        sourceSeq: event.seq,
        currentSeq: event.seq,
        messageId: message.id,
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
/** Allocation and binding are derived solely from committed events; no append observer writes. */
export function foldNumbering(state: NumberingState, event: SessionEvent): NumberingState {
    if (event.type === "session/end-seed" || event.type === "turn/end")
        return abandon(state, () => true);
    if (event.type === "step/end")
        return abandon(
            state,
            (slot) => slot.turn === event.data.turn && slot.step === event.data.step,
        );
    if (event.surfaceOp === "append" && event.type === "user/message") {
        const source = event.data.source;
        if (source.kind === ALLOCATION_SOURCE) {
            const plan = allocationSchema.parse(source.allocation);
            const admitted = state.slots.slice(state.slots.length - plan.inputs.length);
            const inputsMatch = admitted.every((slot, index) => {
                const input = plan.inputs[index];
                return (
                    slot.role === "user" &&
                    slot.status === "bound" &&
                    slot.id === input?.id &&
                    slot.messageId === input.messageId
                );
            });
            if (
                plan.assistantId !== entryId(state.nextNumber) ||
                !inputsMatch ||
                admitted.length !== plan.inputs.length
            )
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
        // Imported history predates the declaration protocol; its original content is never rewritten.
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
        // The durable assistant owns the complete model-ordered call list before any tool executes.
        for (const block of message.content)
            if (block.type === "tool-call")
                next = reserve(next, event, {
                    role: "tool",
                    turn,
                    step,
                    callId: block.id,
                    tool: block.name,
                });
        return next;
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
        const references = event.sourceEventSeqs;
        const index = state.slots.findIndex(
            (slot) =>
                slot.role === "tool" &&
                (slot.status === "reserved" || slot.status === "abandoned") &&
                slot.turn === turn &&
                slot.step === step &&
                slot.callId === message.source.callId &&
                (references === undefined || references.some((seq) => seq === slot.callSeq)),
        );
        if (index < 0) throw new Error("fold-context: tool result has no preceding allocation");
        return {
            ...state,
            slots: state.slots.map((slot, offset) =>
                offset === index ? bind(slot, event, message) : slot,
            ),
        };
    }
    return state;
}
/** Surface replacements retain identity; complete historical summaries remove its live binding. */
export function replaceNumberedSurface(
    state: NumberingState,
    event: SessionEvent,
    removed: readonly number[],
): NumberingState {
    if (removed.length === 0) return state;
    const affected = state.slots.filter(
        (slot) => slot.currentSeq !== null && removed.includes(slot.currentSeq),
    );
    return {
        ...state,
        slots: state.slots.map((slot) => {
            if (slot.currentSeq === null || !removed.includes(slot.currentSeq)) return slot;
            if (event.type === "tool/result" && affected.length === 1)
                return { ...slot, currentSeq: event.seq, messageId: event.data.message.id };
            return { ...slot, currentSeq: null, status: "summarized" as const };
        }),
    };
}
