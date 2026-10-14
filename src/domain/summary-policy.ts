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
    stampVersion: 1 | 2;
}
export function characterCount(text: string): number {
    let count = 0;
    for (const _character of text) count++;
    return count;
}
export function projectionStamp(
    policy: Pick<SummaryPolicy, "reasoning">,
    compactionId: string,
    images: "native" | "references" = "references",
): string {
    return `[fold-context-projection:2 ${JSON.stringify({ reasoning: policy.reasoning, images, compactionId })}]`;
}
export function readProjectionStamp(
    text: string | undefined,
    compactionId: string,
): ProjectionPolicy | null | undefined {
    if (!text?.startsWith("[fold-context-projection:")) return undefined;
    const version = text.startsWith("[fold-context-projection:1 ")
        ? 1
        : text.startsWith("[fold-context-projection:2 ")
          ? 2
          : null;
    if (version === null || !text.endsWith("]")) return null;
    try {
        const base = z.object({
            reasoning: z.enum(["preserve", "omit-from-summary"]),
            compactionId: z.string(),
        });
        const schema =
            version === 1
                ? base.strict()
                : base.extend({ images: z.enum(["native", "references"]) }).strict();
        const parsed = schema.safeParse(
            JSON.parse(text.slice(`[fold-context-projection:${version} `.length, -1)),
        );
        if (!parsed.success || parsed.data.compactionId !== compactionId) return null;
        return {
            reasoning: parsed.data.reasoning,
            images:
                "images" in parsed.data
                    ? (parsed.data.images as "native" | "references")
                    : "native",
            stampVersion: version,
        };
    } catch {
        return null;
    }
}
