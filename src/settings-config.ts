import z from "@deepseek-ai/schemastery";
import {
    POLICY_GROUPS,
    normalizePolicyOverrides,
    type PolicyField,
    type PolicyOverrides,
    type PolicyValues,
} from "./domain/settings-catalog.js";
function fieldSchema(field: PolicyField, defaults: boolean): Schemastery {
    const schema: Schemastery =
        field.type === "boolean"
            ? z.boolean()
            : field.type === "enum"
              ? z.union(field.choices!.map((choice) => choice.value))
              : field.type === "integer"
                ? z.number().step(1)
                : z.number();
    if (field.min !== undefined) schema.min(field.min);
    if (field.max !== undefined) schema.max(field.max);
    return defaults && field.default !== null ? schema.default(field.default) : schema;
}
function groups(defaults: boolean) {
    return Object.fromEntries(
        POLICY_GROUPS.map((group) => {
            const fields: Record<string, Schemastery> = Object.fromEntries(
                group.fields.map((field) => [field.key, fieldSchema(field, defaults)]),
            );
            if (group.key === "compaction")
                fields.modelPolicies = z
                    .array(
                        z.object({
                            provider: z.string().min(1).required(),
                            model: z.string().min(1).required(),
                            ...Object.fromEntries(
                                group.fields
                                    .filter((field) => field.perModel)
                                    .map((field) => [field.key, fieldSchema(field, false)]),
                            ),
                        }),
                    )
                    .max(128);
            if (fields.modelPolicies) delete fields.modelPolicies.meta.default;
            return [group.key, z.object(fields).default({})];
        }),
    );
}
const validateKeys = z.transform(
    z.any(),
    (value: unknown) => {
        normalizePolicyOverrides(value);
        return {};
    },
    true,
);
export const policySchema: Schemastery = z.intersect([validateKeys, z.object(groups(true))]);
export const policyOverridesSchema: Schemastery<any, PolicyOverrides, "defined"> = z
    .transform(z.intersect([validateKeys, z.object(groups(false))]), normalizePolicyOverrides, true)
    .default({});
export function selectPolicyOverrides(
    base: PolicyValues,
    overrides?: PolicyOverrides,
): PolicyValues {
    const values = normalizePolicyOverrides(overrides);
    return structuredClone({
        compaction: { ...base.compaction, ...values.compaction },
        summary: { ...base.summary, ...values.summary },
        scheduling: { ...base.scheduling, ...values.scheduling },
        reminders: { ...base.reminders, ...values.reminders },
    });
}
