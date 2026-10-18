import type { Context } from "@deepseek-ai/cordis";
import { createDeveloperMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { ContextCompressionEngine } from "./engine.js";
import {
    contentHash,
    pureReleasePtc,
    RELEASE_CLEANUP_SOURCE,
    type ReleaseControlProof,
    type ReleaseControlState,
} from "../domain/release-controls.js";

export { RELEASE_CLEANUP_SOURCE } from "../domain/release-controls.js";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-release-cleanup": {
            kind: typeof RELEASE_CLEANUP_SOURCE;
            releaseControl?: ReleaseControlProof;
        } & ContextFormed;
    }
}

function controls(ctx: Context, session: Session): ReleaseControlState {
    const state = ctx.sessionProjections.stateOf(session, "contextReleaseControls");
    if (state === undefined) throw new Error("fold-context: release control projection is missing");
    return state;
}

/** Native empty developer records are durable but derive to no model message. */
export function registerReleaseControlCleanup(ctx: Context, engine: ContextCompressionEngine) {
    ctx.on("tools/result", (exec, result) => {
        if (
            exec.name !== "run_code" ||
            exec.parent !== undefined ||
            exec.agent === undefined ||
            result.isError ||
            result.concludesTurn ||
            (result.additionalContexts?.length ?? 0) > 0
        )
            return;
        const session = exec.agent.session;
        const candidates = controls(ctx, session).groups.filter((group) =>
            group.calls.some(
                (call) =>
                    call.id === exec.callId && call.name === "run_code" && call.resultSeq === null,
            ),
        );
        if (candidates.length !== 1) return;
        const group = candidates[0]!;
        const call = group.calls.find(
            (item) =>
                item.id === exec.callId && item.name === "run_code" && item.resultSeq === null,
        )!;
        if (!pureReleasePtc(call, result.value, result.content)) return;
        session.append(
            "developer/message",
            {
                turn: group.turn,
                step: group.step,
                message: createDeveloperMessage({
                    content: [],
                    source: {
                        kind: RELEASE_CLEANUP_SOURCE,
                        releaseControl: {
                            version: 1,
                            rootCallId: exec.callId,
                            childIds: call.children.map((child) => child.id),
                            contentHash: contentHash(result.content),
                        },
                    },
                }),
            },
            { surfaceOp: "append" },
        );
    });
    ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
        const config = await next();
        signal.throwIfAborted();
        const session = agent.session;
        const ledger = engine.state(session);
        if (ledger.activeStart !== null) return config;
        const entries = new Map(ledger.entries.map((entry) => [entry.id, entry]));
        let changed = false;
        for (const group of [...controls(ctx, session).groups].reverse()) {
            if (
                !group.calls.every(
                    (call) =>
                        call.resultSeq !== null &&
                        call.ids.length > 0 &&
                        call.ids.every((id) => {
                            const status = entries.get(id)?.status;
                            return status === "released" || status === "summarized";
                        }),
                )
            )
                continue;
            const nodes = [...session.surface.nodes];
            const startIndex = nodes.indexOf(SessionSeq(group.assistantSeq));
            const resultSeqs = group.calls.map((call) => SessionSeq(call.resultSeq!));
            const endIndex = Math.max(...resultSeqs.map((seq) => nodes.indexOf(seq)));
            if (
                startIndex < 0 ||
                endIndex <= startIndex ||
                resultSeqs.some((seq) => !nodes.includes(seq))
            )
                continue;
            const seqs = nodes.slice(startIndex, endIndex + 1);
            const expected = new Set([SessionSeq(group.assistantSeq), ...resultSeqs]);
            // Preserve every interleaved business message, including other plugin context.
            if (
                seqs.some(
                    (seq) =>
                        !expected.has(seq) &&
                        session.deriveEventMessage(session.eventAt(seq)!) !== null,
                )
            )
                continue;
            const start = seqs[0]!;
            const end = seqs.at(-1)!;
            session.append("compaction/prune", {
                shadowedRange: { start, end },
                shadowedSeqs: seqs,
                shadowedTokenCount: seqs.reduce((sum, seq) => {
                    const message = session.deriveEventMessage(session.eventAt(seq)!);
                    return sum + (message === null ? 0 : ctx.tokenMeter.estimateMessage(message));
                }, 0),
            });
            session.append(
                "developer/message",
                {
                    turn,
                    step,
                    message: createDeveloperMessage({
                        content: [],
                        source: { kind: RELEASE_CLEANUP_SOURCE },
                    }),
                },
                {
                    surfaceOp: { op: "replace", startSeq: start, endSeq: end },
                    sourceEventSeqs: seqs,
                },
            );
            changed = true;
        }
        if (changed) {
            await ctx.sessions.flush(session);
            signal.throwIfAborted();
        }
        return config;
    });
}
