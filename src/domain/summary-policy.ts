import { z } from "zod";

export const summaryPolicySchema = z.object({
    reasoning: z.enum(["preserve", "omit-from-summary"]).default("omit-from-summary"),
    images: z.enum(["auto", "references"]).default("auto"),
});
export type SummaryPolicy = z.infer<typeof summaryPolicySchema>;
export const resolveSummaryPolicy = (value: Partial<SummaryPolicy> = {}): Readonly<SummaryPolicy> =>
    Object.freeze(summaryPolicySchema.parse(value));
export interface ProjectionPolicy {
    reasoning: SummaryPolicy["reasoning"];
    images: "native" | "references";
}
export function characterCount(text: string): number {
    let count = 0;
    for (const _character of text) count++;
    return count;
}
export function projectionStamp(
    policy: Pick<SummaryPolicy, "reasoning">,
    compactionId: string,
    images: ProjectionPolicy["images"],
): string {
    return `[fold-context-projection:2 ${JSON.stringify({ reasoning: policy.reasoning, images, compactionId })}]`;
}
export function readProjectionStamp(
    text: string | undefined,
    compactionId: string,
): ProjectionPolicy | null | undefined {
    if (!text?.startsWith("[fold-context-projection:")) return undefined;
    const prefix = "[fold-context-projection:2 ";
    if (!text.startsWith(prefix) || !text.endsWith("]")) return null;
    try {
        const parsed = z
            .object({
                reasoning: z.enum(["preserve", "omit-from-summary"]),
                images: z.enum(["native", "references"]),
                compactionId: z.string(),
            })
            .strict()
            .safeParse(JSON.parse(text.slice(prefix.length, -1)));
        if (!parsed.success || parsed.data.compactionId !== compactionId) return null;
        return {
            reasoning: parsed.data.reasoning,
            images: parsed.data.images,
        };
    } catch {
        return null;
    }
}
