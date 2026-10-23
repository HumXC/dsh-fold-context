import { createHash } from "node:crypto";
import type { Message } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { isNumberedInput, type NumberingState } from "./numbering.js";
import { CONTROL_TOOLS, normalizeId } from "./protocol.js";

/** Events and surface describe one exact observed append revision. */
export interface SummaryRangeCut {
    readonly sessionId: string;
    readonly revision: number;
    readonly surface: readonly number[];
    readonly events: ReadonlyMap<number, SessionEvent>;
}

/** A detached, JSON-only description of one inclusive positional surface span. */
export interface FrozenSummaryRange {
    sessionId: string;
    seqs: number[];
    nodes: Array<{ seq: number; messageId: string | null; fingerprint: string }>;
    messages: Array<{
        seq: number;
        id: string;
        role: "user" | "assistant" | "tool";
        tool: string | null;
    }>;
    attachments: Array<{
        seq: number;
        id: string;
        ownerId: string;
        blockIndex: number;
        kind: "image" | "file";
    }>;
    checkpoints: Array<{ seq: number; compactionId: string }>;
    unnumbered: Array<{ seq: number; kind: string }>;
}

function fail(reason: string): never {
    throw new Error(`fold-context: summary range: ${reason}`);
}

/** Object insertion order is not message content; array order is. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonical(item)]),
        );
    return value;
}

function serialized(value: unknown): string {
    const result = JSON.stringify(canonical(value));
    if (result === undefined) return fail("value is not JSON");
    return result;
}

function fingerprint(message: Message | null): string {
    return createHash("sha256").update(serialized(message)).digest("hex");
}

/** Freeze positions first, then resolve identities from the current numbering projection. */
export function freezeSummaryRange(
    session: Session,
    numbering: NumberingState,
    range: { start: number; end: number },
    cut: SummaryRangeCut,
): FrozenSummaryRange {
    if (
        !Number.isSafeInteger(range.start) ||
        range.start < 0 ||
        !Number.isSafeInteger(range.end) ||
        range.end < 0
    )
        return fail("endpoints must be nonnegative safe integers");
    if (cut.sessionId !== session.id || cut.revision !== session.seq)
        return fail("observation revision changed");
    const surface = cut.surface;
    const start = surface.indexOf(SessionSeq(range.start));
    const end = surface.indexOf(SessionSeq(range.end));
    if (start < 0 || end < start) return fail("endpoints do not delimit a current surface span");
    const frozen: FrozenSummaryRange = {
        sessionId: session.id,
        seqs: surface.slice(start, end + 1).map(Number),
        nodes: [],
        messages: [],
        attachments: [],
        checkpoints: [],
        unnumbered: [],
    };
    const slots = new Map<number, NumberingState["slots"]>();
    for (const slot of numbering.slots) {
        if (slot.currentSeq === null) continue;
        const group = slots.get(slot.currentSeq) ?? [];
        group.push(slot);
        slots.set(slot.currentSeq, group);
    }
    const attachments = new Map<number, NumberingState["attachments"]>();
    for (const attachment of numbering.attachments) {
        if (attachment.currentSeq === null) continue;
        const group = attachments.get(attachment.currentSeq) ?? [];
        group.push(attachment);
        attachments.set(attachment.currentSeq, group);
    }
    const ids = new Set<string>();
    const claimId = (id: string) => {
        normalizeId(id);
        if (ids.has(id)) fail(`duplicate mapped ID ${id}`);
        ids.add(id);
    };
    for (const seq of frozen.seqs) {
        const event = cut.events.get(seq);
        if (event === undefined) return fail(`surface event ${seq} is missing`);
        const message = session.deriveEventMessage(event);
        frozen.nodes.push({
            seq,
            messageId: message?.id ?? null,
            fingerprint: fingerprint(message),
        });
        if (message === null) {
            frozen.unnumbered.push({ seq, kind: event.type });
            continue;
        }
        if (message.role === "system" || message.role === "developer") {
            frozen.unnumbered.push({ seq, kind: message.role });
            continue;
        }
        if (message.role === "user" && message.source.kind === "compact-checkpoint") {
            const source = message.source as { kind: string; compactionId?: unknown };
            if (typeof source.compactionId !== "string" || source.compactionId.length === 0)
                return fail(`checkpoint ${seq} has no compaction identity`);
            frozen.checkpoints.push({ seq, compactionId: source.compactionId });
            continue;
        }
        if (message.role === "user" && !isNumberedInput(message)) {
            frozen.unnumbered.push({ seq, kind: message.source.kind });
            continue;
        }
        const matches = slots.get(seq) ?? [];
        if (matches.length !== 1)
            return fail(`event ${seq} needs exactly one message numbering slot`);
        const slot = matches[0]!;
        if (
            slot.status !== "bound" ||
            slot.role !== message.role ||
            slot.messageId !== message.id ||
            (message.role === "tool" && slot.callId !== message.toolCallId)
        )
            return fail(`event ${seq} has a mismatched message numbering slot`);
        claimId(slot.id);
        frozen.messages.push({ seq, id: slot.id, role: slot.role, tool: slot.tool });
        const mapped = [...(attachments.get(seq) ?? [])].sort(
            (left, right) => (left.currentBlockIndex ?? -1) - (right.currentBlockIndex ?? -1),
        );
        const positions = new Set<number>();
        for (const attachment of mapped) {
            const index = attachment.currentBlockIndex;
            if (index === null || !Number.isSafeInteger(index) || index < 0 || positions.has(index))
                return fail(`event ${seq} has an ambiguous attachment position`);
            const block = message.content[index];
            if (
                attachment.status !== "bound" ||
                attachment.ownerId !== slot.id ||
                block === undefined ||
                (block.type !== "image" && block.type !== "file") ||
                block.type !== attachment.kind ||
                serialized(block.attachment) !== serialized(attachment.block.attachment)
            )
                return fail(`event ${seq} has a mismatched attachment numbering slot`);
            positions.add(index);
            claimId(attachment.id);
            frozen.attachments.push({
                seq,
                id: attachment.id,
                ownerId: attachment.ownerId,
                blockIndex: index,
                kind: attachment.kind,
            });
        }
        // The existing numberer deliberately leaves control-tool attachments unnumbered.
        if (!CONTROL_TOOLS.has(slot.tool ?? ""))
            message.content.forEach((block, index) => {
                if ((block.type === "image" || block.type === "file") && !positions.has(index))
                    fail(`event ${seq} attachment ${index} has no numbering slot`);
            });
    }
    return frozen;
}

/** New events outside the selected span do not invalidate a prepared summary. */
export function validateSummaryRange(
    session: Session,
    numbering: NumberingState,
    frozen: FrozenSummaryRange,
    cut: SummaryRangeCut,
): { valid: true } | { valid: false; reason: string } {
    try {
        if (session.id !== frozen.sessionId) return { valid: false, reason: "session mismatch" };
        if (frozen.seqs.length === 0) return { valid: false, reason: "selected span is empty" };
        if (cut.sessionId !== session.id || cut.revision !== session.seq)
            return { valid: false, reason: "observation revision changed" };
        const start = cut.surface.indexOf(frozen.seqs[0]!);
        if (start < 0 || frozen.seqs.some((seq, offset) => cut.surface[start + offset] !== seq))
            return {
                valid: false,
                reason: "selected nodes are missing, reordered or no longer contiguous",
            };
        const current = freezeSummaryRange(
            session,
            numbering,
            { start: frozen.seqs[0]!, end: frozen.seqs.at(-1)! },
            cut,
        );
        for (const [key, reason] of [
            ["nodes", "derived message content changed"],
            ["messages", "message numbering changed"],
            ["attachments", "attachment numbering changed"],
            ["checkpoints", "checkpoint identities changed"],
            ["unnumbered", "unnumbered node classification changed"],
        ] as const)
            if (serialized(current[key]) !== serialized(frozen[key]))
                return { valid: false, reason };
        return { valid: true };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
