import type { Context } from "@deepseek-ai/cordis";
import { isDeepStrictEqual } from "node:util";
import { freezeMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { LedgerState } from "../domain/ledger.js";
import type { ReleaseBatchPlan } from "../domain/scheduler.js";
import { inlineReleaseContent } from "../domain/protocol.js";
import { canReleaseInline } from "../domain/release.js";
import {
    RELEASE_REPORT_KEY,
    RELEASE_TARGET_KEY,
    RELEASE_REPORT_VERSION,
    releaseReport,
} from "../domain/release-report.js";
import type { SessionCut } from "./session-cut.js";

export { RELEASE_CLEANUP_SOURCE } from "../domain/release-controls.js";

type Entry = LedgerState["entries"][number];

interface Replacement {
    event: SessionEvent<"tool/result" | "user/message">;
    content: ContentBlock[];
    releasedIds: string[];
}
function planReplacements(session: Session, state: LedgerState, cut: SessionCut): Replacement[] {
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
        const event = cut.events.get(seq);
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

export interface InlineReleaseEstimate {
    readonly revision: number;
    readonly replacementCount: number;
    readonly replacements: readonly {
        seq: number;
        beforeTokens: number;
        afterTokens: number;
        releasableTokens: number;
    }[];
    readonly releasedIds: readonly string[];
    readonly beforeTokens: number;
    readonly afterTokens: number;
}

/** Preflight prices each rewritten message once, even for owner + attachment marks. */
export function estimateInlineReleases(
    ctx: Context,
    session: Session,
    state: LedgerState,
    cut: SessionCut,
): InlineReleaseEstimate {
    if (!cut.current(session)) throw new Error("fold-context: release observation changed");
    const plans = state.activeStart === null ? planReplacements(session, state, cut) : [];
    const replacements = plans.map(({ event, content, releasedIds }) => {
        const original = event.type === "tool/result" ? event.data.message : event.data;
        const beforeTokens = ctx.tokenMeter.estimateMessage(original);
        const afterTokens = ctx.tokenMeter.estimateMessage(freezeMessage({ ...original, content }));
        const whole = state.entries.some(
            (entry) => entry.role === "tool" && releasedIds.includes(entry.id),
        );
        const removed = new Set(
            state.numbering.attachments.flatMap((item) =>
                item.currentSeq === event.seq &&
                item.currentBlockIndex !== null &&
                releasedIds.includes(item.id)
                    ? [item.currentBlockIndex]
                    : [],
            ),
        );
        const retainedTokens = whole
            ? 0
            : ctx.tokenMeter.estimateMessage(
                  freezeMessage({
                      ...original,
                      content: content.filter((_block, index) => !removed.has(index)),
                  }),
              );
        return {
            seq: Number(event.seq),
            beforeTokens,
            afterTokens,
            releasableTokens: Math.max(0, beforeTokens - retainedTokens),
        };
    });
    const estimate = replacements.reduce(
        (total, replacement) => ({
            beforeTokens: total.beforeTokens + replacement.beforeTokens,
            afterTokens: total.afterTokens + replacement.afterTokens,
        }),
        { beforeTokens: 0, afterTokens: 0 },
    );
    return {
        revision: cut.revision,
        replacementCount: plans.length,
        replacements,
        releasedIds: [...new Set(plans.flatMap((plan) => plan.releasedIds))],
        ...estimate,
    };
}

/** One synchronous boundary pass: no model request or await can observe a half-applied batch. */
export function commitInlineReleases(
    ctx: Context,
    session: Session,
    state: LedgerState,
    signal: AbortSignal,
    permit: ReleaseBatchPlan,
    cut: SessionCut,
): number {
    signal.throwIfAborted();
    if (
        state.activeStart !== null ||
        permit.decision !== "execute" ||
        permit.revision !== session.seq ||
        !cut.current(session)
    )
        return 0;
    const permitted = new Set(permit.selectedSeqs);
    const plans = planReplacements(session, state, cut).filter((plan) =>
        permitted.has(Number(plan.event.seq)),
    );
    if (plans.length === 0 || plans.length !== permitted.size) return 0;
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
    signal.throwIfAborted();
    if (!cut.current(session)) return 0;
    for (const [index, { event, content, releasedIds: targetIds }] of plans.entries()) {
        const final = index === plans.length - 1;
        const seq = event.seq;
        const original = session.deriveEventMessage(event)!;
        const prune = {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
            [RELEASE_TARGET_KEY]: {
                version: RELEASE_REPORT_VERSION,
                sourceSeq: seq,
                ids: targetIds,
                blocks: state.numbering.attachments.flatMap((item) =>
                    item.currentSeq === seq &&
                    item.currentBlockIndex !== null &&
                    targetIds.includes(item.id) &&
                    !targetIds.includes(item.ownerId)
                        ? [{ id: item.id, index: item.currentBlockIndex }]
                        : [],
                ),
            },
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
    return plans.length;
}
