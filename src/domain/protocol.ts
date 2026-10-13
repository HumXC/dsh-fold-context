import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";

/** Plain transport-independent protocol. Ordinals identify allocations, never event positions. */
export const RECEIPT_KEY = "dshContextCompression";
export const RELEASE_TOOL = "context_release";
export const COMPACT_TOOL = "context_compact";
export const STATUS_TOOL = "context_status";
export const CONTROL_TOOLS = new Set([RELEASE_TOOL, COMPACT_TOOL, STATUS_TOOL]);
export type EntryStatus = "available" | "queued" | "released" | "summarized";
export interface ContextEntry {
    id: string;
    sourceSeq: number;
    currentSeq: number | null;
    messageId: string;
    callId: string;
    tool: string;
    preview: string;
    status: EntryStatus;
    queuedAt: number | null;
    reason: string | null;
}
export interface Intent {
    version: 2;
    kind: "release" | "summary";
    sessionId: string;
    ids: string[];
    reason: string;
}
export function entryId(number: number): string {
    if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("fold-context: invalid allocation ordinal");
    return `§${number}§`;
}
export function releaseContent(id: string): ContentBlock[] {
    return [
        {
            type: "text",
            text: `[Context ${id} released by model request; original retained in session log.]`,
        },
    ];
}
export function previewContent(content: readonly ContentBlock[], limit = 100): string {
    const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
}
/** Retain the protocol shell: dropping a tool message would orphan its assistant tool call. */
export function discardMarkedBodies(
    messages: readonly Message[],
    entries: readonly ContextEntry[],
): Message[] {
    const marked = new Map(
        entries
            .filter((entry) => entry.status === "queued" || entry.status === "released")
            .map((entry) => [entry.messageId, entry.id]),
    );
    return messages.map((message) => {
        const id = message.role === "tool" ? marked.get(message.id) : undefined;
        return id === undefined ? message : { ...message, content: releaseContent(id) };
    });
}
