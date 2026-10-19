import type { Context, Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
    foldCompactionSchema,
    summaryModelConfigSchema,
    type FoldCompactionConfig,
} from "./config.js";
import { resolveSummaryModels, type SummaryModel } from "./domain/summary-models.js";
import { FoldContextSettings } from "./integration/settings.js";
import { policyOverridesSchema, selectPolicyOverrides } from "./settings-config.js";
import type { PolicyOverrides } from "./domain/settings-catalog.js";
import { resolveReleasePolicy, type ReleasePolicy } from "./domain/planner.js";
import { resolveSummaryPolicy, type SummaryPolicy } from "./domain/summary-policy.js";
import { resolveSchedulingPolicy, type SchedulingPolicy } from "./domain/scheduler.js";
import { ContextCompressionEngine } from "./integration/engine.js";
import { resolveReminderPolicy, type ReminderPolicy } from "./domain/reminder.js";
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
    /** Root-profile mount exposes the Client half without installing another engine. */
    uiOnly?: boolean;
    compaction?: FoldCompactionConfig;
    summaryModels?: Volatile<SummaryModel[]>;
    policyOverrides?: Volatile<PolicyOverrides>;
    release?: Partial<ReleasePolicy>;
    summary?: Partial<SummaryPolicy>;
    scheduling?: Partial<SchedulingPolicy>;
    reminders?: Partial<ReminderPolicy>;
}
const schedulingDefaults = resolveSchedulingPolicy();

type DefaultFields<T extends object> = {
    [K in keyof T]: Schemastery<T[K], T[K], "defined">;
};
type DefaultGroup<T extends object> = Schemastery<
    Schemastery.ObjectS<DefaultFields<T>>,
    Schemastery.ObjectT<DefaultFields<T>>,
    "defined"
>;
type ConfigFields = {
    uiOnly: Schemastery<boolean, boolean, "defined">;
    compaction: ReturnType<typeof foldCompactionSchema.default>;
    summaryModels: Schemastery<
        Schemastery.TypeS<typeof summaryModelConfigSchema>[],
        Schemastery.TypeT<typeof summaryModelConfigSchema>[],
        "volatile-defined"
    >;
    policyOverrides: ReturnType<typeof policyOverridesSchema.volatile>;
    reminders: DefaultGroup<ReminderPolicy>;
    scheduling: DefaultGroup<SchedulingPolicy>;
    summary: DefaultGroup<SummaryPolicy>;
    release: DefaultGroup<ReleasePolicy>;
};
export const Config: Schemastery<
    Schemastery.ObjectS<ConfigFields>,
    Schemastery.ObjectT<ConfigFields>
> = z.object({
    uiOnly: z.boolean().default(false),
    compaction: foldCompactionSchema.default({}),
    summaryModels: z.array(summaryModelConfigSchema).max(32).default([]).volatile(),
    policyOverrides: policyOverridesSchema.volatile(),
    reminders: z
        .object({
            enabled: z.boolean().default(true),
            minAgeSteps: z.number().step(1).min(0).default(2),
            largeOutputTokens: z.number().step(1).min(1).default(8000),
            backlogTokens: z.number().step(1).min(1).default(16000),
            staleTokens: z.number().step(1).min(1).default(4000),
            staleSteps: z.number().step(1).min(0).default(8),
            pressureRatio: z.number().min(0).max(1).default(0.8),
            minIntervalSteps: z.number().step(1).min(1).default(6),
            pressureIntervalSteps: z.number().step(1).min(1).default(4),
            ignoredBackoffSteps: z.array(z.number().step(1).min(1)).default([12, 24]),
            rearmGrowthTokens: z.number().step(1).min(1).default(8000),
            maxCandidates: z.number().step(1).min(1).max(128).default(5),
        })
        .default({}),
    scheduling: z
        .object({
            enabled: z.boolean().default(schedulingDefaults.enabled),
            proactive: z.boolean().default(schedulingDefaults.proactive),
            minIntervalSteps: z
                .number()
                .step(1)
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.minIntervalSteps),
            minSavingsTokens: z
                .number()
                .step(1)
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.minSavingsTokens),
            minSavingsRatio: z.number().min(0).max(1).default(schedulingDefaults.minSavingsRatio),
            expectedSummaryRatio: z
                .number()
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.expectedSummaryRatio),
            paybackTurns: z
                .number()
                .step(1)
                .min(1)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.paybackTurns),
            cacheReadRatio: z.number().min(0).max(1).default(schedulingDefaults.cacheReadRatio),
            summaryInputRatio: z
                .number()
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.summaryInputRatio),
            summaryOutputRatio: z
                .number()
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.summaryOutputRatio),
            releaseMinTokens: z
                .number()
                .step(1)
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.releaseMinTokens),
            releaseMaxWaitSteps: z
                .number()
                .step(1)
                .min(1)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.releaseMaxWaitSteps),
            releaseBacklogRatio: z
                .number()
                .min(Number.MIN_VALUE)
                .max(1)
                .default(schedulingDefaults.releaseBacklogRatio),
            cacheTtlMs: z
                .number()
                .step(1)
                .min(0)
                .max(Number.MAX_SAFE_INTEGER)
                .default(schedulingDefaults.cacheTtlMs),
        })
        .default({}),
    summary: z
        .object({
            reasoning: z.union(["preserve", "omit-from-summary"]).default("omit-from-summary"),
            images: z.union(["auto", "references"]).default("auto"),
        })
        .default({}),
    release: z
        .object({
            catalogLimit: z.number().step(1).min(1).max(128).default(32),
        })
        .default({}),
});
export function apply(ctx: Context, config: Config = {}) {
    if (config.uiOnly) {
        if (config.summaryModels === undefined)
            throw new Error("fold-context: settings require validated Config");
        new FoldContextSettings(ctx, config.summaryModels, config.policyOverrides);
        return;
    }
    // Runtime policy is captured once; an in-flight native transaction keeps one configuration.
    const policy = selectPolicyOverrides(
        {
            compaction: config.compaction ?? {},
            release: resolveReleasePolicy(config.release),
            summary: resolveSummaryPolicy(config.summary),
            scheduling: resolveSchedulingPolicy(config.scheduling),
            reminders: resolveReminderPolicy(config.reminders),
        },
        ctx.get("foldContextSettings")?.policies(),
    );
    const engine = new ContextCompressionEngine(
        ctx,
        policy.compaction,
        policy.release,
        policy.summary,
        policy.scheduling,
        policy.reminders,
        () =>
            ctx.get("foldContextSettings")?.current() ??
            resolveSummaryModels(config.summaryModels?.get() ?? []),
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
            "Queued releases apply together at a rewrite opportunity. Pressure first allows release, then remeasures whether a summary is needed. User and assistant text and signed replay blocks remain intact; protected assistant attachments wait for a covering summary. " +
            "Official checkpoints summarize a balanced historical prefix and retain the latest tail. Low-pressure timing considers savings, summary cost and additional cache rebuild cost; pressure, overflow and explicit compact remain safety paths. " +
            `Summary reasoning policy: ${engine.summaryPolicy.reasoning}. ` +
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
