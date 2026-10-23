import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { FrozenSummaryRange } from "./summary-range.js";
import { readSessionSummaryIdentity } from "./summary-policy.js";

export const SESSION_SUMMARY_SOURCE = "fold-context-session-summary";
import { SUBMIT_SUMMARY_TOOL } from "./protocol.js";
export { SUBMIT_SUMMARY_TOOL } from "./protocol.js";
export const SUMMARY_SUBMISSION_KEY = "dshSessionSummary";
export const MAX_SUMMARY_CHARACTERS = 131072;
export const MAX_SUMMARY_STEPS = 8;

const seqSchema = z.number().int().nonnegative();
const idSchema = z.string().regex(/^[1-9]\d*$/);
const rangeSchema: z.ZodType<FrozenSummaryRange> = z.object({
    sessionId: z.string().min(1),
    seqs: z.array(seqSchema).min(1),
    nodes: z.array(
        z.object({ seq: seqSchema, messageId: z.string().nullable(), fingerprint: z.string() }),
    ),
    messages: z.array(
        z.object({
            seq: seqSchema,
            id: idSchema,
            role: z.enum(["user", "assistant", "tool"]),
            tool: z.string().nullable(),
        }),
    ),
    attachments: z.array(
        z.object({
            seq: seqSchema,
            id: idSchema,
            ownerId: idSchema,
            blockIndex: seqSchema,
            kind: z.enum(["image", "file"]),
        }),
    ),
    checkpoints: z.array(z.object({ seq: seqSchema, compactionId: z.string() })),
    unnumbered: z.array(z.object({ seq: seqSchema, kind: z.string() })),
});
export const sessionSummaryPlanSchema = z.object({
    checkpointId: z.string().min(1).max(128),
    range: rangeSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().nullable(),
    maxTokens: z.number().int().positive(),
    originalMaxTokens: z.number().int().positive().nullable(),
    originalReasoningEffort: z.string().nullable(),
    originalAdapterDefaults: z
        .object({
            reasoningEffort: z.literal(true).optional(),
            maxTokens: z.literal(true).optional(),
        })
        .passthrough()
        .nullable()
        .default(null),
    manual: z.boolean(),
    sourceCommandId: z.string().nullable(),
});
export type SessionSummaryPlan = z.infer<typeof sessionSummaryPlanSchema>;
export function matchesSessionSummaryLimits(
    config: {
        provider: string;
        model: string;
        maxTokens?: number | null;
        reasoningEffort?: string | null;
    },
    plan: SessionSummaryPlan,
): boolean {
    return (
        config.provider === plan.provider &&
        config.model === plan.model &&
        config.maxTokens === plan.maxTokens &&
        (config.reasoningEffort ?? null) === plan.reasoningEffort
    );
}
export const submissionArgumentsSchema = z
    .object({
        checkpointId: z.string().trim().min(1).max(128),
        summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARACTERS),
    })
    .strict();
export const summaryHash = (summary: string): string =>
    createHash("sha256").update(summary).digest("hex");

const controlSchema = z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("request"), plan: sessionSummaryPlanSchema }),
    z.object({
        phase: z.enum(["reminder", "cancelled", "failed", "committed"]),
        checkpointId: z.string(),
        reason: z.string().optional(),
    }),
]);
export type SessionSummaryControl = z.infer<typeof controlSchema>;
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-session-summary": {
            kind: typeof SESSION_SUMMARY_SOURCE;
            control: SessionSummaryControl;
        } & ContextFormed;
    }
}
const activeSchema = z.object({
    plan: sessionSummaryPlanSchema,
    phase: z.enum(["requested", "submitted", "committed", "cancelled", "failed"]),
    turn: seqSchema,
    steps: seqSchema,
    reminders: seqSchema,
    summary: z.string().nullable(),
    reason: z.string().nullable(),
    compactionId: z.string().nullable(),
    restorePending: z.boolean(),
    awaitingHeader: z.boolean(),
    ownedHeaderSeq: seqSchema.nullable().default(null),
    ownedConfigHash: z.string().nullable().default(null),
    ownedToolsHash: z.string().nullable().default(null),
});
const stateSchema = z.object({
    turn: seqSchema,
    cursor: z.number().int().min(-1),
    openTurn: z.boolean(),
    lastHeaderSeq: seqSchema.nullable(),
    surface: z.array(seqSchema),
    transaction: z.object({ id: z.string(), seq: seqSchema }).nullable(),
    active: activeSchema.nullable(),
    committedCheckpoints: z.array(z.string()),
    calls: z.record(z.string(), submissionArgumentsSchema),
    pendingCompaction: z.object({ id: z.string(), seq: seqSchema }).nullable(),
});
export type SessionSummaryState = z.infer<typeof stateSchema>;
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextSessionSummary: SessionSummaryState;
    }
}
function receipt(event: SessionEvent): unknown {
    if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") return null;
    if (event.type === "tool/result" ? event.data.message.isError : event.data.isError) return null;
    const blocks = event.type === "tool/result" ? event.data.message.content : event.data.content;
    try {
        return JSON.parse(
            blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
        );
    } catch {
        return null;
    }
}
function acceptedSubmission(
    event: SessionEvent,
    args: z.infer<typeof submissionArgumentsSchema>,
): boolean {
    const parsed = z
        .object({
            accepted: z.literal(true),
            checkpointId: z.string(),
            [SUMMARY_SUBMISSION_KEY]: z.object({ version: z.literal(1), hash: z.string() }),
        })
        .safeParse(receipt(event));
    return (
        parsed.success &&
        parsed.data.checkpointId === args.checkpointId &&
        parsed.data[SUMMARY_SUBMISSION_KEY].hash === summaryHash(args.summary)
    );
}
function isPending(state: SessionSummaryState): boolean {
    return state.active?.phase === "requested" || state.active?.phase === "submitted";
}
export function initialSessionSummaryState(): SessionSummaryState {
    return {
        turn: 0,
        cursor: -1,
        openTurn: false,
        lastHeaderSeq: null,
        surface: [],
        transaction: null,
        active: null,
        committedCheckpoints: [],
        calls: {},
        pendingCompaction: null,
    };
}
export const sessionSummaryProjection: ProjectionDefinition<"contextSessionSummary"> = {
    key: "contextSessionSummary",
    stateVersion: 6,
    stateSchema,
    init: initialSessionSummaryState,
    apply(state, event) {
        state = {
            ...state,
            cursor: event.seq,
            openTurn:
                event.type === "turn/start"
                    ? true
                    : event.type === "turn/end"
                      ? false
                      : state.openTurn,
            lastHeaderSeq: event.type === "request/header" ? event.seq : state.lastHeaderSeq,
        };
        let removed: number[] = [];
        if (event.surfaceOp === "append")
            state = { ...state, surface: [...state.surface, event.seq] };
        else if (event.surfaceOp !== undefined) {
            const first = state.surface.indexOf(event.surfaceOp.startSeq);
            const last = state.surface.indexOf(event.surfaceOp.endSeq);
            if (first < 0 || last < first)
                throw new Error("fold-context: summary plan surface span missing during replay");
            removed = state.surface.slice(first, last + 1);
            state = {
                ...state,
                surface: [
                    ...state.surface.slice(0, first),
                    event.seq,
                    ...state.surface.slice(last + 1),
                ],
            };
        }
        if (event.type === "compaction/start")
            return {
                ...state,
                transaction: { id: event.data.compactionId, seq: event.seq },
                pendingCompaction: null,
            };
        if (event.type === "request/header") {
            const active = state.active;
            if (!active) return state;
            const config = event.data.header.config;
            const pending = active.phase === "requested" || active.phase === "submitted";
            const expected = matchesSessionSummaryLimits(config, active.plan);
            const original =
                (config.maxTokens ?? null) === active.plan.originalMaxTokens &&
                (config.reasoningEffort ?? null) === active.plan.originalReasoningEffort &&
                JSON.stringify(event.data.header.adapterDefaults ?? {}) ===
                    JSON.stringify(active.plan.originalAdapterDefaults ?? {});
            const configHash = summaryHash(
                JSON.stringify({ config, defaults: event.data.header.adapterDefaults ?? {} }),
            );
            const toolsHash = summaryHash(JSON.stringify(event.data.header.tools ?? []));
            // Core can start a new series or rebuild tools without changing our
            // effective configuration. An explicit same-valued `change` with an
            // unchanged catalog still relinquishes ownership to its caller.
            const structural =
                active.restorePending &&
                active.ownedConfigHash === configHash &&
                (event.data.reason === "series" ||
                    event.data.reason === "resume" ||
                    (event.data.reason === "change" && active.ownedToolsHash !== toolsHash));
            const restorePending =
                pending && expected && !original && (active.awaitingHeader || structural);
            return {
                ...state,
                active: {
                    ...active,
                    awaitingHeader: false,
                    restorePending,
                    ownedHeaderSeq: restorePending ? event.seq : null,
                    ownedConfigHash: restorePending ? configHash : null,
                    ownedToolsHash: restorePending ? toolsHash : null,
                },
            };
        }
        if (event.type === "turn/start") return { ...state, turn: event.data.turn };
        if (event.type === "user/message" && event.data.source.kind === SESSION_SUMMARY_SOURCE) {
            const parsed = controlSchema.safeParse(event.data.source.control);
            if (!parsed.success) return state;
            const control = parsed.data;
            if (control.phase === "request") {
                if (
                    isPending(state) ||
                    state.active?.plan.checkpointId === control.plan.checkpointId
                )
                    return state;
                return {
                    ...state,
                    calls: {},
                    pendingCompaction: null,
                    active: {
                        plan: control.plan,
                        phase: "requested",
                        turn: state.turn,
                        steps: 0,
                        reminders: 0,
                        summary: null,
                        reason: null,
                        compactionId: null,
                        restorePending: false,
                        awaitingHeader: true,
                        ownedHeaderSeq: null,
                        ownedConfigHash: null,
                        ownedToolsHash: null,
                    },
                };
            }
            if (state.active?.plan.checkpointId !== control.checkpointId) return state;
            if (control.phase === "reminder")
                return {
                    ...state,
                    active: { ...state.active, reminders: state.active.reminders + 1 },
                };
            if (!isPending(state)) return state;
            // Only a verified official checkpoint can establish a successful commit.
            if (control.phase === "committed") return state;
            return {
                ...state,
                calls: {},
                active: { ...state.active, phase: control.phase, reason: control.reason ?? null },
            };
        }
        if (event.type === "step/end" && isPending(state))
            return { ...state, active: { ...state.active!, steps: state.active!.steps + 1 } };
        if (
            event.type === "tool/call" &&
            event.data.name === SUBMIT_SUMMARY_TOOL &&
            isPending(state)
        ) {
            try {
                const parsed = submissionArgumentsSchema.safeParse(
                    JSON.parse(event.data.arguments),
                );
                if (parsed.success)
                    return {
                        ...state,
                        calls: { ...state.calls, [event.data.callId]: parsed.data },
                    };
            } catch {
                /* Invalid calls cannot submit a checkpoint. */
            }
            return state;
        }
        if (event.type === "tool/result" || event.type === "tool/ptc-dispatch") {
            const args =
                event.type === "tool/result"
                    ? state.calls[event.data.message.source.callId]
                    : event.data.name === SUBMIT_SUMMARY_TOOL
                      ? submissionArgumentsSchema.safeParse(event.data.arguments).data
                      : undefined;
            const calls = { ...state.calls };
            if (event.type === "tool/result") delete calls[event.data.message.source.callId];
            if (
                !args ||
                state.active?.phase !== "requested" ||
                args.checkpointId !== state.active.plan.checkpointId ||
                !acceptedSubmission(event, args)
            )
                return { ...state, calls };
            return {
                ...state,
                calls,
                active: { ...state.active, phase: "submitted", summary: args.summary },
            };
        }
        if (
            event.type === "compaction/summary" &&
            state.active &&
            isPending(state) &&
            state.transaction?.id === event.data.compactionId
        ) {
            const first = event.data.summary[0];
            const identity = readSessionSummaryIdentity(
                first?.type === "text" ? first.text : undefined,
                event.data.compactionId,
            );
            if (identity?.checkpointId !== state.active.plan.checkpointId) return state;
            if (identity.execution === "session") {
                const body = event.data.summary[1];
                if (
                    state.active.phase !== "submitted" ||
                    event.data.summary.length !== 2 ||
                    body?.type !== "text" ||
                    body.text !== state.active.summary
                )
                    return state;
            } else if (state.active.phase !== "requested") return state;
            const seqs = event.data.shadowedSeqs;
            if (
                seqs.length !== state.active.plan.range.seqs.length ||
                seqs.some((seq, index) => seq !== state.active!.plan.range.seqs[index])
            )
                return state;
            return { ...state, pendingCompaction: { id: event.data.compactionId, seq: event.seq } };
        }
        if (
            event.type === "user/message" &&
            event.data.source.kind === "compact-checkpoint" &&
            state.active &&
            state.pendingCompaction &&
            event.seq === state.pendingCompaction.seq + 1 &&
            event.data.source.compactionId === state.pendingCompaction.id &&
            event.sourceEventSeqs?.some((seq) => seq === state.pendingCompaction!.seq) &&
            state.transaction?.id === state.pendingCompaction.id &&
            event.sourceEventSeqs.some((seq) => seq === state.transaction!.seq) &&
            removed.length === state.active.plan.range.seqs.length &&
            removed.every((seq, index) => seq === state.active!.plan.range.seqs[index])
        ) {
            return {
                ...state,
                calls: {},
                pendingCompaction: null,
                // A later failed preparation must not revoke an earlier successful cleanup.
                committedCheckpoints: [
                    ...new Set([...state.committedCheckpoints, state.active.plan.checkpointId]),
                ],
                active: {
                    ...state.active,
                    phase: "committed",
                    compactionId: event.data.source.compactionId,
                },
            };
        }
        if (event.type === "compaction/end" && state.transaction?.id === event.data.compactionId)
            return { ...state, transaction: null, pendingCompaction: null };
        if (
            event.type === "turn/end" &&
            isPending(state) &&
            event.data.turn === state.active!.turn
        ) {
            // Accepted work survives a crash or normal driver disposal. Explicit
            // user/parent/hook cancellation still retires the preparation.
            const recoverable =
                event.data.reason.kind === "interrupted" ||
                (event.data.reason.kind === "aborted" &&
                    event.data.reason.reason.kind === "disposed");
            if (recoverable && state.active!.phase === "submitted") return state;
            return {
                ...state,
                calls: {},
                active: {
                    ...state.active!,
                    phase: "cancelled",
                    reason: `turn-${event.data.reason.kind}`,
                },
            };
        }
        return state;
    },
};
