import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
    COMPACT_TOOL,
    CONTROL_TOOLS,
    RECEIPT_KEY,
    RELEASE_TOOL,
    previewContent,
    isReleasedContent,
    normalizeId,
    hasReleasableBody,
    legacyId,
    ID_PATTERN,
} from "./protocol.js";
import {
    foldNumbering,
    initialNumbering,
    numberingSchema,
    replaceNumberedSurface,
} from "./numbering.js";
import { selectedExclusions } from "./exclusion.js";
import { projectionReceipt } from "./summary-projection.js";
import { readProjectionStamp } from "./summary-policy.js";
import { ALLOCATION_SOURCE } from "./numbering.js";
import { initialReminderState } from "./reminder.js";

const reminderStateSchema = z.object({
    backlogSinceStep: z.number().int().nonnegative().nullable(),
    lastReminderStep: z.number().int().nonnegative().nullable(),
    lastFingerprint: z.string().max(64).nullable(),
    ignoredCount: z.number().int().nonnegative(),
    tokensAtLastReminder: z.number().int().nonnegative(),
    lastProgressSeq: z.number().int().nonnegative(),
});
const receiptSchema = z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    reasoning: z.enum(["preserve", "omit-from-summary"]),
    images: z.enum(["native", "references"]).optional(),
    attachments: z
        .array(
            z.object({
                id: z.string(),
                ownerId: z.string(),
                sourceSeq: z.number().int().nonnegative(),
                currentSeq: z.number().int().nonnegative(),
                blockIndex: z.number().int().nonnegative(),
                kind: z.enum(["image", "file"]),
                bytes: z.number().int().nonnegative(),
                action: z.enum([
                    "native-image",
                    "file-handle",
                    "reference-only",
                    "marked-excluded",
                    "tool-pair-excluded",
                ]),
            }),
        )
        .optional(),
    omittedReasoning: z.array(
        z.object({
            id: z.string(),
            sourceSeq: z.number().int().nonnegative(),
            currentSeq: z.number().int().nonnegative(),
            blockIndex: z.number().int().nonnegative(),
            characters: z.number().int().nonnegative(),
        }),
    ),
});

const entrySchema = z.object({
    id: z.string().regex(ID_PATTERN),
    role: z.enum(["user", "assistant", "tool", "image", "file"]),
    ownerId: z.string().nullable().default(null),
    blockIndex: z.number().int().nonnegative().nullable().default(null),
    sourceSeq: z.number().int().nonnegative(),
    currentSeq: z.number().int().nonnegative().nullable(),
    messageId: z.string(),
    callId: z.string().nullable(),
    tool: z.string().nullable(),
    preview: z.string(),
    status: z.enum(["available", "queued", "released", "summarized"]),
    queuedAt: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
    releaseMode: z.enum(["inline", "summary"]).default("summary"),
    admittedAtBusinessStep: z.number().int().nonnegative().default(0),
});
export const intentSchema = z.object({
    version: z.literal(4),
    kind: z.enum(["release", "summary"]),
    sessionId: z.string(),
    ids: z.array(z.string().regex(ID_PATTERN)).max(128),
    reason: z.string().max(1000),
});
const storedIntentSchema = z.union([
    intentSchema,
    intentSchema.extend({ version: z.literal(6) }),
    intentSchema.extend({ version: z.literal(5) }),
    intentSchema.extend({ version: z.literal(3) }),
    intentSchema.extend({
        version: z.literal(2),
        ids: z.array(z.string().regex(/^§[1-9]\d*§$/)).max(128),
    }),
]);
const summaryRequestSchema = z.object({
    seq: z.number().int().nonnegative(),
    status: z.enum(["queued", "applied", "failed"]),
    error: z.string().nullable(),
    retryable: z.boolean().default(false),
});
export const ledgerSchema = z.object({
    entries: z.array(entrySchema),
    businessSteps: z.number().int().nonnegative().default(0),
    pendingBusinessStep: z.boolean().default(false),
    lastReleaseProgressSeq: z.number().int().nonnegative().default(0),
    reminderState: reminderStateSchema.default(initialReminderState),
    numbering: numberingSchema,
    surface: z.array(z.number().int().nonnegative()),
    summaryRequests: z.array(summaryRequestSchema),
    activeStart: z.number().int().nonnegative().nullable(),
    activeCompactionId: z.string().nullable(),
    pendingSummary: z
        .object({
            seq: z.number().int().nonnegative(),
            compactionId: z.string(),
            shadowedSeqs: z.array(z.number().int().nonnegative()),
            excludedIds: z.array(z.string()),
            projection: receiptSchema.nullable(),
        })
        .nullable(),
    lastSummary: z
        .object({
            seq: z.number().int().nonnegative(),
            ids: z.array(z.string()),
            excludedIds: z.array(z.string()),
            projection: receiptSchema.nullable(),
        })
        .nullable(),
});
export type LedgerState = z.infer<typeof ledgerSchema>;
export function isOutstandingSummaryRequest(
    request: LedgerState["summaryRequests"][number],
): boolean {
    return request.status === "queued" || (request.status === "failed" && request.retryable);
}
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextCompression: LedgerState;
    }
}
function readIntent(event: SessionEvent, name: string) {
    if (name !== RELEASE_TOOL && name !== COMPACT_TOOL) return null;
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") return null;
    if (event.type === "tool/result" ? event.data.message.isError : event.data.isError) return null;
    let value: unknown = event.type === "tool/result" ? event.data.meta : undefined;
    if (value === undefined) {
        const blocks =
            event.type === "tool/result" ? event.data.message.content : event.data.content;
        try {
            value = JSON.parse(
                blocks
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join(""),
            );
        } catch {
            return null;
        }
    }
    if (value === null || typeof value !== "object" || !(RECEIPT_KEY in value)) return null;
    const parsed = storedIntentSchema.safeParse(value[RECEIPT_KEY]);
    return parsed.success ? parsed.data : null;
}
function withAttachmentEntries(state: LedgerState): LedgerState {
    const known = new Set(state.entries.map((entry) => entry.id));
    const owners = new Map(state.numbering.slots.map((slot) => [slot.id, slot]));
    const attachments = state.numbering.attachments
        .filter((item) => !known.has(item.id))
        .map((item) => {
            const owner = owners.get(item.ownerId);
            if (owner?.messageId == null)
                throw new Error("fold-context: attachment owner is missing");
            return {
                id: item.id,
                role: item.kind,
                ownerId: item.ownerId,
                blockIndex: item.blockIndex,
                sourceSeq: item.sourceSeq,
                currentSeq: item.currentSeq,
                messageId: owner.messageId,
                callId: owner.callId,
                tool: owner.tool,
                preview: `${item.block.attachment.name ?? item.kind} (${item.block.attachment.bytes} bytes)`,
                status: item.currentSeq === null ? ("summarized" as const) : ("available" as const),
                queuedAt: null,
                releaseMode: "summary" as const,
                admittedAtBusinessStep: state.businessSteps + (state.pendingBusinessStep ? 1 : 0),
                reason: null,
            };
        });
    return attachments.length === 0
        ? state
        : { ...state, entries: [...state.entries, ...attachments] };
}
export const ledgerProjection: ProjectionDefinition<"contextCompression"> = {
    key: "contextCompression",
    stateVersion: 13,
    stateSchema: ledgerSchema,
    init: () => ({
        entries: [],
        businessSteps: 0,
        pendingBusinessStep: false,
        lastReleaseProgressSeq: 0,
        reminderState: initialReminderState(),
        numbering: initialNumbering(),
        surface: [],
        summaryRequests: [],
        activeStart: null,
        activeCompactionId: null,
        pendingSummary: null,
        lastSummary: null,
    }),
    apply(state, event) {
        // Only completed business steps advance reminder age/cooldown. Pure context
        // management calls (including explanatory text) cannot age their own backlog.
        if (event.type === "step/start") state = { ...state, pendingBusinessStep: false };
        if (event.type === "assistant/message" && event.surfaceOp === "append") {
            const calls = event.data.message.content.filter((block) => block.type === "tool-call");
            const business =
                calls.length > 0
                    ? calls.some((call) => !CONTROL_TOOLS.has(call.name))
                    : event.data.message.content.some(
                          (block) => block.type === "text" && block.text.trim().length > 0,
                      );
            state = { ...state, pendingBusinessStep: state.pendingBusinessStep || business };
        }
        if (event.type === "step/end")
            state = {
                ...state,
                businessSteps: state.businessSteps + (state.pendingBusinessStep ? 1 : 0),
                pendingBusinessStep: false,
            };
        if (
            event.type === "user/message" &&
            event.surfaceOp === "append" &&
            event.data.source.kind === ALLOCATION_SOURCE
        ) {
            const parsed = reminderStateSchema.safeParse(event.data.source.releaseReminderState);
            if (parsed.success) state = { ...state, reminderState: parsed.data };
        }
        const numbering = foldNumbering(state.numbering, event);
        if (numbering !== state.numbering) state = withAttachmentEntries({ ...state, numbering });
        if (event.type === "session/end-seed" && state.activeStart !== null) {
            const abandonedStart = state.activeStart;
            return {
                ...state,
                activeStart: null,
                activeCompactionId: null,
                pendingSummary: null,
                summaryRequests: state.summaryRequests.map((request) =>
                    request.status === "queued" && request.seq < abandonedStart
                        ? {
                              ...request,
                              status: "failed" as const,
                              error: "Summary interrupted before recovery boundary",
                          }
                        : request,
                ),
            };
        }
        if (event.type === "compaction/start")
            return {
                ...state,
                activeStart: event.seq,
                activeCompactionId: event.data.compactionId,
                pendingSummary: null,
            };
        if (event.type === "compaction/summary") {
            if (state.activeStart === null || state.activeCompactionId !== event.data.compactionId)
                return state;
            const selected = new Set(event.data.shadowedSeqs);
            const first = event.data.summary[0];
            const policy = readProjectionStamp(
                first?.type === "text" ? first.text : undefined,
                event.data.compactionId,
            );
            const excludedIds =
                policy === null
                    ? []
                    : selectedExclusions(
                          state,
                          selected,
                          state.activeStart,
                          policy === undefined ? "native" : "transcript",
                      ).map((entry) => entry.id);
            const projection = policy == null ? null : projectionReceipt(state, selected, policy);
            return {
                ...state,
                pendingSummary: {
                    seq: event.seq,
                    compactionId: event.data.compactionId,
                    shadowedSeqs: [...event.data.shadowedSeqs],
                    excludedIds,
                    projection,
                },
            };
        }
        if (event.type === "compaction/end") {
            if (event.data.compactionId !== state.activeCompactionId) return state;
            const start = state.activeStart;
            return {
                ...state,
                activeStart: null,
                activeCompactionId: null,
                pendingSummary: null,
                summaryRequests:
                    event.data.error === undefined || start === null
                        ? state.summaryRequests
                        : state.summaryRequests.map((request) =>
                              request.status === "queued" && request.seq < start
                                  ? {
                                        ...request,
                                        status: "failed" as const,
                                        error: event.data.error ?? null,
                                    }
                                  : request,
                          ),
            };
        }
        if (event.type === "tool/ptc-dispatch") {
            const intent = readIntent(event, event.data.name);
            return intent === null ? state : applyIntent(state, intent, event.seq);
        }
        if (event.surfaceOp === undefined) return state;
        const op = event.surfaceOp;
        let removed: number[] = [];
        let surface: number[];
        if (op === "append") surface = [...state.surface, event.seq];
        else {
            const start = state.surface.indexOf(op.startSeq),
                end = state.surface.indexOf(op.endSeq);
            if (start < 0 || end < start)
                throw new Error("fold-context: replacement span missing during replay");
            removed = state.surface.slice(start, end + 1);
            surface = [
                ...state.surface.slice(0, start),
                event.seq,
                ...state.surface.slice(end + 1),
            ];
        }
        const updatedNumbering = replaceNumberedSurface(state.numbering, event, removed);
        const removedSet = new Set(removed);
        const affected = state.entries.filter(
            (entry) => entry.currentSeq !== null && removedSet.has(entry.currentSeq),
        );
        const checkpoint =
            op !== "append" &&
            event.type === "user/message" &&
            event.data.source.kind === "compact-checkpoint";
        const pending = state.pendingSummary;
        const confirmed =
            checkpoint &&
            state.activeStart !== null &&
            pending !== null &&
            event.type === "user/message" &&
            event.data.source.kind === "compact-checkpoint" &&
            event.data.source.compactionId === state.activeCompactionId &&
            pending.compactionId === state.activeCompactionId &&
            event.seq === pending.seq + 1 &&
            event.sourceEventSeqs?.some((seq) => seq === pending.seq) &&
            removed.length === pending.shadowedSeqs.length &&
            removed.every((seq, index) => seq === pending.shadowedSeqs[index]);
        const committedExclusions = confirmed ? new Set(pending.excludedIds) : new Set<string>();
        const message =
            event.type === "user/message"
                ? event.data
                : event.type === "assistant/message" || event.type === "tool/result"
                  ? event.data.message
                  : null;
        const inlineReleased = new Set(
            affected
                .filter(
                    (entry) =>
                        !checkpoint &&
                        (entry.status === "queued" || entry.status === "released") &&
                        entry.releaseMode === "inline" &&
                        event.sourceEventSeqs?.some((seq) => seq === entry.currentSeq) &&
                        message !== null &&
                        isReleasedContent(message.content, entry.id),
                )
                .map((entry) => entry.id),
        );
        let entries = state.entries.map((entry) => {
            if (entry.currentSeq === null || !removedSet.has(entry.currentSeq)) return entry;
            if (
                inlineReleased.has(entry.id) ||
                (entry.ownerId !== null && inlineReleased.has(entry.ownerId))
            ) {
                return {
                    ...entry,
                    status: "released" as const,
                    preview: "",
                    currentSeq: inlineReleased.has(entry.id) ? event.seq : null,
                };
            }
            if (!checkpoint && (entry.role === "image" || entry.role === "file")) {
                const attachment = updatedNumbering.attachments.find(
                    (item) => item.id === entry.id,
                );
                if (attachment?.currentSeq != null)
                    return { ...entry, currentSeq: attachment.currentSeq };
            }
            if (
                !checkpoint &&
                affected.filter((item) => item.role !== "image" && item.role !== "file").length ===
                    1 &&
                message?.role === entry.role &&
                message.id === entry.messageId
            ) {
                const released =
                    entry.status === "queued" &&
                    event.sourceEventSeqs?.some((seq) => seq === entry.currentSeq) &&
                    [entry.id, legacyId(entry.id)].some((id) =>
                        isReleasedContent(message.content, id),
                    );
                return {
                    ...entry,
                    currentSeq: event.seq,
                    status: released ? ("released" as const) : entry.status,
                    preview: released ? "" : previewContent(message.content),
                };
            }
            return {
                ...entry,
                currentSeq: null,
                status: committedExclusions.has(entry.id)
                    ? ("released" as const)
                    : ("summarized" as const),
                preview: "",
            };
        });
        let next: LedgerState = {
            ...state,
            surface,
            numbering: updatedNumbering,
            entries,
            lastSummary: confirmed
                ? {
                      seq: event.seq,
                      ids: affected.map((entry) => entry.id),
                      projection: pending.projection,
                      excludedIds: affected
                          .filter((entry) => committedExclusions.has(entry.id))
                          .map((entry) => entry.id),
                  }
                : state.lastSummary,
            summaryRequests:
                confirmed && state.activeStart !== null
                    ? state.summaryRequests.map((request) =>
                          (request.status === "queued" ||
                              (request.status === "failed" && request.retryable)) &&
                          request.seq < state.activeStart!
                              ? { ...request, status: "applied" as const, error: null }
                              : request,
                      )
                    : state.summaryRequests,
        };
        next = withAttachmentEntries(next);
        entries = next.entries;
        if (message !== null && op === "append") {
            const binding = state.numbering.slots.find((slot) => slot.sourceSeq === event.seq);
            if (
                binding !== undefined &&
                !CONTROL_TOOLS.has(binding.tool ?? "") &&
                hasReleasableBody(message)
            ) {
                entries = [
                    ...entries,
                    {
                        id: binding.id,
                        ownerId: null,
                        blockIndex: null,
                        role: binding.role,
                        sourceSeq: event.seq,
                        currentSeq: event.seq,
                        messageId: message.id,
                        callId: binding.callId,
                        tool: binding.tool,
                        preview: previewContent(message.content),
                        status: "available",
                        releaseMode: "summary",
                        admittedAtBusinessStep:
                            state.businessSteps + (state.pendingBusinessStep ? 1 : 0),
                        queuedAt: null,
                        reason: null,
                    },
                ];
                next = { ...next, entries };
            }
            if (event.type === "tool/result") {
                const intent = readIntent(event, binding?.tool ?? "unknown");
                if (intent !== null) next = applyIntent(next, intent, event.seq);
            }
        }
        return next;
    },
};
function applyIntent(
    state: LedgerState,
    intent: z.infer<typeof storedIntentSchema>,
    seq: number,
): LedgerState {
    if (intent.kind === "summary")
        return {
            ...state,
            summaryRequests: [
                ...state.summaryRequests,
                {
                    seq,
                    status: "queued",
                    error: null,
                    retryable: intent.version === 5,
                },
            ],
        };
    const marked = new Set(
        intent.version !== 2
            ? intent.ids.map(normalizeId)
            : intent.ids.flatMap((id) =>
                  state.numbering.slots
                      .filter((slot) => legacyId(slot.id) === id && slot.role === "tool")
                      .map((slot) => slot.id),
              ),
    );
    return {
        ...state,
        lastReleaseProgressSeq:
            intent.version === 6 &&
            state.entries.some((entry) => marked.has(entry.id) && entry.status === "available")
                ? seq
                : state.lastReleaseProgressSeq,
        entries: state.entries.map((entry) =>
            marked.has(entry.id) && entry.status === "available"
                ? {
                      ...entry,
                      status: "queued",
                      queuedAt: seq,
                      reason: intent.reason,
                      releaseMode: intent.version === 6 ? "inline" : "summary",
                  }
                : entry,
        ),
    };
}
