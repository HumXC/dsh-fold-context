import type { Message } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

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
export const SUMMARY_CONTROL_TOOLS = new Set([RELEASE_TOOL, COMPACT_TOOL, STATUS_TOOL]);
export const ID_PATTERN = /^[1-9]\d*$/;
export const idArgumentSchema = z.number().int().positive().safe().transform(String);
export function normalizeId(id: string): string {
    if (!ID_PATTERN.test(id) || !Number.isSafeInteger(Number(id)))
        throw new Error("fold-context: invalid context ID");
    return id;
}
export function inlineReleaseContent(id: string): { type: "text"; text: string }[] {
    return [
        {
            type: "text",
            text: `[released ${normalizeId(id)}]`,
        },
    ];
}
export interface Intent {
    version: 8;
    kind: "release" | "summary";
    sessionId: string;
    ids: string[];
    reason: string;
}
export function entryId(number: number): string {
    if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("fold-context: invalid allocation ordinal");
    return String(number);
}
export function previewContent(content: Message["content"], limit = 100): string {
    const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
}
export function hasReleasableBody(message: Message): boolean {
    return message.role === "tool" || message.content.some((block) => block.type === "text");
}
