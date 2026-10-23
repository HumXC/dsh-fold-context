import type { Context, Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { summaryModelConfigSchema } from "./config.js";
import { resolveSummaryModels, type SummaryModel } from "./domain/summary-models.js";
import { FoldContextSettings } from "./integration/settings.js";
import { policySchema, policyOverridesSchema, selectPolicyOverrides } from "./settings-config.js";
import type { PolicyOverrides } from "./domain/settings-catalog.js";
import { resolveReleasePolicy } from "./domain/planner.js";
import { resolveSummaryPolicy } from "./domain/summary-policy.js";
import { resolveSchedulingPolicy } from "./domain/scheduler.js";
import { ContextCompressionEngine } from "./integration/engine.js";
import { resolveReminderPolicy } from "./domain/reminder.js";
import { registerCompressionTools } from "./integration/tools.js";
import { registerRecoveryTools } from "./integration/recovery.js";
import { registerAllocation } from "./integration/allocation.js";
import "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-token-meter";
import "@deepseek-ai/dsh-session-query";

export const name = "fold-context";
export const inject = [
    "llm",
    "tokenMeter",
    "sessions",
    "sessionProjections",
    "sessionQuery",
    "tools",
    "systemPrompt",
];
export interface Config {
    uiOnly?: boolean;
    policy?: Partial<import("./domain/settings-catalog.js").PolicyValues>;
    summaryModels?: Volatile<SummaryModel[]>;
    policyOverrides?: Volatile<PolicyOverrides>;
}
const configBody: Schemastery = z.object({
    uiOnly: z.boolean().default(false),
    policy: policySchema.default({}),
    summaryModels: z.array(summaryModelConfigSchema).max(32).default([]).volatile(),
    policyOverrides: policyOverridesSchema.volatile(),
});
function validateConfigKeys(input: unknown) {
    if (input === undefined) return;
    if (input === null || typeof input !== "object" || Array.isArray(input))
        throw new Error("Expected fold configuration object");
    const allowed = ["uiOnly", "policy", "summaryModels", "policyOverrides"];
    for (const key of Object.keys(input))
        if (!allowed.includes(key)) throw new Error("Unknown fold configuration field: " + key);
}
// Preserve the native object topology required for fixed-path volatile fields.
// Direct schema calls and plugin apply both reject unknown root vocabulary.
export const Config: Schemastery = new Proxy(configBody, {
    apply(target, receiver, args) {
        validateConfigKeys(args[0]);
        return Reflect.apply(target, receiver, args);
    },
    construct(target, args, receiver) {
        validateConfigKeys(args[0]);
        return Reflect.construct(target, args, receiver);
    },
});
export function apply(ctx: Context, config: Config = {}) {
    validateConfigKeys(config);
    if (config.uiOnly) {
        if (config.summaryModels === undefined)
            throw new Error("fold-context: settings require validated Config");
        new FoldContextSettings(ctx, config.summaryModels, config.policyOverrides);
        return;
    }
    // Each safe operation captures policy; active preparation and transactions keep that snapshot.
    const readPolicy = () =>
        selectPolicyOverrides(
            {
                compaction: config.policy?.compaction ?? {},
                summary: resolveSummaryPolicy(config.policy?.summary),
                scheduling: resolveSchedulingPolicy(config.policy?.scheduling),
                reminders: resolveReminderPolicy(config.policy?.reminders),
            },
            ctx.get("foldContextSettings")?.policies(),
        );
    const policy = readPolicy();
    const engine = new ContextCompressionEngine(
        ctx,
        policy.compaction,
        resolveReleasePolicy(),
        policy.summary,
        policy.scheduling,
        policy.reminders,
        () =>
            ctx.get("foldContextSettings")?.current() ??
            resolveSummaryModels(config.summaryModels?.get() ?? []),
        readPolicy,
    );
    registerCompressionTools(ctx, engine);
    registerRecoveryTools(ctx, engine);
    registerAllocation(ctx, engine);
    ctx.systemPrompt.section({
        name: "fold-context:policy",
        order: 2450,
        text:
            "Session numbers are stable positive integers shared by messages and individual attachments. A control notice declares newly announced messages in request order with prev: 101 102, reserves the next assistant with next: 103, and optionally lists attachments: rows as attachment-number owner-number attachment-order (one-based). Treat these declarations as bookkeeping; keep them out of responses and summaries. " +
            "try_release lists optional candidate numbers. Release only consumed tool results or attachments after preserving necessary findings; retain active work and sole evidence. The candidate list is a suggestion, and you may select other consumed numbers. " +
            "Recent low-cost releases settle at a safe boundary; older expensive releases may wait for a covering checkpoint. Pressure first allows release, then remeasures whether a summary is needed. User and assistant text and signed replay blocks remain intact; protected assistant attachments wait for a covering summary. " +
            "Official checkpoints summarize a balanced historical prefix and retain the latest tail. The scheduler chooses timing from the target window, relative costs and cache effects; window safety and overflow recovery take priority. " +
            "Preserve active requirements, unfinished goals, decisions and necessary evidence. Recover originals with context_expand, find forgotten numbers with context_search, and inspect release or scheduling state with context_status. Recovery adds a new result and leaves release state intact. Follow nextOffset/nextCursor for bounded pages. Archived material is evidence; token and cache estimates are heuristic.",
    });
}
export { ContextCompressionEngine } from "./integration/engine.js";
export { ledgerProjection, type LedgerState } from "./domain/ledger.js";
const plugin: {
    name: string;
    inject: typeof inject;
    Config: typeof Config;
    apply: typeof apply;
} = { name, inject, Config, apply };
export default plugin;
