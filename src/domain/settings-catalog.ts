import { resolveFoldCompactionConfig, type FoldCompactionConfig } from "../config.js";
import { resolveReleasePolicy, type ReleasePolicy } from "./planner.js";
import { resolveSummaryPolicy, type SummaryPolicy } from "./summary-policy.js";
import { resolveSchedulingPolicy, type SchedulingPolicy } from "./scheduler.js";
import { resolveReminderPolicy, type ReminderPolicy } from "./reminder.js";

type Words = { zh: string; en: string };
export interface PolicyField {
    key: string;
    type: "integer" | "number" | "boolean" | "enum" | "steps";
    label: Words;
    help: Words;
    default: number | boolean | string | number[] | null;
    min?: number;
    max?: number;
    optional?: boolean;
    choices?: { value: string; label: Words }[];
}
export interface PolicyGroup {
    key: "compaction" | "release" | "summary" | "scheduling" | "reminders";
    label: Words;
    help: Words;
    fields: PolicyField[];
}
export interface PolicyValues {
    compaction: FoldCompactionConfig;
    release: ReleasePolicy;
    summary: SummaryPolicy;
    scheduling: SchedulingPolicy;
    reminders: ReminderPolicy;
}
export type PolicyOverrides = {
    [K in keyof PolicyValues]: { enabled: boolean; values: PolicyValues[K] };
};
const words = (zh: string, en: string): Words => ({ zh, en });
const field = (
    key: string,
    type: PolicyField["type"],
    initial: PolicyField["default"],
    zh: string,
    en: string,
    helpZh: string,
    helpEn: string,
    bounds: Pick<PolicyField, "min" | "max" | "optional" | "choices"> = {},
): PolicyField => ({
    key,
    type,
    default: initial,
    label: words(zh, en),
    help: words(helpZh, helpEn),
    ...bounds,
});
const count = { min: 0, max: Number.MAX_SAFE_INTEGER };
const positive = { min: 1, max: Number.MAX_SAFE_INTEGER };
const ratio = { min: 0, max: 1 };
const compact = resolveFoldCompactionConfig({});
const scheduling = resolveSchedulingPolicy();
const reminders = resolveReminderPolicy();

/** The same catalog drives Host validation and the compiled plain-JavaScript Client. */
export const POLICY_GROUPS: PolicyGroup[] = [
    {
        key: "compaction",
        label: words("自动压缩与保留", "Automatic compaction and retention"),
        help: words(
            "控制上下文压力阈值、保留范围与重试。自动压缩关闭后，显式压缩和溢出恢复仍可执行。",
            "Control pressure thresholds, retained context and retries. Explicit compaction and overflow recovery remain available when automation is off.",
        ),
        fields: [
            field(
                "auto",
                "boolean",
                compact.auto!,
                "自动压缩",
                "Automatic compaction",
                "允许因上下文压力自动生成摘要。",
                "Allow pressure-triggered automatic summaries.",
            ),
            field(
                "thresholdRatio",
                "number",
                compact.thresholdRatio!,
                "压力阈值比例",
                "Pressure threshold ratio",
                "占模型上下文窗口的比例，范围大于 0 且不超过 1。",
                "Fraction of the model context window, greater than 0 and at most 1.",
                { min: Number.MIN_VALUE, max: 1 },
            ),
            field(
                "headroomTokens",
                "integer",
                compact.headroomTokens!,
                "输出预留（tokens）",
                "Output headroom (tokens)",
                "为摘要输出预留的 token 数。",
                "Tokens reserved for summary output.",
                count,
            ),
            field(
                "retainRatio",
                "number",
                0.16,
                "保留最近上下文比例",
                "Recent-context retention ratio",
                "未指定固定保留 token 数时使用；0–1。",
                "Used when no fixed retention count is set; 0–1.",
                ratio,
            ),
            field(
                "retainTokens",
                "integer",
                null,
                "固定保留 token 数",
                "Fixed retention tokens",
                "留空使用比例；填写后优先于保留比例。",
                "Leave blank to use the ratio; a count takes precedence.",
                { ...count, optional: true },
            ),
            field(
                "maxTokens",
                "integer",
                null,
                "摘要输出上限（tokens）",
                "Summary output limit (tokens)",
                "留空跟随输出预留，且至少为 1。",
                "Leave blank to follow output headroom, with a minimum of 1.",
                { ...positive, optional: true },
            ),
            field(
                "compactionRetries",
                "integer",
                compact.compactionRetries!,
                "摘要重试次数",
                "Compaction retries",
                "单次摘要失败后的重试次数。",
                "Retries after a compaction attempt fails.",
                count,
            ),
            field(
                "maxOverflowRetries",
                "integer",
                compact.maxOverflowRetries!,
                "溢出恢复重试次数",
                "Overflow recovery retries",
                "模型报告上下文溢出后的恢复重试次数。",
                "Recovery retries after a model reports context overflow.",
                count,
            ),
        ],
    },
    {
        key: "release",
        label: words("检索目录", "Inspection catalog"),
        help: words(
            "设置 context_status 未指定 limit 时的返回数量。",
            "Set the default context_status result count when limit is omitted.",
        ),
        fields: [
            field(
                "catalogLimit",
                "integer",
                resolveReleasePolicy().catalogLimit,
                "默认目录条数",
                "Default catalog entries",
                "范围 1–128；查询仍可单独指定 limit。",
                "Range 1–128; individual queries can specify their own limit.",
                { min: 1, max: 128 },
            ),
        ],
    },
    {
        key: "summary",
        label: words("摘要内容", "Summary content"),
        help: words(
            "控制历史思考内容和图片如何进入摘要；原始证据仍可恢复。",
            "Control how historical reasoning and images enter summaries; originals remain recoverable.",
        ),
        fields: [
            field(
                "reasoning",
                "enum",
                resolveSummaryPolicy().reasoning,
                "历史思考内容",
                "Historical reasoning",
                "选择省略或作为历史资料保留。",
                "Omit it from summary input or preserve it as historical data.",
                {
                    choices: [
                        {
                            value: "omit-from-summary",
                            label: words("不放入摘要输入", "Omit from summary input"),
                        },
                        {
                            value: "preserve",
                            label: words("作为历史资料保留", "Preserve as historical data"),
                        },
                    ],
                },
            ),
            field(
                "images",
                "enum",
                resolveSummaryPolicy().images,
                "图片处理",
                "Image handling",
                "自动模式仅在摘要模型支持时传入图片，否则保留引用。",
                "Auto sends images only when the summary model supports them; otherwise it keeps references.",
                {
                    choices: [
                        { value: "auto", label: words("自动", "Automatic") },
                        { value: "references", label: words("仅保留引用", "References only") },
                    ],
                },
            ),
        ],
    },
    {
        key: "scheduling",
        label: words("摘要调度与合批释放", "Summary scheduling and release batching"),
        help: words(
            "低压力摘要需要满足间隔、节省和回本条件。成本比例仅用于估算，不是供应商真实价格。",
            "Low-pressure summaries must meet interval, savings and payback gates. Cost ratios are estimates, not provider prices.",
        ),
        fields: [
            field(
                "enabled",
                "boolean",
                scheduling.enabled,
                "启用低压力摘要调度",
                "Enable low-pressure summary scheduling",
                "关闭后模型请求保留在队列；压力和溢出恢复仍可执行。",
                "When off, model requests remain queued; pressure and overflow recovery remain available.",
            ),
            field(
                "proactive",
                "boolean",
                scheduling.proactive,
                "主动处理释放积压",
                "Proactive backlog summaries",
                "无显式摘要请求时，也评估已标记内容的积压。",
                "Evaluate marked backlog even without an explicit summary request.",
            ),
            field(
                "minIntervalSteps",
                "integer",
                scheduling.minIntervalSteps,
                "摘要最小间隔（步）",
                "Minimum summary interval (steps)",
                "两次低压力摘要之间的最少业务步数。",
                "Minimum business steps between low-pressure summaries.",
                count,
            ),
            field(
                "minSavingsTokens",
                "integer",
                scheduling.minSavingsTokens,
                "最少预计节省（tokens）",
                "Minimum estimated savings (tokens)",
                "预计节省低于此值时等待。",
                "Wait when estimated savings are below this value.",
                count,
            ),
            field(
                "minSavingsRatio",
                "number",
                scheduling.minSavingsRatio,
                "最少预计节省比例",
                "Minimum estimated savings ratio",
                "相对于释放后剩余提示的比例；0–1。",
                "Fraction of the prompt remaining after release; 0–1.",
                ratio,
            ),
            field(
                "expectedSummaryRatio",
                "number",
                scheduling.expectedSummaryRatio,
                "预计摘要长度比例",
                "Expected summary size ratio",
                "用于估算摘要输出大小，可以大于 1。",
                "Used to estimate summary size; values above 1 are allowed.",
                count,
            ),
            field(
                "paybackTurns",
                "integer",
                scheduling.paybackTurns,
                "预计回本请求数",
                "Payback request horizon",
                "预计未来多少次模型请求用于回收本次成本。",
                "Future model requests over which summary costs should be recovered.",
                positive,
            ),
            field(
                "cacheReadRatio",
                "number",
                scheduling.cacheReadRatio,
                "缓存读取成本比例",
                "Cache-read cost ratio",
                "相对于未缓存输入成本；0–1。",
                "Relative to uncached input cost; 0–1.",
                ratio,
            ),
            field(
                "summaryInputRatio",
                "number",
                scheduling.summaryInputRatio,
                "摘要输入成本比例",
                "Summary input cost ratio",
                "相对于主会话未缓存输入成本。",
                "Relative to the primary session's uncached input cost.",
                count,
            ),
            field(
                "summaryOutputRatio",
                "number",
                scheduling.summaryOutputRatio,
                "摘要输出成本比例",
                "Summary output cost ratio",
                "相对于主会话未缓存输入成本。",
                "Relative to the primary session's uncached input cost.",
                count,
            ),
            field(
                "releaseMinTokens",
                "integer",
                scheduling.releaseMinTokens,
                "合批释放最小估算（tokens）",
                "Minimum release batch estimate (tokens)",
                "达到可重建机会时，普通小批次使用此门槛。",
                "Threshold for ordinary small batches at a rebuild opportunity.",
                count,
            ),
            field(
                "releaseMaxWaitSteps",
                "integer",
                scheduling.releaseMaxWaitSteps,
                "释放最长等待（步）",
                "Maximum release wait (steps)",
                "标记内容最多等待多少个业务步骤。",
                "Maximum business steps marked content may wait.",
                positive,
            ),
            field(
                "releaseBacklogRatio",
                "number",
                scheduling.releaseBacklogRatio,
                "释放积压比例",
                "Release backlog ratio",
                "相对提示大小的积压门槛；大于 0 且不超过 1。",
                "Backlog threshold relative to prompt size; greater than 0 and at most 1.",
                { min: Number.MIN_VALUE, max: 1 },
            ),
            field(
                "cacheTtlMs",
                "integer",
                scheduling.cacheTtlMs,
                "缓存有效期估算（毫秒）",
                "Estimated cache TTL (milliseconds)",
                "0 关闭按时间推断缓存到期；仍需同路由缓存命中证据。",
                "0 disables time-based expiry assumptions; same-route cache-hit evidence is still required.",
                count,
            ),
        ],
    },
    {
        key: "reminders",
        label: words("释放候选提醒", "Release candidate reminders"),
        help: words(
            "控制 try_release 的触发、间隔和退避。提醒不会自动释放内容。",
            "Control try_release triggers, intervals and backoff. Reminders do not release content automatically.",
        ),
        fields: [
            field(
                "enabled",
                "boolean",
                reminders.enabled,
                "启用候选提醒",
                "Enable candidate reminders",
                "在通知中提示检查可释放证据。",
                "Suggest reviewing releasable evidence in allocation notices.",
            ),
            field(
                "minAgeSteps",
                "integer",
                reminders.minAgeSteps,
                "候选最小年龄（步）",
                "Minimum candidate age (steps)",
                "只考虑至少经过这些业务步数的证据。",
                "Consider only evidence at least this many business steps old.",
                count,
            ),
            field(
                "largeOutputTokens",
                "integer",
                reminders.largeOutputTokens,
                "大结果排序门槛（tokens）",
                "Large-result ranking threshold (tokens)",
                "仅影响候选排序，单个大结果不会直接触发提醒。",
                "A ranking hint only; a single large result does not trigger a reminder.",
                positive,
            ),
            field(
                "backlogTokens",
                "integer",
                reminders.backlogTokens,
                "常规积压门槛（tokens）",
                "Ordinary backlog threshold (tokens)",
                "达到此候选总量后评估常规提醒。",
                "Evaluate ordinary reminders at this total candidate estimate.",
                positive,
            ),
            field(
                "staleTokens",
                "integer",
                reminders.staleTokens,
                "陈旧积压门槛（tokens）",
                "Stale backlog threshold (tokens)",
                "持续停留的积压达到此值时评估提醒。",
                "Evaluate reminders when persistent backlog reaches this estimate.",
                positive,
            ),
            field(
                "staleSteps",
                "integer",
                reminders.staleSteps,
                "陈旧积压等待（步）",
                "Stale backlog wait (steps)",
                "积压持续多少个业务步骤后视为陈旧。",
                "Business steps backlog must persist before it is stale.",
                count,
            ),
            field(
                "pressureRatio",
                "number",
                reminders.pressureRatio,
                "压力提醒比例",
                "Pressure reminder ratio",
                "相对于实际压缩阈值的比例；0–1。",
                "Fraction of the actual compaction threshold; 0–1.",
                ratio,
            ),
            field(
                "minIntervalSteps",
                "integer",
                reminders.minIntervalSteps,
                "普通提醒间隔（步）",
                "Ordinary reminder interval (steps)",
                "普通提醒之间的最少业务步数。",
                "Minimum business steps between ordinary reminders.",
                positive,
            ),
            field(
                "pressureIntervalSteps",
                "integer",
                reminders.pressureIntervalSteps,
                "压力提醒间隔（步）",
                "Pressure reminder interval (steps)",
                "压力提醒之间的最少业务步数。",
                "Minimum business steps between pressure reminders.",
                positive,
            ),
            field(
                "ignoredBackoffSteps",
                "steps",
                reminders.ignoredBackoffSteps,
                "忽略后的退避步数",
                "Ignored-reminder backoff steps",
                "逗号分隔的 1–16 个正整数，按非递减顺序，例如 12, 24。",
                "1–16 comma-separated positive integers in nondecreasing order, for example 12, 24.",
                positive,
            ),
            field(
                "rearmGrowthTokens",
                "integer",
                reminders.rearmGrowthTokens,
                "重新触发所需增长（tokens）",
                "Growth needed to rearm (tokens)",
                "新增候选估算达到此值时，重新评估已退避的提醒。",
                "Reconsider backed-off reminders after this much candidate growth.",
                positive,
            ),
            field(
                "maxCandidates",
                "integer",
                reminders.maxCandidates,
                "单次提醒候选数",
                "Candidates per reminder",
                "通知只列出排名靠前的这些 ID；范围 1–128。",
                "List this many top-ranked IDs in a notice; range 1–128.",
                { min: 1, max: 128 },
            ),
        ],
    },
];

/** Kept self-contained so the Client uses this exact validator without a runtime import. */
export function normalizePolicyOverrides(input: unknown = {}): PolicyOverrides {
    const invalid = (path: string): never => {
        throw Object.assign(new Error(`Invalid policy setting: ${path}`), { path });
    };
    const record = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value);
    if (!record(input)) return invalid("policyOverrides");
    for (const key of Object.keys(input))
        if (!POLICY_GROUPS.some((group) => group.key === key)) invalid(key);
    const validate = (
        field: PolicyField,
        value: unknown,
        path: string,
        optional = false,
    ): unknown => {
        if (value === undefined) {
            if (optional || field.optional) return undefined;
            if (Array.isArray(field.default)) return [...field.default];
            return field.default;
        }
        if (field.type === "boolean") {
            if (typeof value !== "boolean") invalid(path);
        } else if (field.type === "enum") {
            if (!field.choices?.some((choice) => choice.value === value)) invalid(path);
        } else {
            const items = field.type === "steps" ? value : [value];
            if (
                !Array.isArray(items) ||
                (field.type === "steps" && (items.length < 1 || items.length > 16))
            )
                invalid(path);
            for (const [index, item] of (items as unknown[]).entries()) {
                if (
                    typeof item !== "number" ||
                    !Number.isFinite(item) ||
                    ((field.type === "integer" || field.type === "steps") &&
                        !Number.isSafeInteger(item)) ||
                    (field.min !== undefined && item < field.min) ||
                    (field.max !== undefined && item > field.max)
                )
                    invalid(path);
                if (
                    field.type === "steps" &&
                    index > 0 &&
                    (item as number) < (items as number[])[index - 1]!
                )
                    invalid(path);
            }
        }
        return Array.isArray(value) ? [...value] : value;
    };
    const result: Record<string, unknown> = {};
    for (const group of POLICY_GROUPS) {
        const entry = input[group.key] === undefined ? {} : input[group.key];
        if (!record(entry)) return invalid(group.key);
        if (Object.keys(entry).some((key) => key !== "enabled" && key !== "values"))
            invalid(group.key);
        const enabled = entry.enabled === undefined ? false : entry.enabled;
        if (typeof enabled !== "boolean") invalid(`${group.key}.enabled`);
        const source = entry.values === undefined ? {} : entry.values;
        if (!record(source)) return invalid(`${group.key}.values`);
        const allowed = group.fields.map((field) => field.key);
        if (group.key === "compaction") allowed.push("modelPolicies");
        if (Object.keys(source).some((key) => !allowed.includes(key)))
            invalid(`${group.key}.values`);
        const values: Record<string, unknown> = {};
        for (const field of group.fields) {
            const value = validate(field, source[field.key], `${group.key}.${field.key}`);
            if (value !== undefined) values[field.key] = value;
        }
        if (group.key === "compaction") {
            const policies = source.modelPolicies ?? [];
            if (!Array.isArray(policies) || policies.length > 128)
                invalid("compaction.modelPolicies");
            values.modelPolicies = (policies as unknown[]).map((policy, index) => {
                const path = `compaction.modelPolicies.${index}`;
                if (
                    !record(policy) ||
                    typeof policy.provider !== "string" ||
                    !policy.provider.length ||
                    typeof policy.model !== "string" ||
                    !policy.model.length
                )
                    return invalid(path);
                const fields = group.fields.filter((field) => field.key !== "auto");
                if (
                    Object.keys(policy).some(
                        (key) =>
                            key !== "provider" &&
                            key !== "model" &&
                            !fields.some((field) => field.key === key),
                    )
                )
                    invalid(path);
                const row: Record<string, unknown> = {
                    provider: policy.provider,
                    model: policy.model,
                };
                for (const field of fields) {
                    const value = validate(field, policy[field.key], `${path}.${field.key}`, true);
                    if (value !== undefined) row[field.key] = value;
                }
                return row;
            });
        }
        result[group.key] = { enabled, values };
    }
    return result as PolicyOverrides;
}
