import z from "@deepseek-ai/schemastery";
import {
    POLICY_GROUPS,
    normalizePolicyOverrides,
    type PolicyField,
    type PolicyOverrides,
    type PolicyValues,
} from "./domain/settings-catalog.js";

function fieldSchema(field: PolicyField, inherit = false): Schemastery {
    const schema: Schemastery =
        field.type === "boolean"
            ? z.boolean()
            : field.type === "enum"
              ? z.union(field.choices!.map((choice) => choice.value))
              : field.type === "steps"
                ? z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).min(1).max(16)
                : field.type === "integer"
                  ? z.number().step(1)
                  : z.number();
    if (field.min !== undefined && field.type !== "steps") schema.min(field.min);
    if (field.max !== undefined && field.type !== "steps") schema.max(field.max);
    return !inherit && field.default !== null ? schema.default(field.default) : schema;
}
const groups = Object.fromEntries(
    POLICY_GROUPS.map((group) => {
        const fields: Record<string, Schemastery> = Object.fromEntries(
            group.fields.map((field) => [field.key, fieldSchema(field)]),
        );
        if (group.key === "compaction")
            fields.modelPolicies = z
                .array(
                    z.object({
                        provider: z.string().min(1).required(),
                        model: z.string().min(1).required(),
                        ...Object.fromEntries(
                            group.fields
                                .filter((field) => field.key !== "auto")
                                .map((field) => [field.key, fieldSchema(field, true)]),
                        ),
                    }),
                )
                .max(128);
        return [
            group.key,
            z
                .object({
                    enabled: z.boolean().default(false),
                    values: z.object(fields).default({}),
                })
                .default({}),
        ];
    }),
);

/** A profile-wide override is opt-in per group, preserving existing preset policy. */
export const policyOverridesSchema = z
    .transform(z.object(groups), normalizePolicyOverrides, true)
    .default({});

export function selectPolicyOverrides(
    base: PolicyValues,
    overrides?: PolicyOverrides,
): PolicyValues {
    return {
        compaction: structuredClone(
            overrides?.compaction.enabled ? overrides.compaction.values : base.compaction,
        ),
        release: structuredClone(
            overrides?.release.enabled ? overrides.release.values : base.release,
        ),
        summary: structuredClone(
            overrides?.summary.enabled ? overrides.summary.values : base.summary,
        ),
        scheduling: structuredClone(
            overrides?.scheduling.enabled ? overrides.scheduling.values : base.scheduling,
        ),
        reminders: structuredClone(
            overrides?.reminders.enabled ? overrides.reminders.values : base.reminders,
        ),
    };
}
