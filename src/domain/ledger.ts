import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
    COMPACT_TOOL,
    CONTROL_TOOLS,
    RECEIPT_KEY,
    RELEASE_TOOL,
    previewContent,
    releaseContent,
} from "./protocol.js";
import {
    foldNumbering,
    initialNumbering,
    numberingSchema,
    replaceNumberedSurface,
} from "./numbering.js";

const entrySchema = z.object({
    id: z.string(),
    sourceSeq: z.number().int().nonnegative(),
    currentSeq: z.number().int().nonnegative().nullable(),
    messageId: z.string(),
    callId: z.string(),
    tool: z.string(),
    preview: z.string(),
    status: z.enum(["available", "queued", "released", "summarized"]),
    queuedAt: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
});
export const intentSchema = z.object({
    version: z.literal(2),
    kind: z.enum(["release", "summary"]),
    sessionId: z.string(),
    ids: z.array(z.string().regex(/^§[1-9]\d*§$/)).max(128),
    reason: z.string().max(1000),
});
const summaryRequestSchema = z.object({
    seq: z.number().int().nonnegative(),
    status: z.enum(["queued", "applied", "failed"]),
    error: z.string().nullable(),
});
export const ledgerSchema = z.object({
    entries: z.array(entrySchema),
    numbering: numberingSchema,
    surface: z.array(z.number().int().nonnegative()),
    summaryRequests: z.array(summaryRequestSchema),
    activeStart: z.number().int().nonnegative().nullable(),
    lastSummary: z
        .object({ seq: z.number().int().nonnegative(), ids: z.array(z.string()) })
        .nullable(),
});
export type LedgerState = z.infer<typeof ledgerSchema>;
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextCompression: LedgerState;
    }
}

/** Receipt data comes only from a successful control tool event, never arbitrary conversation text. */
function readIntent(event: SessionEvent, name: string) {
    if (name !== RELEASE_TOOL && name !== COMPACT_TOOL) return null;
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") return null;
    if (event.type === "tool/result" ? event.data.message.isError : event.data.isError) return null;
    let value: unknown = event.type === "tool/result" ? event.data.meta : undefined;
    if (value === undefined) {
        const blocks =
            event.type === "tool/result" ? event.data.message.content : event.data.content;
        const text = blocks
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        try {
            value = JSON.parse(text);
        } catch {
            return null;
        }
    }
    if (value === null || typeof value !== "object" || !(RECEIPT_KEY in value)) return null;
    const parsed = intentSchema.safeParse(value[RECEIPT_KEY]);
    return parsed.success ? parsed.data : null;
}
export const ledgerProjection: ProjectionDefinition<"contextCompression"> = {
    key: "contextCompression",
    stateVersion: 4,
    stateSchema: ledgerSchema,
    init: () => ({
        entries: [],
        numbering: initialNumbering(),
        surface: [],
        summaryRequests: [],
        activeStart: null,
        lastSummary: null,
    }),
    apply(state, event) {
        const numbering = foldNumbering(state.numbering, event);
        if (numbering !== state.numbering) state = { ...state, numbering };
        if (event.type === "session/end-seed" && state.activeStart !== null) {
            const abandonedStart = state.activeStart;
            return {
                ...state,
                activeStart: null,
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
        if (event.type === "compaction/start") return { ...state, activeStart: event.seq };
        if (event.type === "compaction/end") {
            const start = state.activeStart;
            return {
                ...state,
                activeStart: null,
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
            const start = state.surface.indexOf(op.startSeq);
            const end = state.surface.indexOf(op.endSeq);
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
        let entries = state.entries.map((entry) => {
            if (entry.currentSeq === null || !removedSet.has(entry.currentSeq)) return entry;
            if (event.type === "tool/result" && affected.length === 1) {
                const content = event.data.message.content;
                const marker = releaseContent(entry.id)[0];
                const released =
                    entry.status === "queued" &&
                    content.length === 1 &&
                    content[0]?.type === "text" &&
                    marker?.type === "text" &&
                    content[0].text === marker.text &&
                    event.sourceEventSeqs?.some((seq) => seq === entry.currentSeq) === true;
                return {
                    ...entry,
                    currentSeq: event.seq,
                    messageId: event.data.message.id,
                    status: released ? ("released" as const) : entry.status,
                    preview: released ? "" : previewContent(event.data.message.content),
                };
            }
            return { ...entry, currentSeq: null, status: "summarized" as const, preview: "" };
        });
        const checkpoint =
            event.type === "user/message" && event.data.source.kind === "compact-checkpoint";
        let next: LedgerState = {
            ...state,
            surface,
            numbering: replaceNumberedSurface(state.numbering, event, removed),
            entries,
            lastSummary: checkpoint
                ? { seq: event.seq, ids: affected.map((entry) => entry.id) }
                : state.lastSummary,
            summaryRequests:
                checkpoint && state.activeStart !== null
                    ? state.summaryRequests.map((request) =>
                          request.status === "queued" && request.seq < state.activeStart!
                              ? { ...request, status: "applied" as const, error: null }
                              : request,
                      )
                    : state.summaryRequests,
        };
        if (event.type === "tool/result" && op === "append") {
            const callId = event.data.message.source.callId;
            const binding = state.numbering.slots.find((slot) => slot.sourceSeq === event.seq);
            if (binding === undefined) throw new Error("fold-context: result binding missing");
            const name = binding.tool ?? "unknown";
            if (!CONTROL_TOOLS.has(name)) {
                entries = [
                    ...entries,
                    {
                        id: binding.id,
                        sourceSeq: event.seq,
                        currentSeq: event.seq,
                        messageId: event.data.message.id,
                        callId,
                        tool: name,
                        preview: previewContent(event.data.message.content),
                        status: "available",
                        queuedAt: null,
                        reason: null,
                    },
                ];
                next = { ...next, entries };
            }
            const intent = readIntent(event, name);
            if (intent !== null) next = applyIntent(next, intent, event.seq);
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
            summaryRequests: [...state.summaryRequests, { seq, status: "queued", error: null }],
        };
    const marked = new Set(intent.ids);
    return {
        ...state,
        entries: state.entries.map((entry) =>
            marked.has(entry.id) && entry.status === "available"
                ? { ...entry, status: "queued", queuedAt: seq, reason: intent.reason }
                : entry,
        ),
    };
}
