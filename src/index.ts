import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
    BasicCompactionEngine,
    type BasicCompactionConfig,
} from "@deepseek-ai/dsh-compaction-basic";
import { resolveReleasePolicy, type ReleasePolicy } from "./domain/planner.js";
import { ContextCompressionEngine } from "./integration/engine.js";
import { registerCompressionTools } from "./integration/tools.js";
import { registerAllocation } from "./integration/allocation.js";
import "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-token-meter";

export const name = "fold-context";
export const inject = [
    "llm",
    "tokenMeter",
    "sessions",
    "sessionProjections",
    "tools",
    "systemPrompt",
];
export interface Config {
    compaction?: BasicCompactionConfig;
    release?: Partial<ReleasePolicy>;
}
export const Config = z.object({
    compaction: BasicCompactionEngine.Config.default({}),
    release: z
        .object({
            protectRecentResults: z.number().step(1).min(0).default(2),
            catalogLimit: z.number().step(1).min(1).max(128).default(32),
        })
        .default({}),
});
export function apply(ctx: Context, config: Config = {}) {
    const engine = new ContextCompressionEngine(
        ctx,
        config.compaction ?? {},
        resolveReleasePolicy(config.release),
    );
    registerCompressionTools(ctx, engine);
    registerAllocation(ctx, engine);
    ctx.systemPrompt.context({
        name: "fold-context:ledger",
        order: 130,
        text: (assembly) => engine.runtimeContext(assembly.scope),
    });
    ctx.systemPrompt.section({
        name: "fold-context:policy",
        order: 2450,
        text:
            "Context numbering: the input declaration reserves §N§ for the next assistant message; never print an ID prefix. " +
            "Use the session ledger’s stable preallocated §N§ IDs to release consumed tool results only. User and assistant bindings are not releasable. " +
            "Preserve facts needed to continue before marking their evidence. Release receipts are queued until a later ledger confirms applied. " +
            "A summary also covers unmarked history; check its recorded coverage. User instructions and active goals must survive in checkpoints.",
    });
}
export { ContextCompressionEngine } from "./integration/engine.js";
export { ledgerProjection, type LedgerState } from "./domain/ledger.js";
export default { name, inject, Config, apply };
