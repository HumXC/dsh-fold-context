import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { ID_PATTERN, normalizeId, RECEIPT_KEY, RELEASE_TOOL } from "./protocol.js";

export const RELEASE_CLEANUP_SOURCE = "fold-context-release-cleanup";
const idSchema = z.string().regex(ID_PATTERN).transform(normalizeId);
const planSchema = z
    .object({
        accepted: z.literal(true),
        unknown: z.array(z.string()).length(0),
        unsupported: z.array(z.string()).length(0),
        queued: z.array(idSchema),
        settled: z.array(idSchema),
        [RECEIPT_KEY]: z.unknown().optional(),
    })
    .strict();

function releaseTargets(value: unknown): string[] | null {
    const parsed = planSchema.safeParse(value);
    if (!parsed.success) return null;
    const ids = [...new Set([...parsed.data.queued, ...parsed.data.settled])];
    return ids.length > 0 ? ids : null;
}
function textValue(content: readonly ContentBlock[]): unknown {
    if (content.length === 0 || content.some((block) => block.type !== "text")) return undefined;
    try {
        return JSON.parse(
            content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        );
    } catch {
        return undefined;
    }
}
function contentHash(content: readonly ContentBlock[]): string {
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

const callSchema = z
    .object({
        id: z.string(),
        resultSeq: z.number().int().nonnegative().nullable(),
        ids: z.array(z.string()),
        resultHash: z.string().nullable(),
    })
    .strict();
const groupSchema = z
    .object({
        assistantSeq: z.number().int().nonnegative(),
        turn: z.number().int().nonnegative(),
        step: z.number().int().nonnegative(),
        calls: z.array(callSchema),
    })
    .strict();
const stateSchema = z
    .object({
        surface: z.array(z.number().int().nonnegative()),
        groups: z.array(groupSchema),
    })
    .strict();
export type ReleaseControlState = z.infer<typeof stateSchema>;
type ReleaseControlCall = ReleaseControlState["groups"][number]["calls"][number];

declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextReleaseControls: ReleaseControlState;
    }
}

/** Only direct context_release-only assistant groups can become cleanup candidates. */
export const releaseControlProjection: ProjectionDefinition<"contextReleaseControls"> = {
    key: "contextReleaseControls",
    stateVersion: 2,
    stateSchema,
    init: () => ({ surface: [], groups: [] }),
    apply(state, event) {
        let groups = state.groups;
        let surface = state.surface;
        if (event.surfaceOp !== undefined) {
            if (event.surfaceOp === "append") surface = [...surface, event.seq];
            else {
                const start = surface.indexOf(event.surfaceOp.startSeq);
                const end = surface.indexOf(event.surfaceOp.endSeq);
                if (start < 0 || end < start)
                    throw new Error("fold-context: control replacement span missing");
                const removed = new Set(surface.slice(start, end + 1));
                groups = groups.filter(
                    (group) =>
                        !removed.has(group.assistantSeq) &&
                        group.calls.every(
                            (call) =>
                                call.resultSeq === null ||
                                !removed.has(call.resultSeq) ||
                                (event.type === "tool/result" &&
                                    event.data.message.source.callId === call.id),
                        ),
                );
                surface = [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)];
            }
        }
        if (event.type === "assistant/message" && event.surfaceOp === "append") {
            const blocks = event.data.message.content;
            if (
                blocks.length > 0 &&
                blocks.every((block) => block.type === "tool-call" && block.name === RELEASE_TOOL)
            ) {
                const calls: ReleaseControlCall[] = blocks.flatMap((block) =>
                    block.type === "tool-call"
                        ? [{ id: block.id, resultSeq: null, ids: [], resultHash: null }]
                        : [],
                );
                if (new Set(calls.map((call) => call.id)).size === calls.length)
                    groups = [
                        ...groups,
                        {
                            assistantSeq: event.seq,
                            turn: event.data.turn,
                            step: event.data.step,
                            calls,
                        },
                    ];
            }
        }
        if (event.type === "tool/result") {
            groups = groups.flatMap((group) => {
                if (group.turn !== event.data.turn || group.step !== event.data.step)
                    return [group];
                const index = group.calls.findIndex(
                    (call) => call.id === event.data.message.source.callId,
                );
                if (index < 0) return [group];
                const call = group.calls[index]!;
                if (event.data.message.isError || event.data.message.toolCallId !== call.id)
                    return [];
                if (
                    call.resultSeq !== null &&
                    call.resultHash !== contentHash(event.data.message.content)
                )
                    return [];
                const value = textValue(event.data.message.content);
                const meta = event.data.meta;
                if (meta !== undefined) {
                    const parsed = z
                        .object({
                            [RECEIPT_KEY]: z
                                .object({ reason: z.string().min(1).max(1000) })
                                .passthrough()
                                .nullable(),
                        })
                        .passthrough()
                        .safeParse(meta);
                    if (!parsed.success) return [];
                    const receipt = parsed.data[RECEIPT_KEY];
                    const { reason: _reason, ...publicReceipt } = receipt ?? {};
                    const publicMeta = {
                        ...parsed.data,
                        [RECEIPT_KEY]: receipt === null ? null : publicReceipt,
                    };
                    if (!isDeepStrictEqual(publicMeta, value)) return [];
                }
                const ids = releaseTargets(value);
                if (ids === null) return [];
                const calls = [...group.calls];
                calls[index] = {
                    ...call,
                    resultSeq: event.seq,
                    ids,
                    resultHash: contentHash(event.data.message.content),
                };
                return [{ ...group, calls }];
            });
        }
        return groups === state.groups && surface === state.surface ? state : { groups, surface };
    },
};
