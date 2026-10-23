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
    execution?: "session" | "independent";
}
export function characterCount(text: string): number {
    let count = 0;
    for (const _character of text) count++;
    return count;
}
const projectionPrefix = "[fold-context-projection:";
const legacyProjectionPrefix = `${projectionPrefix}2 `;
const currentProjectionPrefix = `${projectionPrefix}3 `;
const projectionIdentitySchema = z.string().regex(/\S/, "Expected a non-empty projection identity");
const projectionRecipeFields = {
    reasoning: z.enum(["preserve", "omit-from-summary"]),
    images: z.enum(["native", "references"]),
};
const legacyProjectionSchema = z
    .object({ ...projectionRecipeFields, compactionId: projectionIdentitySchema })
    .strict();
const currentProjectionSchema = z.discriminatedUnion("execution", [
    z
        .object({
            ...projectionRecipeFields,
            execution: z.literal("independent"),
            compactionId: projectionIdentitySchema,
            checkpointId: projectionIdentitySchema.optional(),
        })
        .strict(),
    z
        .object({
            reasoning: z.literal("preserve"),
            images: z.literal("native"),
            execution: z.literal("session"),
            compactionId: projectionIdentitySchema,
            checkpointId: projectionIdentitySchema,
        })
        .strict(),
]);
interface CheckpointIdentity {
    checkpointId: string;
    execution: "session" | "independent";
}
interface ParsedProjectionStamp {
    policy: ProjectionPolicy;
    identity: CheckpointIdentity | null;
}

function writeProjectionStamp(value: z.input<typeof currentProjectionSchema>): string {
    return `${currentProjectionPrefix}${JSON.stringify(currentProjectionSchema.parse(value))}]`;
}

export function projectionStamp(
    policy: Pick<SummaryPolicy, "reasoning">,
    compactionId: string,
    images: ProjectionPolicy["images"],
    checkpointId?: string,
): string {
    return writeProjectionStamp({
        reasoning: policy.reasoning,
        images,
        execution: "independent",
        compactionId,
        ...(checkpointId === undefined ? {} : { checkpointId }),
    });
}
export function sessionSummaryStamp(compactionId: string, checkpointId: string): string {
    return writeProjectionStamp({
        reasoning: "preserve",
        images: "native",
        execution: "session",
        compactionId,
        checkpointId,
    });
}

/** Decode once for both policy and checkpoint identity; v2 is historical policy only. */
function parseProjectionStamp(
    text: string | undefined,
    compactionId: string,
): ParsedProjectionStamp | null | undefined {
    if (!text?.startsWith(projectionPrefix)) return undefined;
    const version3 = text.startsWith(currentProjectionPrefix);
    const prefix = version3 ? currentProjectionPrefix : legacyProjectionPrefix;
    if (!text.startsWith(prefix) || !text.endsWith("]")) return null;
    try {
        const value: unknown = JSON.parse(text.slice(prefix.length, -1));
        if (!version3) {
            const parsed = legacyProjectionSchema.safeParse(value);
            if (!parsed.success || parsed.data.compactionId !== compactionId) return null;
            return {
                policy: { reasoning: parsed.data.reasoning, images: parsed.data.images },
                identity: null,
            };
        }
        const parsed = currentProjectionSchema.safeParse(value);
        if (!parsed.success || parsed.data.compactionId !== compactionId) return null;
        const { reasoning, images, execution, checkpointId } = parsed.data;
        return {
            policy: { reasoning, images, execution },
            identity: checkpointId === undefined ? null : { checkpointId, execution },
        };
    } catch {
        return null;
    }
}

export function readProjectionStamp(
    text: string | undefined,
    compactionId: string,
): ProjectionPolicy | null | undefined {
    const parsed = parseProjectionStamp(text, compactionId);
    return parsed === undefined || parsed === null ? parsed : parsed.policy;
}
export function readSessionSummaryIdentity(
    text: string | undefined,
    compactionId: string,
): CheckpointIdentity | null {
    return parseProjectionStamp(text, compactionId)?.identity ?? null;
}
