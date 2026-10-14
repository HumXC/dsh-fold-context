import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { NumberSlot } from "./numbering.js";
import { CONTROL_TOOLS } from "./protocol.js";

export const DEFAULT_EXPAND_CHARACTERS = 4000;
export const MAX_EXPAND_CHARACTERS = 16000;
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;
export const SEARCH_SNIPPET_CHARACTERS = 160;
export type ArchiveRole = "user" | "assistant" | "tool";

/** Resolve the original event, never the current surface replacement. */
export function originalMessage(slot: NumberSlot, event: SessionEvent): Message | null {
    if (event.seq !== slot.sourceSeq) return null;
    if (slot.role === "user" && event.type === "user/message") return event.data;
    if (slot.role === "assistant" && event.type === "assistant/message") return event.data.message;
    if (slot.role === "tool" && event.type === "tool/result") return event.data.message;
    return null;
}

export function isArchiveEvidence(slot: NumberSlot): boolean {
    return slot.sourceSeq !== null && !(slot.role === "tool" && CONTROL_TOOLS.has(slot.tool ?? ""));
}

/** Search original block text, preserving whitespace and excluding assistant control arguments. */
export function searchableContent(message: Message): string | null {
    const content =
        message.role === "assistant"
            ? message.content.filter(
                  (block) => block.type !== "tool-call" || !CONTROL_TOOLS.has(block.name),
              )
            : message.content;
    if (content.length === 0) return null;
    return content
        .map((block) => {
            if (block.type === "text" || block.type === "reasoning") return block.text;
            if (block.type === "tool-call") return `${block.name}\n${block.arguments}`;
            return JSON.stringify(block);
        })
        .join("\n");
}

/** A text-only block stays byte-for-byte unchanged; structured content is reversible JSON. */
export function archiveContent(content: readonly ContentBlock[]): {
    format: "text" | "content-json";
    text: string;
} {
    const first = content[0];
    if (content.length === 1 && first?.type === "text") return { format: "text", text: first.text };
    return { format: "content-json", text: JSON.stringify(content) };
}

/** Unicode code-point offsets, without allocating a full array for large originals. */
export function characterPage(text: string, offset: number, limit: number) {
    let totalCharacters = 0;
    const page: string[] = [];
    for (const character of text) {
        if (totalCharacters >= offset && page.length < limit) page.push(character);
        totalCharacters += 1;
    }
    const nextOffset = offset + page.length;
    return {
        text: page.join(""),
        offset,
        returnedCharacters: page.length,
        totalCharacters,
        nextOffset: nextOffset < totalCharacters ? nextOffset : null,
        complete: offset === 0 && page.length === totalCharacters,
        outOfRange: offset > totalCharacters,
    };
}

export function literalSearchPattern(query: string): RegExp {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

/** Keep original whitespace and a small amount of context around the actual literal match. */
export function matchSnippet(text: string, matchIndex: number): string {
    let start = matchIndex;
    for (let count = 0; count < 50 && start > 0; count += 1) {
        start -= 1;
        const code = text.charCodeAt(start);
        if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
    }
    const page: string[] = [];
    for (const character of text.slice(start)) {
        if (page.length === SEARCH_SNIPPET_CHARACTERS) break;
        page.push(character);
    }
    const snippet = page.join("");
    return `${start > 0 ? "…" : ""}${snippet}${start + snippet.length < text.length ? "…" : ""}`;
}
