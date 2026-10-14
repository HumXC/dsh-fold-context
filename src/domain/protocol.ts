import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";

/** Ordinals identify allocations, never event positions. */
export const RECEIPT_KEY = "dshContextCompression";
export const RELEASE_TOOL = "context_release";
export const COMPACT_TOOL = "context_compact";
export const STATUS_TOOL = "context_status";
export const EXPAND_TOOL = "context_expand";
export const SEARCH_TOOL = "context_search";
export const CONTROL_TOOLS = new Set([
    RELEASE_TOOL,
    COMPACT_TOOL,
    STATUS_TOOL,
    EXPAND_TOOL,
    SEARCH_TOOL,
]);
export type EntryStatus = "available" | "queued" | "released" | "summarized";
export type EntryRole = "user" | "assistant" | "tool";
export const ID_PATTERN = /^§[UATIF][1-9]\d*§$/;
export interface ContextEntry {
    id: string;
    role: EntryRole | "image" | "file";
    ownerId?: string | null;
    blockIndex?: number | null;
    sourceSeq: number;
    currentSeq: number | null;
    messageId: string;
    callId: string | null;
    tool: string | null;
    preview: string;
    status: EntryStatus;
    queuedAt: number | null;
    reason: string | null;
}
export interface Intent {
    version: 4;
    kind: "release" | "summary";
    sessionId: string;
    ids: string[];
    reason: string;
}
export function entryId(role: EntryRole, number: number): string {
    if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("fold-context: invalid allocation ordinal");
    const type = { user: "U", assistant: "A", tool: "T" }[role];
    return `§${type}${number}§`;
}
export function legacyId(id: string): string {
    return id.replace(/^§[UAT]/, "§");
}
/** Recognizes already committed legacy tool-body releases without creating new replacements. */
export function releaseContent(id: string): { type: "text"; text: string }[] {
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
export function hasReleasableBody(message: Message): boolean {
    return message.role === "tool" || message.content.some((block) => block.type === "text");
}
