import z from "@deepseek-ai/schemastery";

/** Fold owns its configuration vocabulary; the official engine only executes it. */
export interface FoldCompactionPolicy {
    thresholdRatio?: number;
    headroomTokens?: number;
    retainRatio?: number;
    retainTokens?: number;
    maxTokens?: number;
    compactionRetries?: number;
    maxOverflowRetries?: number;
}
export interface FoldCompactionConfig extends FoldCompactionPolicy {
    auto?: boolean;
    modelPolicies?: (FoldCompactionPolicy & { provider: string; model: string })[];
}
const policyFields = {
    thresholdRatio: z.number().min(Number.MIN_VALUE).max(1),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number().min(0).max(1),
    retainTokens: z.number().step(1).min(0),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
};
export const foldCompactionSchema = z.object({
    ...policyFields,
    auto: z.boolean(),
    modelPolicies: z.array(
        z.object({
            provider: z.string().min(1).required(),
            model: z.string().min(1).required(),
            ...policyFields,
        }),
    ),
});
export const summaryModelConfigSchema = z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    reasoningEffort: z.string().min(1),
    preferWhenSessionMatches: z.boolean().default(true),
});

export function resolveFoldCompactionConfig(config: FoldCompactionConfig): FoldCompactionConfig {
    const headroomTokens = config.headroomTokens ?? 65536;
    return {
        thresholdRatio: 0.8,
        headroomTokens,
        maxTokens: Math.max(1, headroomTokens),
        compactionRetries: 1,
        maxOverflowRetries: 1,
        modelPolicies: [],
        auto: true,
        ...(config.retainTokens === undefined && config.retainRatio === undefined
            ? { retainRatio: 0.16 }
            : {}),
        ...config,
    };
}
