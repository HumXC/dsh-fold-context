import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import {
    SESSION_SUMMARY_SOURCE,
    SUBMIT_SUMMARY_TOOL,
    SUMMARY_SUBMISSION_KEY,
} from "./session-summary.js";
import { readSessionSummaryIdentity } from "./summary-policy.js";
import { COMPACT_TOOL, RECEIPT_KEY } from "./protocol.js";

export const SESSION_SUMMARY_CLEANUP_SOURCE = "fold-context-summary-cleanup";
const submissionReceipt = z
    .object({
        accepted: z.literal(true),
        checkpointId: z.string().min(1),
        status: z.literal("queued-for-validation"),
        [SUMMARY_SUBMISSION_KEY]: z
            .object({
                version: z.literal(1),
                hash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
    })
    .strict();
const compactIntent = z
    .object({
        version: z.literal(8),
        kind: z.literal("summary"),
        sessionId: z.string().min(1),
        ids: z.array(z.string()).length(0),
    })
    .strict();
const compactReceipt = z
    .object({
        status: z.literal("queued"),
        scope: z.literal(
            "official balanced historical prefix; includes unmarked history; latest balanced tail retained",
        ),
        [RECEIPT_KEY]: compactIntent,
    })
    .strict();
const compactMetadata = compactReceipt
    .extend({
        [RECEIPT_KEY]: compactIntent.extend({ reason: z.string().min(1).max(1000) }).strict(),
    })
    .strict();

function pureControlResult(
    event: Extract<SessionEvent, { type: "tool/result" }>,
    tool: string,
    checkpointId: string | null,
): boolean {
    const { message } = event.data;
    const block = message.content[0];
    if (message.isError || message.content.length !== 1 || block?.type !== "text") return false;
    let value: unknown;
    try {
        value = JSON.parse(block.text);
    } catch {
        return false;
    }
    // Both native renderers emit JSON.stringify(value); preserve duplicate-key or other extra text.
    if (block.text !== JSON.stringify(value)) return false;
    if (tool === SUBMIT_SUMMARY_TOOL) {
        const parsed = submissionReceipt.safeParse(value);
        return (
            parsed.success && parsed.data.checkpointId === checkpointId && event.data.meta == null
        );
    }
    const parsed = compactReceipt.safeParse(value);
    const meta = compactMetadata.safeParse(event.data.meta);
    if (!parsed.success || !meta.success) return false;
    const { reason: _reason, ...receipt } = meta.data[RECEIPT_KEY];
    return isDeepStrictEqual(parsed.data, { ...meta.data, [RECEIPT_KEY]: receipt });
}

const seq = z.number().int().nonnegative();
const stateSchema = z.object({
    surface: z.array(seq),
    owner: z.string().nullable(),
    notices: z.array(z.object({ seq, checkpointId: z.string() })),
    groups: z.array(
        z.object({
            checkpointId: z.string().nullable(),
            assistantSeq: seq,
            turn: seq,
            step: seq,
            calls: z.array(
                z.object({ id: z.string(), tool: z.string(), resultSeq: seq.nullable() }),
            ),
        }),
    ),
});
export type SessionSummaryControls = z.infer<typeof stateSchema>;
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextSessionSummaryControls: SessionSummaryControls;
    }
}

/** Track whole maintenance records. Mixed business content and PTC wrappers stay intact. */
export const sessionSummaryControlsProjection: ProjectionDefinition<"contextSessionSummaryControls"> =
    {
        key: "contextSessionSummaryControls",
        stateVersion: 3,
        stateSchema,
        init: () => ({ surface: [], owner: null, notices: [], groups: [] }),
        apply(state, event) {
            let { surface, owner, notices, groups } = state;
            if (event.surfaceOp === "append") surface = [...surface, event.seq];
            else if (event.surfaceOp !== undefined) {
                const first = surface.indexOf(event.surfaceOp.startSeq);
                const last = surface.indexOf(event.surfaceOp.endSeq);
                if (first < 0 || last < first)
                    throw new Error("fold-context: summary control replacement span missing");
                const removed = new Set(surface.slice(first, last + 1));
                notices = notices.filter((notice) => !removed.has(notice.seq));
                groups = groups.filter(
                    (group) =>
                        !removed.has(group.assistantSeq) &&
                        group.calls.every(
                            (call) => call.resultSeq === null || !removed.has(call.resultSeq),
                        ),
                );
                surface = [...surface.slice(0, first), event.seq, ...surface.slice(last + 1)];
            }
            if (
                event.type === "user/message" &&
                event.surfaceOp === "append" &&
                event.data.source.kind === SESSION_SUMMARY_SOURCE
            ) {
                const control = event.data.source.control;
                if (
                    control &&
                    ["request", "reminder", "committed", "failed", "cancelled"].includes(
                        control.phase,
                    )
                ) {
                    const checkpointId =
                        control.phase === "request"
                            ? control.plan?.checkpointId
                            : control.checkpointId;
                    if (typeof checkpointId === "string" && checkpointId.length > 0) {
                        notices = [...notices, { seq: event.seq, checkpointId }];
                        if (control.phase === "request") owner = checkpointId;
                        else if (control.phase !== "reminder" && owner === checkpointId)
                            owner = null;
                    }
                }
            }
            if (event.type === "assistant/message" && event.surfaceOp === "append") {
                const blocks = event.data.message.content;
                const calls = blocks.flatMap((block) =>
                    block.type === "tool-call"
                        ? [{ id: String(block.id), tool: block.name, resultSeq: null }]
                        : [],
                );
                if (
                    calls.length > 0 &&
                    new Set(calls.map((call) => call.id)).size === calls.length &&
                    (owner !== null || calls.every((call) => call.tool === COMPACT_TOOL)) &&
                    blocks.every(
                        (block) =>
                            block.type === "reasoning" ||
                            (block.type === "text" && block.text.trim().length === 0) ||
                            (block.type === "tool-call" &&
                                [SUBMIT_SUMMARY_TOOL, COMPACT_TOOL].includes(block.name)),
                    )
                ) {
                    groups = [
                        ...groups,
                        {
                            checkpointId: owner,
                            assistantSeq: event.seq,
                            turn: event.data.turn,
                            step: event.data.step,
                            calls,
                        },
                    ];
                }
            }
            if (event.type === "tool/result") {
                const message = event.data.message;
                const index = groups.findIndex(
                    (group) =>
                        group.turn === event.data.turn &&
                        group.step === event.data.step &&
                        group.calls.some(
                            (call) =>
                                call.resultSeq === null &&
                                call.id === message.source.callId &&
                                call.id === message.toolCallId,
                        ),
                );
                if (index >= 0) {
                    const group = groups[index]!;
                    const call = group.calls.find(
                        (candidate) => candidate.id === message.toolCallId,
                    )!;
                    if (!pureControlResult(event, call.tool, group.checkpointId)) {
                        groups = groups.filter((_candidate, i) => i !== index);
                    } else {
                        groups = [...groups];
                        groups[index] = {
                            ...group,
                            calls: group.calls.map((candidate) =>
                                candidate.id === message.toolCallId
                                    ? { ...candidate, resultSeq: event.seq }
                                    : candidate,
                            ),
                        };
                    }
                }
            }
            if (event.type === "compaction/summary") {
                const first = event.data.summary[0];
                const identity = readSessionSummaryIdentity(
                    first?.type === "text" ? first.text : undefined,
                    event.data.compactionId,
                );
                if (identity?.checkpointId === owner) owner = null;
            }
            if (event.type === "turn/end") owner = null;
            return surface === state.surface &&
                owner === state.owner &&
                notices === state.notices &&
                groups === state.groups
                ? state
                : { surface, owner, notices, groups };
        },
    };
