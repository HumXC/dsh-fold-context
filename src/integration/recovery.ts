import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { ContextCompressionEngine } from "./engine.js";
import type { LedgerState } from "../domain/ledger.js";
import type { NumberSlot } from "../domain/numbering.js";
import {
    archiveContent,
    characterPage,
    DEFAULT_EXPAND_CHARACTERS,
    DEFAULT_SEARCH_LIMIT,
    isArchiveEvidence,
    searchableContent,
    literalSearchPattern,
    matchSnippet,
    MAX_EXPAND_CHARACTERS,
    MAX_SEARCH_LIMIT,
    originalMessage,
    type ArchiveRole,
} from "../domain/archive.js";
import { EXPAND_TOOL, SEARCH_TOOL, idArgumentSchema } from "../domain/protocol.js";
import "@deepseek-ai/dsh-session-query";
import { expandAttachment, renderRecovered } from "./attachment-recovery.js";
const idSchema = idArgumentSchema;
const rolesSchema = z
    .array(z.enum(["user", "assistant", "tool"]))
    .min(1)
    .max(3);
const searchCursorSchema = z
    .object({
        version: z.literal(1),
        sessionId: z.string(),
        throughSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
        afterSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
        fingerprint: z.string(),
    })
    .strict();

function owner(exec: ToolRunContext) {
    exec.signal.throwIfAborted();
    if (exec.agent === undefined) throw new Error("fold-context recovery requires an owning agent");
    return exec.agent;
}

function metadata(state: LedgerState, slot: NumberSlot) {
    const tool = slot.tool === null ? null : characterPage(slot.tool, 0, 128);
    return {
        id: slot.id,
        role: slot.role,
        status: slot.status,
        releaseStatus: state.entries.find((entry) => entry.id === slot.id)?.status ?? null,
        sourceSeq: slot.sourceSeq,
        currentSeq: slot.currentSeq,
        tool: tool?.text ?? null,
        toolNameTruncated: tool !== null && tool.nextOffset !== null,
    };
}

function searchFingerprint(query: string, roles: readonly ArchiveRole[], tool: string | undefined) {
    return createHash("sha256")
        .update(JSON.stringify({ query, roles: [...roles].sort(), tool: tool ?? null }))
        .digest("hex");
}

export function registerRecoveryTools(ctx: Context, engine: ContextCompressionEngine): void {
    ctx.tools.register(
        defineTool({
            name: EXPAND_TOOL,
            description:
                "Read bounded exact originals from this session. Attachment numbers restore verified images on image-capable routes or return verified file handles. Recovery does not undo release. Search forgotten numbers first.",
            parameters: {
                id: {
                    type: "integer",
                    required: true,
                    description:
                        "A positive session number from a declaration, search result, or context_status.",
                },
                offset: {
                    type: "integer",
                    description:
                        "Unicode code-point offset; defaults to 0. Use the returned nextOffset for the next page.",
                },
                limit: {
                    type: "integer",
                    description: "Maximum Unicode code points, 1–16000; defaults to 4000.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => renderRecovered(value),
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const agent = owner(exec);
                const id = idSchema.parse(args.id);
                const offset = z
                    .number()
                    .int()
                    .min(0)
                    .max(Number.MAX_SAFE_INTEGER)
                    .parse(args.offset ?? 0);
                const limit = z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_EXPAND_CHARACTERS)
                    .parse(args.limit ?? DEFAULT_EXPAND_CHARACTERS);
                const state = engine.state(agent.session);
                const attachment = state.numbering.attachments.find(
                    (candidate) => candidate.id === id,
                );
                if (attachment !== undefined) {
                    if (offset !== 0)
                        return {
                            status: "offset_out_of_range",
                            id,
                            text: "",
                            reason: "Attachments are recovered as a whole reference, not text pages.",
                        };
                    return expandAttachment(ctx, agent, state, attachment, exec);
                }
                const slot = state.numbering.slots.find((candidate) => candidate.id === id);
                if (slot === undefined) return { status: "unknown", id, text: "" };
                if (slot.sourceSeq === null)
                    return {
                        ...metadata(state, slot),
                        status: "unbound",
                        bindingStatus: slot.status,
                        text: "",
                    };
                if (!isArchiveEvidence(slot))
                    return {
                        ...metadata(state, slot),
                        status: "unsupported",
                        bindingStatus: slot.status,
                        text: "",
                    };
                const window = await ctx.sessionQuery.readEvent(
                    {
                        sessionId: agent.session.id,
                        seq: SessionSeq(slot.sourceSeq),
                        before: 0,
                        after: 0,
                    },
                    exec.signal,
                );
                exec.signal.throwIfAborted();
                const message = originalMessage(slot, window.target);
                if (window.session.id !== agent.session.id || message === null)
                    throw new Error(
                        `fold-context: original event is missing or inconsistent for ${id}`,
                    );
                const content = archiveContent(message.content);
                const page = characterPage(content.text, offset, limit);
                return {
                    ...metadata(state, slot),
                    status: page.outOfRange ? "offset_out_of_range" : "found",
                    bindingStatus: slot.status,
                    format: content.format,
                    ...page,
                    restoresSurface: false,
                };
            },
        }),
    );
    ctx.tools.register(
        defineTool({
            name: SEARCH_TOOL,
            description:
                "Find original numbered evidence in this session when you forgot its ID. Search is a case-insensitive literal substring over original evidence blocks, including released and summarized history. Returns IDs and short match snippets; use context_expand for exact content. Optional role/tool filters and a continuation cursor bound output. Excludes control-tool results, assistant control-call arguments and unbound allocations; cannot search other sessions.",
            parameters: {
                query: {
                    type: "string",
                    required: true,
                    description:
                        "Literal content fragment, 1–200 characters. Regex syntax is treated literally.",
                },
                roles: {
                    type: "array",
                    items: { type: "string", enum: ["user", "assistant", "tool"] },
                    description: "Optional roles to search; defaults to all three.",
                },
                tool: {
                    type: "string",
                    description:
                        "Optional exact tool name; limits results to that tool's original result bodies.",
                },
                limit: {
                    type: "integer",
                    description:
                        "Maximum hits, 1–20; defaults to 8. Snippets are capped at 160 Unicode code points plus ellipses.",
                },
                cursor: {
                    type: "string",
                    description:
                        "The returned nextCursor for the same query and filters. New messages after the first page are excluded until a new search.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const agent = owner(exec);
                const query = z.string().min(1).max(200).parse(args.query);
                const roles = [
                    ...new Set(rolesSchema.parse(args.roles ?? ["user", "assistant", "tool"])),
                ];
                const tool =
                    args.tool === undefined
                        ? undefined
                        : z.string().min(1).max(256).parse(args.tool);
                const limit = z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_SEARCH_LIMIT)
                    .parse(args.limit ?? DEFAULT_SEARCH_LIMIT);
                const fingerprint = searchFingerprint(query, roles, tool);
                const state = engine.state(agent.session);
                const currentSeq = agent.session.seq - 1;
                let throughSeq = currentSeq;
                let afterSeq = -1;
                if (args.cursor !== undefined) {
                    const cursor = z.string().min(1).max(2048).parse(args.cursor);
                    let decoded: unknown;
                    try {
                        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
                    } catch {
                        throw new Error("fold-context: invalid search cursor");
                    }
                    const parsed = searchCursorSchema.safeParse(decoded);
                    if (
                        !parsed.success ||
                        parsed.data.sessionId !== agent.session.id ||
                        parsed.data.fingerprint !== fingerprint ||
                        parsed.data.throughSeq > currentSeq ||
                        parsed.data.afterSeq > parsed.data.throughSeq
                    )
                        throw new Error(
                            "fold-context: search cursor does not match this session and query",
                        );
                    ({ throughSeq, afterSeq } = parsed.data);
                }
                const observation = await ctx.sessionQuery.observeSession(agent.session.id, {
                    signal: exec.signal,
                    projectionMode: "none",
                });
                try {
                    exec.signal.throwIfAborted();
                    if (
                        observation.header.id !== agent.session.id ||
                        observation.cursor < throughSeq
                    )
                        throw new Error(
                            "fold-context: archive observation is behind the live session",
                        );
                    const candidates = state.numbering.slots
                        .flatMap((slot) => {
                            const sourceSeq = slot.sourceSeq;
                            if (
                                sourceSeq === null ||
                                !isArchiveEvidence(slot) ||
                                sourceSeq <= afterSeq ||
                                sourceSeq > throughSeq ||
                                !roles.includes(slot.role) ||
                                (tool !== undefined && (slot.role !== "tool" || slot.tool !== tool))
                            )
                                return [];
                            return [{ slot, sourceSeq }];
                        })
                        .sort((left, right) => left.sourceSeq - right.sourceSeq);
                    const pattern = literalSearchPattern(query);
                    const hits: Array<
                        ReturnType<typeof metadata> & {
                            snippet: string;
                            attachments: Array<{ id: string; kind: string; name: string | null }>;
                            attachmentsOmitted: number;
                        }
                    > = [];
                    let hasMore = false;
                    for (const { slot, sourceSeq } of candidates) {
                        exec.signal.throwIfAborted();
                        const event = observation.events[sourceSeq];
                        const message = event === undefined ? null : originalMessage(slot, event);
                        if (message === null)
                            throw new Error(
                                `fold-context: original event is missing or inconsistent for ${slot.id}`,
                            );
                        const content = searchableContent(message);
                        if (content === null) continue;
                        const match = pattern.exec(content);
                        if (match === null) continue;
                        if (hits.length === limit) {
                            hasMore = true;
                            break;
                        }
                        const allAttachments = state.numbering.attachments.filter(
                            (item) => item.ownerId === slot.id,
                        );
                        const matchingAttachments = allAttachments.filter((item) =>
                            pattern.test(JSON.stringify(item.block)),
                        );
                        const attachmentCandidates =
                            matchingAttachments.length > 0 ? matchingAttachments : allAttachments;
                        hits.push({
                            ...metadata(state, slot),
                            snippet: matchSnippet(content, match.index),
                            attachments: attachmentCandidates.slice(0, 8).map((item) => ({
                                id: item.id,
                                kind: item.kind,
                                name: item.block.attachment.name ?? null,
                            })),
                            attachmentsOmitted: Math.max(0, attachmentCandidates.length - 8),
                        });
                    }
                    const last = hits.at(-1);
                    const nextCursor =
                        hasMore && last !== undefined
                            ? Buffer.from(
                                  JSON.stringify({
                                      version: 1,
                                      sessionId: agent.session.id,
                                      throughSeq,
                                      afterSeq: last.sourceSeq,
                                      fingerprint,
                                  }),
                              ).toString("base64url")
                            : null;
                    return {
                        query,
                        throughSeq,
                        hits,
                        nextCursor,
                        hasMore,
                        scope: "current-session originals",
                    };
                } finally {
                    observation[Symbol.dispose]();
                }
            },
        }),
    );
}
