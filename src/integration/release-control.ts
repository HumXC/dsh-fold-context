import type { Context } from "@deepseek-ai/cordis";
import { createDeveloperMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { ContextCompressionEngine } from "./engine.js";
import { observeSessionCut } from "./session-cut.js";
import { RELEASE_CLEANUP_SOURCE, type ReleaseControlState } from "../domain/release-controls.js";

export { RELEASE_CLEANUP_SOURCE } from "../domain/release-controls.js";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-release-cleanup": {
            kind: typeof RELEASE_CLEANUP_SOURCE;
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
    let enabled = true;
    ctx.effect(() => () => {
        enabled = false;
    });
    ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
        const config = await next();
        if (!enabled) return config;
        signal.throwIfAborted();
        const session = agent.session;
        using cut = await observeSessionCut(ctx, session, signal);
        signal.throwIfAborted();
        if (!enabled || !cut.current(session)) return config;
        const ledger = engine.state(session);
        if (ledger.activeStart !== null || engine.hasSessionSummaryWork(session)) return config;
        const entries = new Map(ledger.entries.map((entry) => [entry.id, entry]));
        let changed = false;
        let revision = cut.revision;
        const emptyNodes = new Set<number>();
        const messageAt = (seq: number) => {
            if (emptyNodes.has(seq)) return null;
            const event = cut.events.get(seq);
            return event === undefined ? undefined : session.deriveEventMessage(event);
        };
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
            if (seqs.some((seq) => !expected.has(seq) && messageAt(seq) !== null)) continue;
            if (!enabled || signal.aborted || session.seq !== revision) break;
            const start = seqs[0]!;
            const end = seqs.at(-1)!;
            session.append("compaction/prune", {
                shadowedRange: { start, end },
                shadowedSeqs: seqs,
                shadowedTokenCount: seqs.reduce((sum, seq) => {
                    const message = messageAt(seq);
                    return sum + (message ? ctx.tokenMeter.estimateMessage(message) : 0);
                }, 0),
            });
            const replacement = session.append(
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
            emptyNodes.add(replacement.seq);
            revision += 2;
            changed = true;
        }
        if (changed) {
            await ctx.sessions.flush(session);
            signal.throwIfAborted();
        }
        return config;
    });
}
