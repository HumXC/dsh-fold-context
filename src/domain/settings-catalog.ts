import type { FoldCompactionConfig } from "../config.js";
import type { SummaryPolicy } from "./summary-policy.js";
import type { SchedulingPolicy } from "./scheduler.js";
import type { ReminderPolicy } from "./reminder.js";
type Words = { zh: string; en: string };
export interface PolicyField {
    key: string;
    type: "integer" | "number" | "boolean" | "enum";
    label: Words;
    help: Words;
    default: number | boolean | string | null;
    min?: number;
    max?: number;
    optional?: boolean;
    perModel?: boolean;
    choices?: { value: string; label: Words }[];
}
export interface PolicyGroup {
    key: "compaction" | "summary" | "scheduling" | "reminders";
    label: Words;
    help: Words;
    fields: PolicyField[];
}
export interface PolicyValues {
    compaction: FoldCompactionConfig;
    summary: SummaryPolicy;
    scheduling: SchedulingPolicy;
    reminders: ReminderPolicy;
}
/** Each omitted field inherits the preset; no group switches or legacy wrappers. */
export type PolicyOverrides = { [K in keyof PolicyValues]: Partial<PolicyValues[K]> };
const words = (zh: string, en: string): Words => ({ zh, en });
const field = (
    key: string,
    type: PolicyField["type"],
    initial: PolicyField["default"],
    zh: string,
    en: string,
    helpZh: string,
    helpEn: string,
    bounds: Partial<PolicyField> = {},
): PolicyField => ({
    key,
    type,
    default: initial,
    label: words(zh, en),
    help: words(helpZh, helpEn),
    ...bounds,
});
export const POLICY_GROUPS: PolicyGroup[] = [
    {
        key: "compaction",
        label: words("窗口与自动摘要", "Window and automation"),
        help: words(
            "未设置的字段继承预设。模型专属值覆盖通用值。",
            "Omitted fields inherit the preset. Model-specific values override general values.",
        ),
        fields: [
            field(
                "auto",
                "boolean",
                true,
                "自动摘要",
                "Automatic summaries",
                "允许调度器主动生成摘要；关闭后仍处理已有申请和窗口安全恢复。",
                "Allow proactive summaries; queued requests and safety recovery remain available.",
            ),
            field(
                "targetTokens",
                "integer",
                null,
                "最佳窗口（token）",
                "Target window (tokens)",
                "留空自动推导；高于安全边界时按实际容量限制。",
                "Leave automatic; constrained by the actual safety boundary.",
                { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true, perModel: true },
            ),
            field(
                "cacheReadRatio",
                "number",
                0.1,
                "缓存成本比",
                "Cache read cost ratio",
                "未缓存输入为 1；缓存越便宜，摘要越倾向于合批延后。",
                "Uncached input costs 1; cheaper cache favors deferred batching.",
                { min: 0, max: 1, perModel: true },
            ),
            field(
                "summaryMaxTokens",
                "integer",
                8192,
                "摘要输出上限",
                "Summary output limit",
                "限制摘要输出，不改变主会话的输出配置。",
                "Limits summary output without changing the primary model's output configuration.",
                { min: 1, max: Number.MAX_SAFE_INTEGER },
            ),
        ],
    },
    {
        key: "scheduling",
        label: words("成本估算", "Cost assumptions"),
        help: words("相对成本，无需实际价格。", "Relative costs; no currency prices required."),
        fields: [
            field(
                "summaryInputRatio",
                "number",
                1,
                "摘要输入成本比",
                "Summary input cost ratio",
                "相对于主会话未缓存输入的成本。",
                "Relative to primary uncached input.",
                { min: 0, max: Number.MAX_SAFE_INTEGER },
            ),
            field(
                "summaryOutputRatio",
                "number",
                1,
                "摘要输出成本比",
                "Summary output cost ratio",
                "相对于主会话未缓存输入的成本。",
                "Relative to primary uncached input.",
                { min: 0, max: Number.MAX_SAFE_INTEGER },
            ),
            field(
                "cacheTtlMs",
                "integer",
                0,
                "缓存有效期假设（毫秒）",
                "Assumed cache TTL (ms)",
                "0 表示不按时间假定失效；仅在明确了解供应商缓存规则时填写。",
                "0 disables time-based expiry assumptions; set only with known provider semantics.",
                { min: 0, max: Number.MAX_SAFE_INTEGER },
            ),
        ],
    },
    {
        key: "summary",
        label: words("摘要内容", "Summary content"),
        help: words(
            "保留任务所需证据和可恢复引用。",
            "Preserve task evidence and recoverable references.",
        ),
        fields: [
            field(
                "reasoning",
                "enum",
                "omit-from-summary",
                "历史思考",
                "Historical reasoning",
                "控制摘要输入中的历史思考。",
                "Controls historical reasoning in summary input.",
                {
                    choices: [
                        { value: "omit-from-summary", label: words("省略", "Omit") },
                        { value: "preserve", label: words("保留", "Preserve") },
                    ],
                },
            ),
            field(
                "images",
                "enum",
                "auto",
                "图片处理",
                "Images",
                "自动处理或仅保留引用。",
                "Automatic handling or references only.",
                {
                    choices: [
                        { value: "auto", label: words("自动", "Automatic") },
                        { value: "references", label: words("引用", "References") },
                    ],
                },
            ),
        ],
    },
    {
        key: "reminders",
        label: words("释放提醒", "Release reminders"),
        help: words(
            "提示模型判断内容价值，不自动授权释放。",
            "Ask the model to assess evidence; reminders never authorize release.",
        ),
        fields: [
            field(
                "enabled",
                "boolean",
                true,
                "候选提醒",
                "Candidate reminders",
                "按窗口压力、候选收益和状态变化合并提醒。",
                "Batch reminders using pressure, candidate benefit and state changes.",
            ),
        ],
    },
];
/** Shared with the bundled Client; rejects unknown/legacy keys. */
export function normalizePolicyOverrides(input: unknown = {}): PolicyOverrides {
    const invalid = (path: string): never => {
        throw Object.assign(new Error("Invalid policy setting: " + path), { path });
    };
    const record = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value);
    if (!record(input)) return invalid("policyOverrides");
    for (const key of Object.keys(input))
        if (!POLICY_GROUPS.some((group) => group.key === key)) invalid(key);
    const validate = (field: PolicyField, value: unknown, path: string): unknown => {
        if (value === undefined) return undefined;
        if (field.type === "boolean") {
            if (typeof value !== "boolean") invalid(path);
        } else if (field.type === "enum") {
            if (!field.choices?.some((choice) => choice.value === value)) invalid(path);
        } else if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            (field.type === "integer" && !Number.isSafeInteger(value)) ||
            (field.min !== undefined && value < field.min) ||
            (field.max !== undefined && value > field.max)
        )
            invalid(path);
        return value;
    };
    const result: Record<string, unknown> = {};
    for (const group of POLICY_GROUPS) {
        const source = input[group.key] === undefined ? {} : input[group.key];
        if (!record(source)) return invalid(group.key);
        const allowed = group.fields.map((field) => field.key);
        if (group.key === "compaction") allowed.push("modelPolicies");
        for (const key of Object.keys(source))
            if (!allowed.includes(key)) invalid(group.key + "." + key);
        const values: Record<string, unknown> = {};
        for (const field of group.fields) {
            const value = validate(field, source[field.key], group.key + "." + field.key);
            if (value !== undefined) values[field.key] = value;
        }
        if (group.key === "compaction" && source.modelPolicies !== undefined) {
            if (!Array.isArray(source.modelPolicies) || source.modelPolicies.length > 128)
                invalid("compaction.modelPolicies");
            const routes = new Set<string>();
            values.modelPolicies = (source.modelPolicies as unknown[]).map((policy, index) => {
                const path = "compaction.modelPolicies." + index;
                if (
                    !record(policy) ||
                    typeof policy.provider !== "string" ||
                    !policy.provider.trim() ||
                    typeof policy.model !== "string" ||
                    !policy.model.trim()
                )
                    return invalid(path);
                const key = JSON.stringify([policy.provider, policy.model]);
                if (routes.has(key)) invalid(path);
                routes.add(key);
                const fields = group.fields.filter((field) => field.perModel);
                for (const key of Object.keys(policy))
                    if (
                        key !== "provider" &&
                        key !== "model" &&
                        !fields.some((field) => field.key === key)
                    )
                        invalid(path + "." + key);
                const row: Record<string, unknown> = {
                    provider: policy.provider,
                    model: policy.model,
                };
                for (const field of fields) {
                    const value = validate(field, policy[field.key], path + "." + field.key);
                    if (value !== undefined) row[field.key] = value;
                }
                return row;
            });
        }
        result[group.key] = values;
    }
    return result as PolicyOverrides;
}
