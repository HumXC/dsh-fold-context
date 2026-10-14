import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type ContentBlock, type ContextFormed } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { AttachmentSlot } from "../domain/attachment-numbering.js";
import {
    attachmentBlockSchema,
    isAttachmentBlock,
    type AttachmentBlock,
} from "../domain/attachment-numbering.js";
import type { LedgerState } from "../domain/ledger.js";
import "@deepseek-ai/dsh-attachment";

export const ATTACHMENT_RECOVERY_SOURCE = "fold-context-attachment-recovery";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-attachment-recovery": {
            kind: typeof ATTACHMENT_RECOVERY_SOURCE;
        } & ContextFormed;
    }
}
export function renderRecovered(value: unknown): ContentBlock[] {
    const text: ContentBlock = { type: "text", text: JSON.stringify(value) };
    if (
        value === null ||
        typeof value !== "object" ||
        !("representation" in value) ||
        !("attachment" in value)
    )
        return [text];
    const type =
        value.representation === "native-image"
            ? "image"
            : value.representation === "file-handle"
              ? "file"
              : null;
    if (type === null) return [text];
    // References have just been verified by the store; the renderer itself remains pure.
    const block = attachmentBlockSchema.parse({
        type,
        attachment: value.attachment,
    }) as AttachmentBlock;
    return [text, block];
}
export async function expandAttachment(
    ctx: Context,
    agent: Agent,
    state: LedgerState,
    slot: AttachmentSlot,
    exec: ToolRunContext,
) {
    const base = {
        id: slot.id,
        kind: slot.kind,
        ownerId: slot.ownerId,
        sourceSeq: slot.sourceSeq,
        blockIndex: slot.blockIndex,
        currentSeq: slot.currentSeq,
        bindingStatus: slot.status,
        releaseStatus: state.entries.find((item) => item.id === slot.id)?.status ?? null,
        restoresSurface: false,
    };
    const window = await ctx.sessionQuery.readEvent(
        { sessionId: agent.session.id, seq: SessionSeq(slot.sourceSeq), before: 0, after: 0 },
        exec.signal,
    );
    exec.signal.throwIfAborted();
    const event = window.target;
    const message =
        event.type === "user/message"
            ? event.data
            : event.type === "assistant/message" || event.type === "tool/result"
              ? event.data.message
              : null;
    const owner = state.numbering.slots.find((item) => item.id === slot.ownerId);
    const block = message?.content[slot.blockIndex];
    if (
        window.session.id !== agent.session.id ||
        event.seq !== slot.sourceSeq ||
        message?.role !== slot.role ||
        message.id !== owner?.messageId ||
        block === undefined ||
        !isAttachmentBlock(block) ||
        JSON.stringify(attachmentBlockSchema.parse(block)) !== JSON.stringify(slot.block)
    )
        throw new Error(
            `fold-context: original attachment is missing or inconsistent for ${slot.id}`,
        );
    const store = ctx.get("attachments");
    if (store === undefined) return { ...base, status: "attachment_store_unavailable" };
    if (block.type === "image") {
        const target = agent.session.requestHeader()?.config ?? agent.options;
        const model =
            target.provider && target.model
                ? await ctx.llm.resolveModelInfo(target.provider, target.model, exec.signal)
                : undefined;
        if (!model?.inputModalities?.includes("image"))
            return {
                ...base,
                status: "capability_unsupported",
                attachment: block.attachment,
                capability: model?.inputModalities === undefined ? "unknown" : "text-only",
            };
        const stored = await store.readImage(block.attachment, exec.signal);
        exec.signal.throwIfAborted();
        return {
            ...base,
            status: "found",
            representation: "native-image",
            attachment: stored.ref,
            verifiedBytes: stored.data.byteLength,
        };
    }
    let verifiedBytes = 0;
    for await (const chunk of store.readFileStream(block.attachment, exec.signal)) {
        exec.signal.throwIfAborted();
        verifiedBytes += chunk.byteLength;
        if (!Number.isSafeInteger(verifiedBytes))
            throw new Error("fold-context: file size exceeds safe accounting range");
    }
    exec.signal.throwIfAborted();
    if (verifiedBytes !== block.attachment.bytes)
        throw new Error("fold-context: verified file length does not match its reference");
    const hostPath = store.fileHostPath(block.attachment);
    const path =
        hostPath === undefined ? undefined : ctx.get("fs")?.processPathFromHostPath(hostPath);
    const handle = ctx.llm.fileRequestText(block.attachment);
    const value = {
        ...base,
        status: path === undefined ? "path_unavailable" : "found",
        representation: path === undefined ? "verified-file-reference" : "file-handle",
        attachment: block.attachment,
        verifiedBytes,
        path: path ?? null,
        handle,
    };
    // PTC auto-forwards images, but not file-only results. Defer the verified handle explicitly.
    if (exec.parent !== undefined)
        exec.deferContext(
            createUserMessage({
                source: {
                    kind: ATTACHMENT_RECOVERY_SOURCE,
                    form: "notice",
                    summary: `Recovered ${slot.id} file handle`,
                },
                content: renderRecovered(value),
            }),
        );
    return value;
}
