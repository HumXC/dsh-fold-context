import type { Context } from "@deepseek-ai/cordis";
import { createDeveloperMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { SESSION_SUMMARY_CLEANUP_SOURCE } from "../domain/session-summary-controls.js";
import { COMPACT_TOOL } from "../domain/protocol.js";
import type { ContextCompressionEngine } from "./engine.js";
import { observeSessionCut } from "./session-cut.js";

declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-summary-cleanup": {
            kind: typeof SESSION_SUMMARY_CLEANUP_SOURCE;
        } & ContextFormed;
    }
}

/** Prune the model surface, leaving append-origin Chat/Trajectory records unchanged. */
export function registerSessionSummaryCleanup(ctx: Context, engine: ContextCompressionEngine) {
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
        const summary = ctx.sessionProjections.stateOf(session, "contextSessionSummary");
        const ledger = engine.state(session);
        if (
            summary?.transaction != null ||
            ledger.activeStart !== null ||
            engine.hasSessionSummaryWork(session)
        )
            return config;
        const committed = new Set(summary?.committedCheckpoints ?? []);
        const appliedRequests = new Set(
            ledger.summaryRequests
                .filter((request) => request.status === "applied")
                .map((request) => request.seq),
        );
        const controls = ctx.sessionProjections.stateOf(session, "contextSessionSummaryControls");
        if (!controls) throw new Error("fold-context: summary control projection is missing");
        let changed = false;
        let revision = cut.revision;
        const emptyNodes = new Set<number>();
        const messageAt = (seq: number) => {
            if (emptyNodes.has(seq)) return null;
            const event = cut.events.get(seq);
            return event === undefined ? undefined : session.deriveEventMessage(event);
        };
        const prune = (seqs: readonly number[]) => {
            if (!enabled || signal.aborted || session.seq !== revision) return;
            const start = SessionSeq(seqs[0]!);
            const end = SessionSeq(seqs.at(-1)!);
            session.append("compaction/prune", {
                shadowedRange: { start, end },
                shadowedSeqs: seqs.map(SessionSeq),
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
                        source: { kind: SESSION_SUMMARY_CLEANUP_SOURCE },
                    }),
                },
                {
                    surfaceOp: { op: "replace", startSeq: start, endSeq: end },
                    sourceEventSeqs: seqs.map(SessionSeq),
                },
            );
            emptyNodes.add(replacement.seq);
            revision += 2;
            changed = true;
        };
        // Removing notices first can expose a safely paired control-only group.
        for (const notice of [...controls.notices].reverse()) {
            if (
                committed.has(notice.checkpointId) &&
                session.surface.nodes.includes(SessionSeq(notice.seq))
            )
                prune([notice.seq]);
        }
        for (const group of [...controls.groups].reverse()) {
            if (
                group.calls.some(
                    (call) =>
                        call.resultSeq === null ||
                        (call.tool === COMPACT_TOOL
                            ? !appliedRequests.has(call.resultSeq)
                            : group.checkpointId === null || !committed.has(group.checkpointId)),
                )
            )
                continue;
            const nodes = session.surface.nodes;
            const first = nodes.indexOf(SessionSeq(group.assistantSeq));
            const last = Math.max(
                ...group.calls.map((call) => nodes.indexOf(SessionSeq(call.resultSeq!))),
            );
            const expected = new Set([
                group.assistantSeq,
                ...group.calls.map((call) => call.resultSeq!),
            ]);
            if (
                first < 0 ||
                last <= first ||
                [...expected].some((seq) => !nodes.includes(SessionSeq(seq)))
            )
                continue;
            const span = nodes.slice(first, last + 1);
            if (span.some((seq) => !expected.has(seq) && messageAt(seq) !== null)) continue;
            prune(span);
        }
        if (changed) {
            await ctx.sessions.flush(session);
            signal.throwIfAborted();
        }
        return config;
    });
}
