import type { ValueSchemaSpec } from "@deepseek-ai/dsh-tools";

/** Keep optional values expressible when a model route requires every key. */
export function optionalParameter<const S extends ValueSchemaSpec>(schema: S, description: string) {
    return {
        oneOf: [schema, { type: "null" }] as const,
        description,
        default: null,
    };
}

/** Empty legacy placeholders carry the same meaning as an omitted filter. */
export function optionalText(value: string | null | undefined): string | undefined {
    return value === "" ? undefined : (value ?? undefined);
}

export function optionalItems<T>(value: readonly T[] | null | undefined): readonly T[] | undefined {
    return value?.length ? value : undefined;
}
