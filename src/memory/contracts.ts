import { Service, type Context } from "@deepseek-ai/cordis";
import type { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

/** Compression emits source references; adapters choose their own extraction/storage policy. */
export interface MemoryExtractionBatch {
    version: 1;
    idempotencyKey: string;
    sessionId: SessionId;
    sourceSeqs: readonly SessionSeq[];
    checkpoint: readonly ContentBlock[];
}
export interface MemoryExtractionReceipt {
    idempotencyKey: string;
    status: "stored" | "duplicate" | "skipped" | "failed";
    memoryIds?: readonly string[];
    reason?: string;
}
export abstract class ContextMemoryAdapter extends Service {
    constructor(ctx: Context) {
        super(ctx, "contextMemoryAdapter");
    }
    abstract extract(
        batch: MemoryExtractionBatch,
        signal?: AbortSignal,
    ): Promise<MemoryExtractionReceipt>;
}
declare module "@deepseek-ai/cordis" {
    interface Context {
        contextMemoryAdapter: ContextMemoryAdapter;
    }
}
