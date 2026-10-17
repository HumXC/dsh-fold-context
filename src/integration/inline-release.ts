import type { Context } from "@deepseek-ai/cordis";
import { isDeepStrictEqual } from "node:util";
import {
    createUserMessage,
    freezeMessage,
    type ContentBlock,
    type ContextFormed,
} from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { LedgerState } from "../domain/ledger.js";
import { inlineReleaseContent, normalizeId, RELEASE_TOOL } from "../domain/protocol.js";
import { canReleaseInline } from "../domain/release.js";
import { RELEASE_REPORT_KEY, releaseReport } from "../domain/release-report.js";

export const RELEASE_CLEANUP_SOURCE = "fold-context-release-cleanup";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-release-cleanup": { kind: typeof RELEASE_CLEANUP_SOURCE } & ContextFormed;
    }
}

type Entry = LedgerState["entries"][number];

interface Replacement {
    event: SessionEvent<"tool/result" | "user/message">;
    content: ContentBlock[];
    releasedIds: string[];
}
function planReplacements(session: Session, state: LedgerState): Replacement[] {
    const groups = new Map<number, Entry[]>();
    for (const entry of state.entries) {
        if (
            entry.status !== "queued" ||
            entry.releaseMode !== "inline" ||
            !canReleaseInline(state, entry)
        )
            continue;
        const entries = groups.get(entry.currentSeq!) ?? [];
        entries.push(entry);
        groups.set(entry.currentSeq!, entries);
    }
    const plans: Replacement[] = [];
    for (const [seq, entries] of groups) {
        const event = session.eventAt(SessionSeq(seq));
        if (event?.type !== "tool/result" && event?.type !== "user/message") continue;
        if (session.deriveEventMessage(event) === null) continue;
        // Edit persisted native blocks; file projections may expose text handles instead.
        const original = event.type === "user/message" ? event.data : event.data.message;
        const whole = entries.find((entry) => entry.role === "tool");
        if (whole !== undefined && event.type === "tool/result") {
            plans.push({
                event,
                content: inlineReleaseContent(whole.id),
                releasedIds: [
                    whole.id,
                    ...state.entries
                        .filter(
                            (entry) =>
                                entry.ownerId === whole.id &&
                                entry.status !== "released" &&
                                entry.status !== "summarized",
                        )
                        .map((entry) => entry.id),
                ],
            });
            continue;
        }
        const blocks = new Map<number, string>();
        for (const entry of entries) {
            const item = state.numbering.attachments.find((item) => item.id === entry.id);
            if (item?.currentBlockIndex == null || item.currentSeq !== seq) continue;
            const block = original.content[item.currentBlockIndex];
            if (
                (block?.type === "image" || block?.type === "file") &&
                block.type === item.block.type &&
                isDeepStrictEqual(block.attachment, item.block.attachment)
            ) {
                blocks.set(item.currentBlockIndex, entry.id);
            }
        }
        if (blocks.size > 0)
            plans.push({
                event,
                releasedIds: [...blocks.values()],
                content: original.content.flatMap((block, index) => {
                    const id = blocks.get(index);
                    return id === undefined ? [block] : inlineReleaseContent(id);
                }),
            });
    }
    return plans;
}

function successfulReleaseTargets(event: SessionEvent<"tool/result">, state: LedgerState): boolean {
    if (event.data.message.isError) return false;
    let value: unknown = event.data.meta;
    if (value === undefined) {
        try {
            value = JSON.parse(
                event.data.message.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join(""),
            );
        } catch {
            return false;
        }
    }
    if (
        value === null ||
        typeof value !== "object" ||
        !("accepted" in value) ||
        value.accepted !== true
    )
        return false;
    if (
        !("queued" in value) ||
        !("settled" in value) ||
        !Array.isArray(value.queued) ||
        !Array.isArray(value.settled)
    )
        return false;
    const ids: unknown[] = [...value.queued, ...value.settled];
    return (
        ids.length > 0 &&
        ids.every((id) => {
            if (typeof id !== "string") return false;
            try {
                const entry = state.entries.find((entry) => entry.id === normalizeId(id));
                return entry?.status === "released" || entry?.status === "summarized";
            } catch {
                return false;
            }
        })
    );
}

/** Piggyback only on an existing rewrite, without moving its earliest changed position. */
function cleanupReceipts(
    ctx: Context,
    session: Session,
    state: LedgerState,
    earliestIndex: number,
): number {
    const nodes = [...session.surface.nodes];
    const groups: { start: number; end: number }[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const event = session.eventAt(nodes[index]!);
        if (
            event?.type !== "assistant/message" ||
            event.data.message.source.replayState !== undefined
        )
            continue;
        const blocks = event.data.message.content;
        if (
            blocks.length === 0 ||
            !blocks.every((b) => b.type === "tool-call" && b.name === RELEASE_TOOL)
        )
            continue;
        const pending = new Set(blocks.map((b) => (b.type === "tool-call" ? b.id : "")));
        let end = index;
        for (let next = index + 1; next < nodes.length && pending.size > 0; next++) {
            const result = session.eventAt(nodes[next]!);
            if (
                result?.type !== "tool/result" ||
                !pending.has(result.data.message.source.callId) ||
                !successfulReleaseTargets(result, state)
            )
                break;
            pending.delete(result.data.message.source.callId);
            end = next;
        }
        if (pending.size === 0) groups.push({ start: index, end });
    }
    let count = 0;
    for (const group of groups.slice(0, -2).reverse()) {
        if (group.start < earliestIndex) continue;
        const seqs = nodes.slice(group.start, group.end + 1);
        const start = seqs[0]!;
        const end = seqs.at(-1)!;
        session.append("compaction/prune", {
            shadowedRange: { start, end },
            shadowedSeqs: seqs,
            shadowedTokenCount: seqs.reduce((sum, seq) => {
                const event = session.eventAt(seq)!;
                const message = session.deriveEventMessage(event);
                return sum + (message === null ? 0 : ctx.tokenMeter.estimateMessage(message));
            }, 0),
        });
        session.append(
            "user/message",
            createUserMessage({
                content: [
                    {
                        type: "text",
                        text: "[Earlier successful release calls omitted; R placeholders and context_status report applied releases.]",
                    },
                ],
                source: {
                    kind: RELEASE_CLEANUP_SOURCE,
                    form: "notice",
                    summary: "Completed release receipts",
                },
            }),
            { surfaceOp: { op: "replace", startSeq: start, endSeq: end }, sourceEventSeqs: seqs },
        );
        count++;
    }
    return count;
}

/** One synchronous boundary pass: no model request or await can observe a half-applied batch. */
export function commitInlineReleases(
    ctx: Context,
    session: Session,
    state: LedgerState,
    signal: AbortSignal,
): number {
    signal.throwIfAborted();
    if (state.activeStart !== null) return 0;
    const plans = planReplacements(session, state);
    if (plans.length === 0) return 0;
    const earliestIndex = Math.min(...plans.map(({ event }) => state.surface.indexOf(event.seq)));
    const releasedIds = new Set(plans.flatMap((plan) => plan.releasedIds));
    const report = {
        ...releaseReport(state, releasedIds, `${session.id}:${session.seq}`),
        // Price each rewritten native message once, including its replacement placeholders.
        tokenEstimate: plans.reduce(
            (total, { event, content }) => {
                const original = event.type === "tool/result" ? event.data.message : event.data;
                return {
                    beforeTokens: total.beforeTokens + ctx.tokenMeter.estimateMessage(original),
                    afterTokens:
                        total.afterTokens +
                        ctx.tokenMeter.estimateMessage(freezeMessage({ ...original, content })),
                };
            },
            { beforeTokens: 0, afterTokens: 0 },
        ),
    };
    for (const [index, { event, content }] of plans.entries()) {
        const final = index === plans.length - 1;
        const seq = event.seq;
        const original = session.deriveEventMessage(event)!;
        const prune = {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
            ...(final
                ? {
                      [RELEASE_REPORT_KEY]: {
                          ...report,
                          completionSeq: Number(session.seq) + 1,
                          targetSeq: seq,
                      },
                  }
                : {}),
        };
        session.append("compaction/prune", prune);
        const opts = {
            surfaceOp: { op: "replace" as const, startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
        };
        if (event.type === "tool/result") {
            session.append(
                "tool/result",
                {
                    ...event.data,
                    message: freezeMessage({
                        ...event.data.message,
                        content,
                        source: event.data.message.source,
                    }),
                },
                opts,
            );
        } else {
            session.append(
                "user/message",
                freezeMessage({
                    ...event.data,
                    content,
                    source: event.data.source,
                }),
                opts,
            );
        }
    }
    const committed = ctx.sessionProjections.stateOf(session, "contextCompression");
    if (committed === undefined)
        throw new Error("fold-context: ledger unavailable after inline release");
    cleanupReceipts(ctx, session, committed, earliestIndex);
    return plans.length;
}
