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

export function releaseTargets(value: unknown): string[] | null {
    const parsed = planSchema.safeParse(value);
    if (!parsed.success) return null;
    const ids = [...new Set([...parsed.data.queued, ...parsed.data.settled])];
    return ids.length > 0 ? ids : null;
}
export function textValue(content: readonly ContentBlock[]): unknown {
    if (content.length === 0 || content.some((block) => block.type !== "text")) return undefined;
    try {
        return JSON.parse(
            content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        );
    } catch {
        return undefined;
    }
}
export function contentHash(content: readonly ContentBlock[]): string {
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

const childSchema = z.object({
    id: z.string(),
    parent: z.string(),
    args: z.unknown(),
    done: z.boolean(),
    value: z.unknown(),
    ids: z.array(z.string()),
});
const callSchema = z.object({
    id: z.string(),
    name: z.enum([RELEASE_TOOL, "run_code"]),
    resultSeq: z.number().int().nonnegative().nullable(),
    ids: z.array(z.string()),
    children: z.array(childSchema),
    proofHash: z.string().nullable(),
});
const groupSchema = z.object({
    assistantSeq: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    calls: z.array(callSchema),
});
const stateSchema = z.object({
    surface: z.array(z.number().int().nonnegative()),
    groups: z.array(groupSchema),
});
export type ReleaseControlState = z.infer<typeof stateSchema>;
export type ReleaseControlGroup = ReleaseControlState["groups"][number];
export type ReleaseControlCall = ReleaseControlGroup["calls"][number];
export interface ReleaseControlProof {
    version: 1;
    rootCallId: string;
    childIds: string[];
    contentHash: string;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextReleaseControls: ReleaseControlState;
    }
}

/** Track only potentially removable control groups; business and failed groups are discarded. */
export const releaseControlProjection: ProjectionDefinition<"contextReleaseControls"> = {
    key: "contextReleaseControls",
    stateVersion: 1,
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
                blocks.every(
                    (block) =>
                        block.type === "tool-call" &&
                        (block.name === RELEASE_TOOL || block.name === "run_code"),
                )
            ) {
                const calls: ReleaseControlCall[] = blocks.flatMap((block) =>
                    block.type === "tool-call"
                        ? [
                              {
                                  id: block.id,
                                  name: block.name as ReleaseControlCall["name"],
                                  resultSeq: null,
                                  ids: [],
                                  children: [],
                                  proofHash: null,
                              },
                          ]
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
        if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
            const data = event.data;
            groups = groups.flatMap((group) => {
                const index = group.calls.findIndex(
                    (call) => call.id === data.rootCallId && call.name === "run_code",
                );
                if (index < 0) return [group];
                const call = group.calls[index]!;
                if (
                    data.name !== RELEASE_TOOL ||
                    call.resultSeq !== null ||
                    data.parentCallId !== call.id ||
                    data.subCallId.length === 0 ||
                    data.subCallId === call.id
                )
                    return [];
                const child = call.children.find((item) => item.id === data.subCallId);
                let children = call.children;
                if (event.type === "tool/ptc-dispatch-start") {
                    if (child !== undefined) return [];
                    children = [
                        ...children,
                        {
                            id: data.subCallId,
                            parent: data.parentCallId,
                            args: data.arguments,
                            done: false,
                            value: null,
                            ids: [],
                        },
                    ];
                } else {
                    const value = textValue(event.data.content);
                    const ids = releaseTargets(value);
                    if (
                        child === undefined ||
                        child.done ||
                        event.data.isError ||
                        ids === null ||
                        child.parent !== data.parentCallId ||
                        !isDeepStrictEqual(child.args, data.arguments)
                    )
                        return [];
                    children = children.map((item) =>
                        item.id === data.subCallId ? { ...item, done: true, value, ids } : item,
                    );
                }
                const calls = [...group.calls];
                calls[index] = { ...call, children };
                return [{ ...group, calls }];
            });
        }
        if (
            event.type === "developer/message" &&
            event.data.message.source.kind === RELEASE_CLEANUP_SOURCE
        ) {
            const proof = event.data.message.source.releaseControl;
            if (proof !== undefined && event.data.message.content.length === 0)
                groups = groups.map((group) =>
                    group.turn !== event.data.turn || group.step !== event.data.step
                        ? group
                        : {
                              ...group,
                              calls: group.calls.map((call) =>
                                  call.id === proof.rootCallId &&
                                  call.name === "run_code" &&
                                  proof.version === 1 &&
                                  call.children.length > 0 &&
                                  call.children.every((child) => child.done) &&
                                  isDeepStrictEqual(
                                      proof.childIds,
                                      call.children.map((child) => child.id),
                                  )
                                      ? { ...call, proofHash: proof.contentHash }
                                      : call,
                              ),
                          },
                );
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
                if (event.data.message.isError) return [];
                let ids = call.ids;
                if (
                    call.resultSeq !== null &&
                    call.proofHash !== contentHash(event.data.message.content)
                )
                    return [];
                if (call.resultSeq === null) {
                    if (call.name === RELEASE_TOOL) {
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
                        ids = releaseTargets(value) ?? [];
                    } else {
                        if (call.proofHash !== contentHash(event.data.message.content)) return [];
                        ids = [...new Set(call.children.flatMap((child) => child.ids))];
                    }
                    if (ids.length === 0) return [];
                }
                const calls = [...group.calls];
                calls[index] = {
                    ...call,
                    resultSeq: event.seq,
                    ids,
                    children: [],
                    proofHash: contentHash(event.data.message.content),
                };
                return [{ ...group, calls }];
            });
        }
        return groups === state.groups && surface === state.surface ? state : { groups, surface };
    },
};

/** Canonical values and final content, not rendered text alone, establish a pure PTC wrapper. */
export function pureReleasePtc(
    call: ReleaseControlCall,
    value: unknown,
    content: readonly ContentBlock[],
): boolean {
    if (
        call.children.length === 0 ||
        call.children.some((child) => !child.done) ||
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
    )
        return false;
    const output = value as Record<string, unknown>;
    if (
        Object.keys(output).some((key) => !["logs", "result", "sandbox"].includes(key)) ||
        !Array.isArray(output.logs) ||
        output.logs.length !== 0
    )
        return false;
    if (output.sandbox !== undefined) {
        if (
            output.sandbox === null ||
            typeof output.sandbox !== "object" ||
            Array.isArray(output.sandbox)
        )
            return false;
        const sandbox = output.sandbox as Record<string, unknown>;
        if (sandbox.denied !== false || sandbox.enforcement === "partial") return false;
    }
    const known = (candidate: unknown) =>
        call.children.some((child) => isDeepStrictEqual(candidate, child.value));
    if (
        output.result !== undefined &&
        !known(output.result) &&
        !(Array.isArray(output.result) && output.result.length > 0 && output.result.every(known))
    )
        return false;
    const rendered =
        output.result === undefined
            ? "(run_code completed with no output)"
            : typeof output.result === "string"
              ? output.result
              : JSON.stringify(output.result, null, 2);
    return content.length === 1 && content[0]?.type === "text" && content[0].text === rendered;
}
