import { createHash } from "node:crypto";
import type { Message } from "@deepseek-ai/dsh-llm";
import { ALLOCATION_SOURCE } from "./numbering.js";
import { CONTROL_TOOLS, EXPAND_TOOL, SEARCH_TOOL } from "./protocol.js";

/** Runtime bookkeeping belongs in the ledger, not the semantic checkpoint. */
export function isSummaryControlNotice(message: Message): boolean {
    return (
        message.source?.kind === ALLOCATION_SOURCE ||
        message.source?.kind === "fold-context-release-cleanup"
    );
}

/** Snapshot candidates need history to distinguish regeneration from a real change. */
export function isRegeneratedSnapshot(message: Message): boolean {
    const source = message.source as { kind: string; baseline?: unknown; form?: unknown };
    return (
        (source.kind === "agent-instructions" &&
            source.baseline === true &&
            source.form === "instructions") ||
        (source.kind === "plugin:@wingsky-1/dsh-mcp-manager" && source.form === "snapshot")
    );
}

export function summarySnapshot(message: Message) {
    if (!isRegeneratedSnapshot(message)) return null;
    const source = message.source as {
        kind: string;
        baselineIdentity?: unknown;
        changes?: unknown;
    };
    return {
        kind: source.kind,
        fingerprint: createHash("sha256")
            .update(JSON.stringify([source.kind, source.baselineIdentity ?? null, message.content]))
            .digest("hex"),
        initialEvidence:
            source.kind === "agent-instructions" &&
            Array.isArray(source.changes) &&
            source.changes.length > 0,
    };
}

export function hasSummaryBusinessEvidence(
    message: Message,
    toolName: string | null = null,
    snapshotEvidence?: boolean,
): boolean {
    if (isSummaryControlNotice(message) || message.source?.kind === "compact-checkpoint")
        return false;
    if (isRegeneratedSnapshot(message))
        return snapshotEvidence ?? summarySnapshot(message)!.initialEvidence;
    if (
        message.role === "tool" &&
        toolName !== null &&
        CONTROL_TOOLS.has(toolName) &&
        toolName !== EXPAND_TOOL &&
        toolName !== SEARCH_TOOL
    )
        return false;
    const calls = message.content.filter((block) => block.type === "tool-call");
    if (message.role === "assistant" && calls.length > 0)
        return calls.some((block) => !CONTROL_TOOLS.has(block.name));
    return message.content.some(
        (block) =>
            block.type === "image" ||
            block.type === "file" ||
            (block.type === "text" && block.text.trim().length > 0),
    );
}
