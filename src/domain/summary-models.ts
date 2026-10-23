import { z } from "zod";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";

export const summaryModelSchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
    preferWhenSessionMatches: z.boolean().default(true),
    useSessionAgent: z.boolean().default(false),
});
export type SummaryModel = z.infer<typeof summaryModelSchema>;
export type SummaryRoute = Pick<LlmCallConfig, "provider" | "model">;
export const sameSummaryRoute = (
    left: Pick<SummaryRoute, "provider" | "model">,
    right: Pick<SummaryRoute, "provider" | "model">,
): boolean => left.provider === right.provider && left.model === right.model;

/** Validate at every settings read, so edits cannot install malformed runtime policy. */
export function resolveSummaryModels(value: unknown): SummaryModel[] {
    return z.array(summaryModelSchema).max(32).parse(value);
}

/** Stable partition; priority never introduces a model outside a nonempty list. */
export function summaryCandidates(
    models: readonly SummaryModel[],
    current: SummaryRoute,
): SummaryModel[] {
    if (models.length === 0)
        return [
            {
                provider: current.provider,
                model: current.model,
                preferWhenSessionMatches: true,
                useSessionAgent: false,
            },
        ];
    const priority = (item: SummaryModel) =>
        item.preferWhenSessionMatches && sameSummaryRoute(item, current);
    return [...models.filter(priority), ...models.filter((item) => !priority(item))].map(
        (item) => ({ ...item }),
    );
}
