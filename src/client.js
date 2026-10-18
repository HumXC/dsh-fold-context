window.__ModuleLoader__.load({
    id: "dsh-fold-context",
    factory(require) {
        const React = require("react");
        const h = React.createElement;
        const REPORT = "foldContextRelease";
        const KIND = "fold-context-release";
        const TOOLS = {
            context_release: ["release", "archive"],
            context_expand: ["expand", "refresh"],
            context_search: ["search", "search"],
            context_compact: ["compact", "archive"],
            context_status: ["status", "list"],
        };
        const zh = {
            release: "标记弃用上下文",
            expand: "恢复上下文",
            search: "搜索上下文",
            compact: "请求压缩上下文",
            status: "查看上下文状态",
            completed: "已释放上下文",
            tokenReduction: "预计减少 {count} tokens",
            tokenIncrease: "预计增加 {count} tokens",
            preparing: "准备中",
            running: "处理中",
            failed: "执行失败",
            stopped: "已中断",
            queued: "已标记，等待处理",
            settled: "已处理",
            rejected: "请求未接受",
            accepted: "已接受",
            pending: "等待处理",
            released: "已释放",
            available: "可用",
            summarized: "已由摘要覆盖",
            items: "项",
            matches: "条匹配",
            records: "项记录",
            reason: "原因",
            result: "处理结果",
            targets: "目标编号",
            unknown: "编号不存在",
            unsupported: "不支持此操作",
            already_queued: "已在队列中",
            compactQueued: "已排队，等待调度",
            compactScope: "处理范围",
            balancedScope: "历史前缀；保留最近的完整对话尾部",
            found: "已读取原文",
            unbound: "编号尚未绑定内容",
            offset_out_of_range: "读取范围超出内容",
            attachment_store_unavailable: "附件存储不可用",
            capability_unsupported: "当前模型不支持读取图片",
            path_unavailable: "文件已验证，暂时无法提供本地路径",
            source: "来源",
            content: "原文",
            page: "读取范围",
            more: "还有后续内容",
            nextOffset: "下一页偏移",
            hasMore: "还有更多匹配",
            none: "无",
            noMatches: "没有找到匹配内容",
            noRecords: "没有符合条件的记录",
            query: "搜索内容",
            filters: "筛选",
            tool: "工具",
            role: "角色",
            attachment: "附件",
            file: "文件",
            image: "图片",
            user: "用户",
            assistant: "助手",
            bytes: "字节",
            openFile: "打开文件",
            imageLoading: "正在加载图片",
            imageFailed: "图片预览不可用",
            retained: "原文保留在会话日志中；读取原文不会撤销释放状态。",
            inspect: "检查调用",
            fallback: "无法识别此记录的结构，以下为记录原文。",
            waiting: "调度等待",
            execute: "可以执行",
            disabled: "未启用",
            decision: "调度结果",
            invalid_capacity: "模型上下文窗口无效",
            missing_capacity: "模型未声明上下文窗口",
            metadata_unavailable: "无法读取模型配置",
            no_route: "尚未配置会话模型",
            state_changed: "规划期间会话发生变化",
            active_compaction: "已有摘要事务正在执行",
            no_business_evidence: "历史前缀没有新的业务证据",
            ineffective_compaction: "上次摘要未降低实际压力",
            paybackRequests: "预计回本请求 / 策略上限",
            upfrontCost: "摘要与重建成本",
            protectedInput: "固定提示与受保护输入",
            cacheBasis: "缓存估算来源",
            assumed_cached: "未知命中情况，保守假定已缓存",
            primary_usage: "最近主请求的用量报告",
            noFinitePayback: "无法预计有限回本周期",
            costUnits: "归一化 tokens（估算）",
            nextAction: "下一步",
            checkModelAction: "检查会话路由与模型 contextWindow 配置。",
            checkFailureAction: "检查最近摘要错误并修正原因，原请求会保留。",
            checkPolicyAction: "检查 auto、enabled 和 proactive 配置。",
            verifyUsageAction: "摘要后查看下一次主请求用量，确认压力是否下降。",
            boundaryAction: "等待下一个可执行的步骤边界。",
            waitSummaryAction: "等待当前摘要事务完成。",
            continueAction: "继续当前任务；排队请求会在后续边界重新评估。",
            fixed_overhead: "固定提示与工具定义已达到压力阈值，仅压缩历史无法达标。",
            protected_input: "固定提示与当前任务尾部已达到压力阈值，需缩短固定输入或拆分当前任务。",
            not_paid_back: "尚未达到预计回本门槛",
            min_interval: "尚未达到最小处理间隔",
            insufficient_savings: "预计节省不足",
            min_savings: "预计节省不足",
            min_ratio: "预计节省比例不足",
            no_selection: "没有同时满足保留预算与任务保护的完整历史前缀",
            no_marks: "没有待处理标记",
            eligible: "满足调度条件",
            safety_pressure: "上下文压力触发",
            safety_overflow: "上下文溢出触发",
            failed_cooldown: "上次摘要失败，等待重试间隔",
            awaiting_step_boundary: "等待下一处理边界",
            protocol_protection: "受协议保护",
            awaiting_covering_summary: "等待摘要覆盖",
            summary_in_progress: "摘要生成中",
            outside_selection: "未纳入最近一次处理范围",
            summary_failed: "摘要处理失败",
            lastSummary: "最近摘要",
            omitted: "未展示",
            estimate: "预计净节省",
            tokens: "tokens（估算）",
            recovered: "已恢复的内容",
            releaseStatus: "释放状态",
            name: "名称",
            size: "大小",
            copyId: "复制编号",
            copied: "已复制",
            noPreview: "未记录内容预览",
        };
        const en = {
            release: "Mark context for release",
            expand: "Recover context",
            search: "Search context",
            compact: "Request context compaction",
            status: "Inspect context status",
            completed: "Context released",
            tokenReduction: "Estimated reduction: {count} tokens",
            tokenIncrease: "Estimated increase: {count} tokens",
            preparing: "Preparing",
            running: "Processing",
            failed: "Failed",
            stopped: "Interrupted",
            queued: "Marked; awaiting processing",
            settled: "Already processed",
            rejected: "Request rejected",
            accepted: "Accepted",
            pending: "Pending",
            released: "Released",
            available: "Available",
            summarized: "Covered by a summary",
            items: "items",
            matches: "matches",
            records: "records",
            reason: "Reason",
            result: "Result",
            targets: "Target IDs",
            unknown: "Unknown ID",
            unsupported: "Operation unsupported",
            already_queued: "Already queued",
            compactQueued: "Queued; awaiting scheduling",
            compactScope: "Scope",
            balancedScope: "Historical prefix; retains the latest balanced conversation tail",
            found: "Original retrieved",
            unbound: "ID not yet bound",
            offset_out_of_range: "Offset outside content",
            attachment_store_unavailable: "Attachment store unavailable",
            capability_unsupported: "This model cannot read images",
            path_unavailable: "File verified; local path unavailable",
            source: "Source",
            content: "Original",
            page: "Read range",
            more: "More content available",
            nextOffset: "Next offset",
            hasMore: "More matches available",
            none: "None",
            noMatches: "No matching content",
            noRecords: "No matching records",
            query: "Search",
            filters: "Filters",
            tool: "Tool",
            role: "Role",
            attachment: "Attachment",
            file: "File",
            image: "Image",
            user: "User",
            assistant: "Assistant",
            bytes: "bytes",
            openFile: "Open file",
            imageLoading: "Loading image",
            imageFailed: "Image preview unavailable",
            retained: "Originals remain in the session log; retrieval does not undo release.",
            inspect: "Inspect call",
            fallback: "Unrecognized record format. Recorded text follows.",
            waiting: "Scheduling deferred",
            execute: "Ready",
            disabled: "Disabled",
            decision: "Scheduling",
            invalid_capacity: "Invalid model context window",
            missing_capacity: "Model context window is missing",
            metadata_unavailable: "Model metadata unavailable",
            no_route: "No conversation route",
            state_changed: "Session changed during planning",
            active_compaction: "A summary is already running",
            no_business_evidence: "No new business evidence in the prefix",
            ineffective_compaction: "Last summary did not reduce observed pressure",
            paybackRequests: "Payback requests / policy limit",
            upfrontCost: "Summary and rebuild cost",
            protectedInput: "Fixed and protected input",
            cacheBasis: "Cache estimate source",
            assumed_cached: "Unknown; conservatively assumed cached",
            primary_usage: "Latest primary request usage",
            noFinitePayback: "No finite estimated payback",
            costUnits: "normalized tokens (estimated)",
            nextAction: "Next action",
            checkModelAction: "Check the conversation route and model contextWindow.",
            checkFailureAction:
                "Inspect the summary error and fix its cause; queued intent is preserved.",
            checkPolicyAction: "Inspect auto, enabled and proactive settings.",
            verifyUsageAction:
                "Use the next primary request's usage to verify pressure after the summary.",
            boundaryAction: "Wait for the next eligible step boundary.",
            waitSummaryAction: "Wait for the running summary transaction.",
            continueAction: "Continue the task; queued intent is reconsidered at later boundaries.",
            fixed_overhead:
                "The fixed prompt and tool definitions reach the pressure threshold; history summaries alone cannot reach the target.",
            protected_input:
                "Fixed input and the active task tail reach the pressure threshold; reduce fixed input or split the task.",
            not_paid_back: "Estimated payback gate not met",
            min_interval: "Minimum interval not reached",
            insufficient_savings: "Insufficient estimated savings",
            min_savings: "Insufficient estimated savings",
            min_ratio: "Estimated savings ratio too low",
            no_selection: "No balanced prefix meets retention and task protection",
            no_marks: "No pending marks",
            eligible: "Scheduling gates met",
            safety_pressure: "Context pressure",
            safety_overflow: "Context overflow",
            failed_cooldown: "Waiting after a failed summary",
            awaiting_step_boundary: "Awaiting next step boundary",
            protocol_protection: "Protected by protocol",
            awaiting_covering_summary: "Awaiting a covering summary",
            summary_in_progress: "Summary in progress",
            outside_selection: "Outside the last selection",
            summary_failed: "Summary failed",
            lastSummary: "Latest summary",
            omitted: "Not shown",
            estimate: "Estimated net saving",
            tokens: "tokens (estimated)",
            recovered: "Recovered content",
            releaseStatus: "Release status",
            name: "Name",
            size: "Size",
            copyId: "Copy ID",
            copied: "Copied",
            noPreview: "No recorded preview",
        };
        const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
        const text = (v) => (typeof v === "string" ? v : "");
        const list = (v) => (Array.isArray(v) ? v : []);
        const inputId = (v) => Number.isSafeInteger(v) && v > 0;
        const storedId = (v) => typeof v === "string" && /^[1-9]\d*$/.test(v) && inputId(Number(v));
        const ids = (v) => Array.isArray(v) && v.every(storedId);
        const short = (v, n = 120) => Array.from(text(v).replace(/\s+/g, " ")).slice(0, n).join("");
        const displayId = (value) => (storedId(value) || inputId(value) ? String(value) : "");
        const idsSummary = (ids) =>
            list(ids).filter(inputId).slice(0, 3).map(displayId).join("、") +
            (list(ids).length > 3 ? ` … +${ids.length - 3}` : "");
        function json(raw) {
            if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024) return null;
            try {
                const value = JSON.parse(raw);
                return object(value) ? value : null;
            } catch {
                return null;
            }
        }
        function validResult(title, value) {
            if (!object(value)) return false;
            return title === "release"
                ? typeof value.accepted === "boolean" &&
                      ["queued", "settled", "unknown", "unsupported"].every((key) =>
                          ids(value[key]),
                      )
                : title === "compact"
                  ? ["queued", "already_queued"].includes(value.status)
                  : title === "search"
                    ? Array.isArray(value.hits) &&
                      value.hits.every(
                          (hit) =>
                              object(hit) && storedId(hit.id) && typeof hit.snippet === "string",
                      )
                    : title === "status"
                      ? Array.isArray(value.entries) &&
                        value.entries.every((entry) => object(entry) && storedId(entry.id))
                      : storedId(value.id) &&
                        [
                            "found",
                            "unknown",
                            "unbound",
                            "unsupported",
                            "offset_out_of_range",
                            "attachment_store_unavailable",
                            "capability_unsupported",
                            "path_unavailable",
                        ].includes(value.status);
        }
        function toolModel(props) {
            const [title, icon] = TOOLS[props.toolName] ?? ["status", "list"];
            const base = {
                title,
                icon,
                state: props.phase,
                args: {},
                value: null,
                raw: "",
                images: [],
            };
            // A preparing block never owns complete dispatched arguments.
            if (props.phase === "preparing") return { ...base, summary: "", label: "preparing" };
            const block = props.block;
            const args = json(props.phase === "result" ? block.call?.argsRaw : block.argsRaw) ?? {};
            const summary =
                title === "release" || title === "status"
                    ? idsSummary(args.ids)
                    : title === "expand"
                      ? inputId(args.id)
                          ? displayId(args.id)
                          : ""
                      : title === "search"
                        ? short(args.query, 80)
                        : short(args.reason, 80);
            if (props.phase !== "result") return { ...base, args, summary, label: "running" };
            const raw = list(block.content)
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n");
            const value = validResult(title, block.meta) ? block.meta : json(raw);
            const images = list(block.content).filter(
                (b) => b.type === "image" && object(b.attachment),
            );
            const interrupted = ["TOOL_NOT_STARTED", "TOOL_OUTCOME_UNKNOWN"].includes(
                block.error?.code,
            );
            if (block.isError || interrupted)
                return {
                    ...base,
                    args,
                    summary,
                    raw,
                    images,
                    state: "error",
                    label: interrupted ? "stopped" : "failed",
                    error:
                        text(block.error?.reason) ||
                        text(block.error?.code) ||
                        text(block.error?.name) ||
                        raw,
                };
            const valid = validResult(title, value);
            if (!valid)
                return {
                    ...base,
                    args,
                    summary,
                    raw,
                    images,
                    state: "fallback",
                    label: "fallback",
                };
            return {
                ...base,
                args,
                summary,
                raw,
                value,
                images,
                state: "result",
                label:
                    title === "release"
                        ? value.accepted
                            ? value.queued.length
                                ? "queued"
                                : "settled"
                            : "rejected"
                        : title === "compact"
                          ? value.status === "queued"
                              ? "compactQueued"
                              : "already_queued"
                          : title === "expand"
                            ? value.status
                            : "",
            };
        }

        // Exact monochrome DSH product artwork, copied from ui-primitives (MIT),
        // DSH 0.2.0-rc.2 icons/index; no private Client runtime import.
        const artwork = {
            archive: [
                "M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z",
                "M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5",
                "M6.5 9.5H9.5",
            ],
            refresh: [
                "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1",
                "M14.4999 1.5V5.1H10.8999",
            ],
            search: [
                "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z",
                "M10.2991 10.3933L14.7783 14.8725",
            ],
            list: ["M6 3.5h7.5M6 8h7.5M6 12.5h7.5", "M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01"],
            chevron: ["M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"],
            archiveCheck: [
                "M2.95 5.7v4.8a2.9 2.9 0 0 0 2.9 2.9h4.3a2.9 2.9 0 0 0 2.9-2.9V5.7",
                "m6 9.35 1.4 1.4 2.6-2.6",
            ],
        };
        function Icon({ name }) {
            return h(
                "svg",
                {
                    width: 14,
                    height: 14,
                    viewBox: "0 0 16 16",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 1,
                    "aria-hidden": true,
                    className: "fc-icon",
                    ...(name === "list" || name === "archiveCheck"
                        ? { strokeLinecap: "round" }
                        : {}),
                    ...(name === "archiveCheck" ? { strokeLinejoin: "round" } : {}),
                },
                name === "archiveCheck"
                    ? h("rect", { x: 1.9, y: 2.1, width: 12.2, height: 3.4, rx: 1.1 })
                    : null,
                ...artwork[name].map((d, key) => h("path", { d, key })),
            );
        }
        const css = `
.fc-card{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;min-width:0;color:var(--dsw-alias-label-tertiary)}
.fc-row{display:flex;align-items:center;width:100%;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;padding:0;border:0;background:none;color:inherit;text-align:left;font:inherit;line-height:calc(24px + var(--dsh-content-font-delta,0px));cursor:pointer;transition:color .1s}
.fc-row:disabled{cursor:default}.fc-row:is(:hover,:focus-visible):not(:disabled){color:var(--dsw-alias-label-secondary)}
.fc-row:focus-visible,.fc-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:4px}
.fc-leading{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));margin-right:6px}
.fc-icon{display:block;flex:none;width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.fc-icon-idle{display:inline-flex;transition:opacity .1s}.fc-chevron{display:inline-flex}.fc-chevron[data-open=true]{transform:rotate(180deg)}.fc-chevron-hover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .1s}
.fc-row:is(:hover,:focus-visible):not(:disabled) .fc-icon-idle{opacity:0}.fc-row:is(:hover,:focus-visible):not(:disabled) .fc-chevron-hover{opacity:1}
.fc-title{flex:none;font-weight:400}.fc-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.fc-dash{opacity:.6;margin:0 8px}.fc-tail{flex:none;white-space:nowrap}.fc-summary+.fc-tail{margin-left:8px}
.fc-body{margin:9px 0 10px 24px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}
.fc-body dl{display:grid;grid-template-columns:minmax(70px,max-content) minmax(0,1fr);gap:7px 16px;margin:0 0 12px}.fc-body dt{color:var(--dsw-alias-label-secondary)}.fc-body dd{margin:0;min-width:0}
.fc-section{margin:12px 0 6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.fc-items{display:grid;gap:0}.fc-item{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}.fc-item:first-child{border-top:0}.fc-item-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.fc-id{font-family:ui-monospace,monospace;white-space:nowrap}.fc-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.fc-preview{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.fc-original{white-space:pre-wrap;overflow:auto;max-height:440px;margin:6px 0;font:12px/1.65 ui-monospace,monospace;tab-size:4}.fc-note{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.fc-error{color:var(--dsw-alias-state-error-primary)}.fc-warn{color:var(--dsw-alias-state-warn-primary)}.fc-action{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;color:inherit;background:var(--dsw-alias-bg-layer-2);padding:3px 8px;cursor:pointer;font:inherit;font-size:12px}.fc-actions{display:flex;gap:8px;margin-top:12px}.fc-image{display:block;max-width:100%;max-height:360px;object-fit:contain;margin-top:8px;border-radius:5px}.fc-live .fc-title{animation:fc-pulse 1.6s ease-in-out infinite}@keyframes fc-pulse{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){.fc-live .fc-title{animation:none}.fc-row,.fc-icon-idle,.fc-chevron-hover{transition:none}}
`;
        function reportOf(event) {
            if (event.type !== "compaction/prune") return null;
            const r = event.data?.[REPORT];
            if (
                !object(r) ||
                r.version !== 8 ||
                typeof r.batchId !== "string" ||
                !Array.isArray(r.released) ||
                !Array.isArray(r.pending)
            )
                return null;
            if (
                !Number.isSafeInteger(r.completionSeq) ||
                r.completionSeq !== event.seq + 1 ||
                !Number.isSafeInteger(r.targetSeq)
            )
                return null;
            if (
                !r.released.length ||
                [...r.released, ...r.pending].some((item) => !object(item) || !storedId(item.id))
            )
                return null;
            return r;
        }
        const releaseDefinition = {
            kind: KIND,
            target: "chat",
            match(event) {
                const report = reportOf(event);
                if (report) return { id: String(report.completionSeq), role: "start" };
                return ["tool/result", "user/message"].includes(event.type) &&
                    object(event.surfaceOp) &&
                    event.surfaceOp.op === "replace"
                    ? { id: String(event.seq), role: "update" }
                    : null;
            },
            start(_context, match) {
                return { report: reportOf(match.event), complete: false, location: match.location };
            },
            update(context, match) {
                const report = context.state?.report;
                const event = match.event;
                if (
                    !report ||
                    event.seq !== report.completionSeq ||
                    !list(event.sourceEventSeqs).includes(report.targetSeq)
                )
                    return context.state;
                return { ...context.state, report, complete: true, seq: event.seq };
            },
            buildViewNode(context) {
                if (!context.state?.complete) return null;
                return {
                    key: context.key,
                    id: context.id,
                    kind: KIND,
                    target: "chat",
                    anchorSeq: context.state.seq,
                    location: context.state.location,
                    visibility: "visible",
                    data: context.state.report,
                };
            },
        };
        return {
            inject: ["slots", "locale", "uiConversation"],
            // Pure models are exported for verification; they own no runtime resources.
            toolModel,
            releaseDefinition,
            reportOf,
            artwork,
            apply(ctx) {
                ctx.effect(() => ctx.locale.register("fold-context", { zh, en }));
                const translate = ctx.locale.bind("fold-context");
                function useText() {
                    React.useSyncExternalStore(
                        (fn) => ctx.locale.subscribe(fn),
                        () => ctx.locale.getSnapshot(),
                    );
                    return translate;
                }
                function Fields({ values, t }) {
                    const rows = values.filter(
                        ([, value]) =>
                            (typeof value === "string" && value !== "") ||
                            (typeof value === "number" && Number.isFinite(value)),
                    );
                    return rows.length
                        ? h(
                              "dl",
                              null,
                              ...rows.flatMap(([key, value], i) => [
                                  h("dt", { key: `k${i}` }, t(key)),
                                  h("dd", { key: `v${i}` }, value),
                              ]),
                          )
                        : null;
                }
                function Items({ items, title, t }) {
                    if (!items.length) return null;
                    return h(
                        React.Fragment,
                        null,
                        h("div", { className: "fc-section" }, t(title), ` · ${items.length}`),
                        h(
                            "div",
                            { className: "fc-items" },
                            ...items.slice(0, 128).map((item, i) => {
                                if (typeof item === "string") item = { id: item };
                                return h(
                                    "div",
                                    { className: "fc-item", key: `${item.id}:${i}` },
                                    h(
                                        "div",
                                        { className: "fc-item-head" },
                                        h("span", { className: "fc-id" }, displayId(item.id)),
                                        h(
                                            "span",
                                            { className: "fc-muted" },
                                            text(item.tool) ||
                                                t(text(item.role) || text(item.kind) || "tool"),
                                        ),
                                        item.status
                                            ? h("span", { className: "fc-muted" }, t(item.status))
                                            : null,
                                    ),
                                    item.snippet || item.preview
                                        ? h(
                                              "p",
                                              { className: "fc-preview" },
                                              short(item.snippet || item.preview, 500),
                                          )
                                        : null,
                                    typeof item.pendingReason === "string" && item.pendingReason
                                        ? h("div", { className: "fc-muted" }, t(item.pendingReason))
                                        : null,
                                    item.reason
                                        ? h(
                                              "div",
                                              { className: "fc-muted" },
                                              `${t("reason")} · ${short(item.reason, 1000)}`,
                                          )
                                        : null,
                                    list(item.attachments).filter(object).length
                                        ? h(
                                              "div",
                                              { className: "fc-muted" },
                                              `${t("attachment")} · `,
                                              item.attachments
                                                  .filter(object)
                                                  .map(
                                                      (a) =>
                                                          displayId(a.id) +
                                                          (a.name ? ` ${short(a.name)}` : ""),
                                                  )
                                                  .join("、"),
                                          )
                                        : null,
                                );
                            }),
                        ),
                        items.length > 128
                            ? h(
                                  "p",
                                  { className: "fc-note" },
                                  `${t("omitted")} · ${items.length - 128}`,
                              )
                            : null,
                    );
                }
                function ImagePreview({ attachment, loadImage, t }) {
                    const [state, setState] = React.useState({ url: null, failed: false });
                    React.useEffect(() => {
                        let active = true;
                        setState({ url: null, failed: false });
                        if (loadImage)
                            Promise.resolve()
                                .then(() => loadImage(attachment))
                                .then(
                                    (url) => {
                                        if (active) setState({ url, failed: false });
                                    },
                                    () => {
                                        if (active) setState({ url: null, failed: true });
                                    },
                                );
                        else setState({ url: null, failed: true });
                        // The session owns shared image URLs, including their revocation.
                        return () => {
                            active = false;
                        };
                    }, [attachment, loadImage]);
                    return state.url
                        ? h("img", {
                              className: "fc-image",
                              src: state.url,
                              alt: text(attachment.name) || t("image"),
                              onError: () => setState({ url: null, failed: true }),
                          })
                        : h(
                              "p",
                              { className: "fc-note" },
                              t(state.failed ? "imageFailed" : "imageLoading"),
                          );
                }
                function Details({ model, props, t }) {
                    const v = model.value;
                    if (model.state === "error")
                        return h(
                            "p",
                            { className: "fc-error fc-preview" },
                            model.error || t(model.label),
                        );
                    if (!v)
                        return h(
                            React.Fragment,
                            null,
                            model.state === "fallback"
                                ? h("p", { className: "fc-note" }, t("fallback"))
                                : null,
                            h(Fields, {
                                t,
                                values: [
                                    ["targets", model.summary],
                                    ["reason", model.args.reason],
                                ],
                            }),
                            model.raw ? h("pre", { className: "fc-original" }, model.raw) : null,
                        );
                    if (model.title === "release")
                        return h(
                            React.Fragment,
                            null,
                            h(Fields, {
                                t,
                                values: [
                                    ["result", t(model.label)],
                                    ["reason", model.args.reason],
                                ],
                            }),
                            ...[
                                ["queued", "pending"],
                                ["settled", "settled"],
                                ["unknown", "unknown"],
                                ["unsupported", "unsupported"],
                            ].map(([key, title]) => h(Items, { key, t, title, items: v[key] })),
                            h("p", { className: "fc-note" }, t("retained")),
                        );
                    if (model.title === "compact")
                        return h(Fields, {
                            t,
                            values: [
                                ["result", t(model.label)],
                                ["reason", model.args.reason],
                                ["compactScope", t("balancedScope")],
                            ],
                        });
                    if (model.title === "expand")
                        return h(
                            React.Fragment,
                            null,
                            h(Fields, {
                                t,
                                values: [
                                    ["targets", displayId(v.id)],
                                    ["result", t(v.status)],
                                    ["source", v.tool || (v.role ? t(v.role) : null)],
                                    ["releaseStatus", v.releaseStatus ? t(v.releaseStatus) : null],
                                    [
                                        "page",
                                        Number.isInteger(v.offset)
                                            ? `${v.offset} – ${v.offset + Array.from(text(v.text)).length}${Number.isInteger(v.totalCharacters) ? ` / ${v.totalCharacters}` : ""}`
                                            : null,
                                    ],
                                    ["name", v.attachment?.name],
                                    [
                                        "size",
                                        Number.isFinite(v.verifiedBytes)
                                            ? `${v.verifiedBytes} ${t("bytes")}`
                                            : null,
                                    ],
                                ],
                            }),
                            typeof v.text === "string" && v.text
                                ? h("pre", { className: "fc-original" }, v.text)
                                : null,
                            ...model.images.map((image, i) =>
                                h(ImagePreview, {
                                    key: i,
                                    attachment: image.attachment,
                                    loadImage: props.loadImage,
                                    t,
                                }),
                            ),
                            v.representation === "file-handle" &&
                                typeof v.path === "string" &&
                                props.openFile
                                ? h(
                                      "button",
                                      {
                                          className: "fc-action",
                                          onClick: () => props.openFile(v.path),
                                      },
                                      t("openFile"),
                                  )
                                : null,
                            v.nextOffset !== undefined && v.nextOffset !== null
                                ? h(
                                      "p",
                                      { className: "fc-note" },
                                      `${t("more")} · ${t("nextOffset")} ${v.nextOffset}`,
                                  )
                                : null,
                            v.reason ? h("p", { className: "fc-note" }, v.reason) : null,
                            h("p", { className: "fc-note" }, t("retained")),
                        );
                    if (model.title === "search")
                        return h(
                            React.Fragment,
                            null,
                            h(Fields, {
                                t,
                                values: [
                                    ["query", v.query || model.args.query],
                                    ["tool", model.args.tool],
                                    [
                                        "role",
                                        list(model.args.roles)
                                            .map((r) => t(r))
                                            .join("、"),
                                    ],
                                ],
                            }),
                            v.hits.length
                                ? h(Items, { t, title: "result", items: v.hits })
                                : h("p", null, t("noMatches")),
                            v.hasMore ? h("p", { className: "fc-note" }, t("hasMore")) : null,
                        );
                    const scheduling = object(v.scheduling) ? v.scheduling : {};
                    const plan = object(scheduling.plan) ? scheduling.plan : {};
                    const diagnostic = object(scheduling.diagnostic) ? scheduling.diagnostic : {};
                    const economics = object(diagnostic.economics) ? diagnostic.economics : null;
                    const limits = object(scheduling.limits) ? scheduling.limits : null;
                    const actionKey = [
                        "no_route",
                        "missing_capacity",
                        "invalid_capacity",
                        "metadata_unavailable",
                    ].includes(scheduling.reason)
                        ? "checkModelAction"
                        : scheduling.reason === "failed_cooldown"
                          ? "checkFailureAction"
                          : scheduling.reason === "disabled"
                            ? "checkPolicyAction"
                            : text(scheduling.reason).startsWith("safety_")
                              ? "verifyUsageAction"
                              : scheduling.reason === "eligible"
                                ? "boundaryAction"
                                : scheduling.reason === "active_compaction"
                                  ? "waitSummaryAction"
                                  : "continueAction";
                    return h(
                        React.Fragment,
                        null,
                        h(Fields, {
                            t,
                            values: [
                                [
                                    "decision",
                                    scheduling.decision
                                        ? t(
                                              scheduling.decision === "wait"
                                                  ? "waiting"
                                                  : scheduling.decision,
                                          )
                                        : null,
                                ],
                                ["reason", scheduling.reason ? t(scheduling.reason) : null],
                                [
                                    "paybackRequests",
                                    economics
                                        ? Number.isFinite(economics.breakEvenRequests)
                                            ? `${economics.breakEvenRequests} / ${economics.expectedFutureRequests}`
                                            : t("noFinitePayback")
                                        : null,
                                ],
                                [
                                    "upfrontCost",
                                    economics && Number.isFinite(economics.upfrontCost)
                                        ? `${economics.upfrontCost} ${t("costUnits")}`
                                        : null,
                                ],
                                ["cacheBasis", economics ? t(economics.cacheBasis) : null],
                                [
                                    "protectedInput",
                                    limits && Number.isFinite(limits.minimumPromptTokens)
                                        ? `${limits.minimumPromptTokens} ${t("tokens")}`
                                        : null,
                                ],
                                ["nextAction", diagnostic.nextAction ? t(actionKey) : null],
                                [
                                    "estimate",
                                    Number.isFinite(plan.netSavingTokens)
                                        ? `${plan.netSavingTokens} ${t("tokens")}`
                                        : null,
                                ],
                                [
                                    "lastSummary",
                                    v.lastSummary
                                        ? `${list(v.lastSummary.ids).length} ${t("items")}`
                                        : null,
                                ],
                            ],
                        }),
                        ...list(diagnostic.constraints).map((constraint, index) =>
                            h(
                                "p",
                                { className: "fc-note", key: `constraint-${index}` },
                                t(constraint.code),
                            ),
                        ),
                        v.entries.length
                            ? h(Items, { t, title: "result", items: v.entries })
                            : h("p", null, t("noRecords")),
                        list(v.attachments).length
                            ? h(Items, {
                                  t,
                                  title: "attachment",
                                  items: v.attachments.map((a) => ({
                                      ...a,
                                      preview: a.attachment?.name,
                                      status: a.releaseStatus || a.status,
                                  })),
                              })
                            : null,
                        v.omitted
                            ? h("p", { className: "fc-note" }, `${t("omitted")} · ${v.omitted}`)
                            : null,
                    );
                }
                function Row({
                    title,
                    summary,
                    label,
                    icon,
                    expanded,
                    toggle,
                    disabled,
                    state,
                    children,
                    id,
                    t,
                }) {
                    return h(
                        "div",
                        {
                            className: `fc-card${state === "start" ? " fc-live" : ""}`,
                            "data-fold-context": title,
                        },
                        h("style", null, css),
                        h(
                            "button",
                            {
                                type: "button",
                                className: "fc-row",
                                onClick: toggle,
                                disabled,
                                "aria-expanded": disabled ? undefined : expanded,
                                "aria-controls": disabled ? undefined : id,
                            },
                            h(
                                "span",
                                { className: "fc-leading", "aria-hidden": true },
                                expanded && !disabled
                                    ? h(
                                          "span",
                                          { className: "fc-chevron", "data-open": true },
                                          h(Icon, { name: "chevron" }),
                                      )
                                    : h(
                                          React.Fragment,
                                          null,
                                          h(
                                              "span",
                                              { className: "fc-icon-idle" },
                                              h(Icon, { name: icon }),
                                          ),
                                          disabled
                                              ? null
                                              : h(
                                                    "span",
                                                    { className: "fc-chevron-hover" },
                                                    h(Icon, { name: "chevron" }),
                                                ),
                                      ),
                            ),
                            h("span", { className: "fc-title" }, t(title)),
                            summary || label ? h("span", { className: "fc-dash" }, "-") : null,
                            summary
                                ? h("span", { className: "fc-summary", title: summary }, summary)
                                : null,
                            label
                                ? h(
                                      "span",
                                      {
                                          className: `fc-tail${state === "error" || label === "rejected" ? " fc-error" : ""}`,
                                          role: "status",
                                      },
                                      summary ? "· " : null,
                                      t(label),
                                  )
                                : null,
                        ),
                        expanded && !disabled
                            ? h("div", { className: "fc-body", id }, children)
                            : null,
                    );
                }
                function ToolView(props) {
                    const t = useText();
                    const disclosure = props.useDisclosure();
                    const model = toolModel(props);
                    const id = React.useId();
                    let summary = model.summary;
                    if (model.value && model.title === "search")
                        summary += ` · ${model.value.hits.length} ${t("matches")}`;
                    if (model.value && model.title === "status" && !summary)
                        summary = `${model.value.entries.length} ${t("records")}`;
                    return h(
                        Row,
                        {
                            ...model,
                            summary,
                            t,
                            id,
                            expanded: disclosure.expanded,
                            toggle: disclosure.toggle,
                            disabled: props.phase === "preparing",
                        },
                        h(Details, { model, props, t }),
                        props.inspect
                            ? h(
                                  "div",
                                  { className: "fc-actions" },
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          className: "fc-action",
                                          onClick: props.inspect,
                                      },
                                      t("inspect"),
                                  ),
                              )
                            : null,
                    );
                }
                function ReleaseView(props) {
                    const t = useText();
                    const disclosure = props.useDisclosure();
                    const id = React.useId();
                    const r = props.node.data;
                    const estimate = r.tokenEstimate;
                    const validEstimate =
                        Number.isSafeInteger(estimate?.beforeTokens) &&
                        estimate.beforeTokens >= 0 &&
                        Number.isSafeInteger(estimate?.afterTokens) &&
                        estimate.afterTokens >= 0;
                    const saved = validEstimate
                        ? estimate.beforeTokens - estimate.afterTokens
                        : null;
                    const savings =
                        saved === null
                            ? ""
                            : t(saved >= 0 ? "tokenReduction" : "tokenIncrease").replace(
                                  "{count}",
                                  String(Math.abs(saved)),
                              );
                    return h(
                        Row,
                        {
                            title: "completed",
                            icon: "archiveCheck",
                            t,
                            id,
                            expanded: disclosure.expanded,
                            toggle: disclosure.toggle,
                            summary: [
                                savings,
                                `${r.released.length} ${t("items")}`,
                                r.pending.length ? `${r.pending.length} ${t("pending")}` : "",
                            ]
                                .filter(Boolean)
                                .join(" · "),
                        },
                        h(Items, { t, title: "released", items: r.released }),
                        h(Items, { t, title: "pending", items: r.pending }),
                        h("p", { className: "fc-note" }, t("retained")),
                    );
                }
                ctx.uiConversation.events.register(releaseDefinition);
                for (const key of Object.keys(TOOLS)) {
                    ctx.slots.inject("tool.call.toolview", () =>
                        ctx.slots.register({ name: "tool.call.toolview", key }, ToolView),
                    );
                }
                ctx.slots.inject("conversation.chat.node", () =>
                    ctx.slots.register({ name: "conversation.chat.node", key: KIND }, ReleaseView),
                );
            },
        };
    },
});
