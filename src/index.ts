import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
    BasicCompactionEngine,
    type BasicCompactionConfig,
} from "@deepseek-ai/dsh-compaction-basic";
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
    compaction?: BasicCompactionConfig;
    release?: Partial<ReleasePolicy>;
    summary?: Partial<SummaryPolicy>;
    scheduling?: Partial<SchedulingPolicy>;
    reminders?: Partial<ReminderPolicy>;
}
const schedulingDefaults = resolveSchedulingPolicy();

export const Config = z.object({
    uiOnly: z.boolean().default(false),
    compaction: BasicCompactionEngine.Config.default({}),
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
    if (config.uiOnly) return;
    const engine = new ContextCompressionEngine(
        ctx,
        config.compaction ?? {},
        resolveReleasePolicy(config.release),
        resolveSummaryPolicy(config.summary),
        resolveSchedulingPolicy(config.scheduling),
        resolveReminderPolicy(config.reminders),
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
export default { name, inject, Config, apply };
