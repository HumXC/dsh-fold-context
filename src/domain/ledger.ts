import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
    COMPACT_TOOL,
    CONTROL_TOOLS,
    RECEIPT_KEY,
    PTC_INTENT_SOURCE,
    RELEASE_TOOL,
    previewContent,
    normalizeId,
    hasReleasableBody,
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
import { RELEASE_TARGET_KEY, RELEASE_REPORT_VERSION } from "./release-report.js";
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
    version: z.literal(2),
    reasoning: z.enum(["preserve", "omit-from-summary"]),
    images: z.enum(["native", "references"]),
    attachments: z.array(
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
    ),
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
    releasedBlockIndex: z.number().int().nonnegative().nullable(),
    queuedAtBusinessStep: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
    releaseMode: z.enum(["inline", "summary"]).default("summary"),
    admittedAtBusinessStep: z.number().int().nonnegative().default(0),
});
export const intentSchema = z.object({
    version: z.union([z.literal(8), z.literal(9)]),
    kind: z.enum(["release", "summary"]),
    sessionId: z.string(),
    ids: z.array(z.string().regex(ID_PATTERN)).max(128),
    reason: z.string().max(1000),
});
const summaryRequestSchema = z.object({
    seq: z.number().int().nonnegative(),
    status: z.enum(["queued", "applied", "failed"]),
    error: z.string().nullable(),
    retryable: z.boolean().default(false),
});
export const ledgerSchema = z.object({
    entries: z.array(entrySchema),
    currentStep: z
        .object({ turn: z.number().int().nonnegative(), step: z.number().int().nonnegative() })
        .nullable()
        .default(null),
    businessSteps: z.number().int().nonnegative().default(0),
    pendingBusinessStep: z.boolean().default(false),
    sessionSummaryId: z.string().nullable().default(null),
    lastReleaseProgressSeq: z.number().int().nonnegative().default(0),
    reminderState: reminderStateSchema.default(initialReminderState),
    pendingInlineRelease: z
        .object({
            pruneSeq: z.number().int().nonnegative(),
            sourceSeq: z.number().int().nonnegative(),
            ids: z.array(z.string().regex(ID_PATTERN)),
        })
        .nullable(),
    lastSummaryFailure: z
        .object({
            seq: z.number().int().nonnegative(),
            error: z.string(),
            businessStep: z.number().int().nonnegative(),
        })
        .nullable(),
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
function intentReceipt(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return RECEIPT_KEY in value ? value[RECEIPT_KEY] : undefined;
}
function readResultIntent(event: Extract<SessionEvent, { type: "tool/result" }>, name: string) {
    if (name !== RELEASE_TOOL && name !== COMPACT_TOOL) return null;
    if (event.data.message.isError) return null;
    const parsed = intentSchema.safeParse(intentReceipt(event.data.meta));
    return parsed.success && parsed.data.version === 8 ? parsed.data : null;
}
function readPtcIntent(event: Extract<SessionEvent, { type: "tool/ptc-dispatch" }>) {
    if (event.data.name !== RELEASE_TOOL && event.data.name !== COMPACT_TOOL) return null;
    if (event.data.isError !== false) return null;
    // Historical v8 PTC logs carry the public receipt and take its omitted reason
    // from arguments. V9 intents are committed from final metadata in an empty
    // native developer record; the lossy dispatch body must never apply them again.
    const block = event.data.content[0];
    if (event.data.content.length !== 1 || block?.type !== "text") return null;
    const args = z
        .object({ reason: z.string().trim().min(1).max(1000) })
        .safeParse(event.data.arguments);
    if (!args.success) return null;
    let receipt: unknown;
    try {
        receipt = intentReceipt(JSON.parse(block.text));
    } catch {
        return null;
    }
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    const parsed = intentSchema.safeParse({ ...receipt, reason: args.data.reason });
    return parsed.success && parsed.data.version === 8 ? parsed.data : null;
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
                queuedAtBusinessStep: null,
                releasedBlockIndex: null,
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
    stateVersion: 20,
    stateSchema: ledgerSchema,
    init: () => ({
        entries: [],
        currentStep: null,
        businessSteps: 0,
        pendingBusinessStep: false,
        sessionSummaryId: null,
        lastReleaseProgressSeq: 0,
        reminderState: initialReminderState(),
        pendingInlineRelease: null,
        lastSummaryFailure: null,
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
        if (
            event.type === "user/message" &&
            event.data.source.kind === "fold-context-session-summary"
        ) {
            const control = event.data.source.control;
            if (control.phase === "request")
                state = { ...state, sessionSummaryId: control.plan.checkpointId };
            else if (
                (control.phase === "cancelled" || control.phase === "failed") &&
                control.checkpointId === state.sessionSummaryId
            )
                state = { ...state, sessionSummaryId: null };
        }
        if (event.type === "turn/end") state = { ...state, sessionSummaryId: null };
        if (event.type === "step/start")
            state = {
                ...state,
                currentStep: { turn: event.data.turn, step: event.data.step },
                pendingBusinessStep: false,
            };
        if (
            event.type === "step/end" ||
            event.type === "turn/end" ||
            event.type === "session/end-seed"
        )
            state = { ...state, currentStep: null };
        if (
            event.type === "assistant/message" &&
            event.surfaceOp === "append" &&
            state.sessionSummaryId === null
        ) {
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
        const reminderSource =
            event.type === "user/message" &&
            event.surfaceOp === "append" &&
            event.data.source.kind === ALLOCATION_SOURCE
                ? event.data.source
                : null;
        if (reminderSource !== null) {
            const parsed = reminderStateSchema.safeParse(reminderSource.releaseReminderState);
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
        if (event.type === "compaction/prune") {
            const parsed = z
                .object({
                    shadowedSeqs: z.tuple([z.number().int().nonnegative()]),
                    [RELEASE_TARGET_KEY]: z.object({
                        version: z.literal(RELEASE_REPORT_VERSION),
                        sourceSeq: z.number().int().nonnegative(),
                        ids: z.array(z.string().regex(ID_PATTERN)).min(1),
                        blocks: z.array(
                            z.object({
                                id: z.string().regex(ID_PATTERN),
                                index: z.number().int().nonnegative(),
                            }),
                        ),
                    }),
                })
                .safeParse(event.data);
            const target =
                parsed.success &&
                parsed.data.shadowedSeqs[0] === parsed.data[RELEASE_TARGET_KEY].sourceSeq
                    ? parsed.data[RELEASE_TARGET_KEY]
                    : null;
            const blocks = new Map(target?.blocks.map((block) => [block.id, block.index] as const));
            return {
                ...state,
                pendingInlineRelease:
                    target === null
                        ? null
                        : { pruneSeq: event.seq, sourceSeq: target.sourceSeq, ids: target.ids },
                entries:
                    target === null
                        ? state.entries
                        : state.entries.map((entry) =>
                              target.ids.includes(entry.id)
                                  ? { ...entry, releasedBlockIndex: blocks.get(entry.id) ?? null }
                                  : entry,
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
                policy === null || policy?.execution === "session"
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
                lastSummaryFailure:
                    event.data.error === undefined
                        ? state.lastSummaryFailure
                        : {
                              seq: event.seq,
                              error: event.data.error,
                              businessStep: state.businessSteps,
                          },
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
            const intent = readPtcIntent(event);
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
        if (confirmed) state = { ...state, sessionSummaryId: null };
        const committedExclusions = confirmed ? new Set(pending.excludedIds) : new Set<string>();
        const message =
            event.type === "user/message"
                ? event.data
                : event.type === "assistant/message" || event.type === "tool/result"
                  ? event.data.message
                  : null;
        const pendingRelease = state.pendingInlineRelease;
        const confirmedInline =
            !checkpoint &&
            pendingRelease !== null &&
            event.seq === pendingRelease.pruneSeq + 1 &&
            removed.length === 1 &&
            removed[0] === pendingRelease.sourceSeq &&
            event.sourceEventSeqs?.some((seq) => seq === pendingRelease.sourceSeq) &&
            message !== null &&
            (message.role === "user" || message.role === "tool");
        const inlineReleased = new Set(
            confirmedInline
                ? affected
                      .filter(
                          (entry) =>
                              // A confirmed native prune/replacement is already a durable
                              // release fact, even when its old ordinary intent is unreadable.
                              pendingRelease.ids.includes(entry.id) &&
                              (entry.role === "tool" ||
                                  ((entry.role === "image" || entry.role === "file") &&
                                      entry.releasedBlockIndex !== null)),
                      )
                      .map((entry) => entry.id)
                : [],
        );
        const updatedNumbering = replaceNumberedSurface(
            state.numbering,
            event,
            removed,
            inlineReleased,
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
                    releaseMode: inlineReleased.has(entry.id)
                        ? ("inline" as const)
                        : entry.releaseMode,
                    preview: "",
                    currentSeq: inlineReleased.has(entry.id) ? event.seq : null,
                };
            }
            if (confirmedInline && entry.status === "released" && entry.releasedBlockIndex !== null)
                return { ...entry, currentSeq: event.seq };
            if (!checkpoint && (entry.role === "image" || entry.role === "file")) {
                const attachment = updatedNumbering.attachments.find(
                    (item) => item.id === entry.id,
                );
                if (attachment?.currentSeq != null)
                    return {
                        ...entry,
                        currentSeq: attachment.currentSeq,
                        releasedBlockIndex: null,
                    };
            }
            if (
                !checkpoint &&
                affected.filter((item) => item.role !== "image" && item.role !== "file").length ===
                    1 &&
                message?.role === entry.role &&
                message.id === entry.messageId
            ) {
                return {
                    ...entry,
                    currentSeq: event.seq,
                    preview: entry.status === "released" ? "" : previewContent(message.content),
                };
            }
            return {
                ...entry,
                currentSeq: null,
                releasedBlockIndex: null,
                status:
                    entry.status === "released" || committedExclusions.has(entry.id)
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
            pendingInlineRelease: null,
            lastSummaryFailure: confirmed ? null : state.lastSummaryFailure,
            lastReleaseProgressSeq:
                inlineReleased.size > 0 || (confirmed && committedExclusions.size > 0)
                    ? event.seq
                    : state.lastReleaseProgressSeq,
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
                        queuedAtBusinessStep: null,
                        releasedBlockIndex: null,
                        reason: null,
                    },
                ];
                next = { ...next, entries };
            }
            if (event.type === "tool/result") {
                const intent = readResultIntent(event, binding?.tool ?? "unknown");
                if (intent !== null) next = applyIntent(next, intent, event.seq);
            }
        }
        if (
            event.type === "developer/message" &&
            event.surfaceOp === "append" &&
            event.data.message.content.length === 0 &&
            event.data.message.source.kind === PTC_INTENT_SOURCE
        ) {
            const source = event.data.message.source;
            const intent = intentSchema.safeParse(source.intent);
            if (
                intent.success &&
                intent.data.version === 9 &&
                ((source.tool === RELEASE_TOOL && intent.data.kind === "release") ||
                    (source.tool === COMPACT_TOOL && intent.data.kind === "summary"))
            )
                next = applyIntent(next, intent.data, event.seq);
        }
        return next;
    },
};
function applyIntent(
    state: LedgerState,
    intent: z.infer<typeof intentSchema>,
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
                    retryable: true,
                },
            ],
        };
    const marked = new Set(intent.ids.map(normalizeId));
    return {
        ...state,
        lastReleaseProgressSeq: state.entries.some(
            (entry) => marked.has(entry.id) && entry.status === "available",
        )
            ? seq
            : state.lastReleaseProgressSeq,
        entries: state.entries.map((entry) =>
            marked.has(entry.id) && entry.status === "available"
                ? {
                      ...entry,
                      status: "queued",
                      queuedAt: seq,
                      queuedAtBusinessStep: state.businessSteps,
                      reason: intent.reason,
                      releaseMode: "inline",
                  }
                : entry,
        ),
    };
}
