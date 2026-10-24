import z from "@deepseek-ai/schemastery";
import { summaryModelSchema, type SummaryModel } from "./domain/summary-models.js";

/** User policy; native engine execution options are derived separately. */
export interface FoldCompactionPolicy {
    targetTokens?: number;
    cacheReadRatio?: number;
}
export interface FoldCompactionConfig extends FoldCompactionPolicy {
    auto?: boolean;
    summaryMaxTokens?: number;
    modelPolicies?: (FoldCompactionPolicy & { provider: string; model: string })[];
}
export const summaryModelConfigSchema: Schemastery<any, SummaryModel> = z.transform(
    z.object({
        provider: z.string().min(1).required(),
        model: z.string().min(1).required(),
        reasoningEffort: z.string().min(1),
        preferWhenSessionMatches: z.boolean(),
        useSessionAgent: z.boolean().default(false),
        onlyWhenSessionMatches: z.boolean().default(false),
    }),
    (value) => summaryModelSchema.parse(value),
    true,
);

export function resolveFoldCompactionConfig(config: FoldCompactionConfig) {
    return {
        auto: true,
        cacheReadRatio: 0.1,
        summaryMaxTokens: 8192,
        modelPolicies: [],
        ...config,
    };
}
/** Only the adapter speaks the native engine's execution vocabulary. */
export function nativeCompactionConfig(config: FoldCompactionConfig) {
    const resolved = resolveFoldCompactionConfig(config);
    return {
        auto: true,
        thresholdRatio: 0.9,
        retainRatio: 1 / 6,
        headroomTokens: resolved.summaryMaxTokens,
        maxTokens: resolved.summaryMaxTokens,
        compactionRetries: 1,
        maxOverflowRetries: 1,
        modelPolicies: [],
    };
}
