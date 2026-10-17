# dsh-fold-context

让 DSH 的长任务上下文压缩更可预测：已用完的工具结果和单个附件可独立释放，保留可恢复的编号占位；较旧历史由官方摘要流程整理。插件按积累、停留时间和压力提醒模型检查候选，并明确区分排队、实际释放和摘要覆盖。

适合需要持续阅读文件、调用工具、反复调查和跨多轮推进的任务。压缩以 DSH 官方摘要事务为基础，记忆提炼采用独立适配接口。

> 当前版本为 `0.2.1`，支持 DSH `0.2.0-rc.2`。独立释放、编号别名、提醒、摘要、恢复、原生回放选区与压力效果跟踪通过隔离测试验证；真实模型摘要质量、供应商缓存与节费效果仍需实际评估。记忆适配接口已经提供，自动提炼与 Mnemon 集成尚未实现。

## 能做什么

- **明确的内容身份**：用户文字、助手文字、工具调用与结果、图片、文件分别有稳定编号。模型不用在正文中手工打印编号。
- **独立的原位释放**：工具结果正文和单个附件在安全步骤边界替换为轻量 `R` 占位，不调用摘要模型；用户文字、助手回复和工具调用保留。
- **有冷却的动态提醒**：候选积累、停留较久或接近真实压力阈值时提示检查，忽略后逐步退避；不会自动代替模型选择释放内容。
- **独立的摘要调度**：较旧连续历史仍按官方摘要事务整理，低压力下遵守间隔、预计缩短量和回本门槛。
- **可恢复的原始证据**：按编号展开原文，或先搜索历史再恢复。图片会校验后重新传入，文件会校验后提供读取句柄。
- **轻量的状态通知**：日常只追加有界变化，完整目录通过工具按需查询。
- **专用 Web 工具卡片**：五个工具显示各自的标题、编号、状态和结构化详情，使用 DSH 单色图标和主题颜色，支持中英切换。
- **可回放的释放过程**：独立释放提交后，在聊天中展示“已释放上下文”，列出本批编号、原文预览、释放原因与仍在等待的项目。

## 安装与启用

### 1. 构建插件

需要 Node.js **24.11.0 或更高版本**、pnpm **11.15.0**，以及 DSH **0.2.0-rc.2**。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

如需分发安装包，可在构建后执行 `pnpm pack`；打包时也会自动构建。源码仓库保留锁文件，依赖目录和构建产物不进入 Git，安装包包含运行所需的 `lib/`、bundle manifest 指向的 `cordis.patch.yml` 以及文档和示例。

### 2. 安装到目标 DSH profile

通过 DSH 的插件管理功能安装构建后的本地目录，或让 DSH 助手调用 `plugin_manager`，以插件目录的绝对路径作为 `install_bundle` 的 `target`。

安装 bundle 后，随包发布的 `cordis.patch.yml` 按 Loader row id 覆盖 `preset-standard`、`preset-ptc` 和 `preset-cordis` 的完整配置。它基于 DSH `0.2.0-rc.2` 公开 shipped preset 模板，保留所有其他默认字段和 `!!js` 表达式，仅调整各 preset 的 compaction 组：用 `dsh-fold-context` 替换 `compaction-basic`，保留 `command-compact` 和 `tool-result-pruner`，组保持启用，`compaction` 与 `toolResultPruner` 的 isolation realm 不变。pruner 保留官方参数 `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`；其运行包由 DSH 提供。

profile 内优先级更高的自定义 preset 快照仍会覆盖 bundle；需要自行在对应快照的 compaction 组采用相同替换。公共 bundle 不包含用户专属 profile 配置。既有会话保留启动时的 preset revision，请在新会话中验证。

bundle 同时在 profile 根层插入 `fold-context-ui`，配置 `uiOnly: true`，用于加载 Client 展示；该挂载不创建压缩引擎。Client 随 `lib/client.js` 发布，无额外图标库或独立 Web 服务。安装返回 `restart-required` 时，需先重启 DSH，再刷新页面；live profile 自动应用后可直接刷新。工具调用历史可直接使用新展示；释放过程卡需要新版本记录的批次元数据，旧日志不会补造过程记录。

### 3. 自定义 preset 的压缩组

自定义 preset 可采用下面的组片段，保留其余 preset 配置。单独在根层挂载插件，不能覆盖 preset 内已经隔离的压缩服务。

```yaml
- id: compaction
  name: cordis:group
  group: true
  disabled: false
  isolate:
      compaction: true
      toolResultPruner: true
  config:
      - id: fold-context
        name: dsh-fold-context
        config:
            compaction:
                auto: true
            scheduling:
                enabled: true
                proactive: true
      - id: command-compact
        name: "@deepseek-ai/dsh-command-compact"
      - id: tool-result-pruner
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
        config:
            thresholdChars: 8192
            headChars: 4096
            tailChars: 1024
```

这是插件列表中的组片段，不是完整 preset。每个 compaction scope 只挂载一个 provider，不要同时启用 `compaction-basic`。`tool-result-pruner` 可以共存；bundle 默认保留它，自定义 preset 可按需省略其 row。完整选项见[配置示例](./examples/compaction-group.fragment.yml)。

pruner 在符合压缩触发条件时可以先按字符预算截短工具结果，再决定是否生成摘要。`context_release` 则记录语义意图，在下一安全步骤边界独立替换已选正文；两者都不必调用模型，原始结果保存在会话日志中。仅出现普通 pruner 截短不构成语义释放回执。

原文恢复需要 `sessionQuery` 服务；图片和文件恢复还需要可见的附件存储，文件句柄需要文件系统路径映射。持久恢复依赖 DSH 会话日志正常保留，以及官方 `session-checkpoint-policy` 成功落盘。

释放过程元数据记录在本批最后一个 `compaction/prune` 的 `data.foldContextRelease` 中。Client 只有观察到紧随其后、引用相同目标的替换事件，才展示完成卡片；排队、普通 pruner 截短以及未完成的 prune 都不会显示为已释放。元数据不进入消息正文，不修改工具结果的其他字段，也不增加模型输入。摘要覆盖仍由 DSH 的摘要过程卡展示。

## 日常使用

启用后，模型会收到使用规则和编号声明。通常无需人工管理编号；你可以要求模型在阶段结束后标记已用完的证据，查看待处理内容，或恢复之前的结果。

| 工具              | 用途                                                           |
| ----------------- | -------------------------------------------------------------- |
| `context_release` | 批量释放已用完的工具结果正文或单个附件；返回排队或已结算状态。 |
| `context_compact` | 请求在后续步骤边界生成摘要；低压力下可能等待调度条件。         |
| `context_status`  | 查看编号、状态、等待原因、提醒状态及独立摘要调度计划。         |
| `context_search`  | 按原文片段、角色或工具名查找当前会话历史。                     |
| `context_expand`  | 根据编号分页恢复原文，或恢复已校验的图片、文件句柄。           |

例如，模型可以调用：

```json
{ "ids": ["§T19§", "§I20§"], "reason": "调查已完成，结论已经保留" }
```

这是 `context_release` 的参数。编号必须来自当前会话，不能照搬示例编号。要找回证据，可以先用 `context_search` 搜索关键片段，再调用：

```json
{ "id": "§T19§" }
```

这是 `context_expand` 的参数。恢复结果进入新的上下文，不撤销之前的压缩。文本结果较长时，根据返回的 `nextOffset` 继续读取。

如果你希望立即整理历史，可以使用官方 `/compact`。模型调用 `context_compact` 则会进入代码调度，不保证下一步就执行。

### 编号与状态

| 编号    | 对应内容                 |
| ------- | ------------------------ |
| `§U17§` | 一条用户消息的普通文字   |
| `§A18§` | 一条助手消息的普通文字   |
| `§T19§` | 一次工具调用及其完整结果 |
| `§I20§` | 一次图片出现             |
| `§F21§` | 一次文件出现             |

所有类型共享递增序号。同一图片或文件重复出现，也有各自的编号。U/A 是可检索的对话身份，新释放请求不接受它们；T 释放仅替换结果正文，保留工具调用及助手原记录；I/F 仅替换对应附件。

条目的状态按以下含义解释：

- `available`：尚未标记，且未被摘要覆盖。
- `queued`：意图已接收；普通工具结果和附件等待安全步骤边界，受保护的助手附件等待覆盖摘要。
- `released`：正文已实际释放；原位释放的当前占位显示为 `§T19R§`、`§I20R§` 等。原编号和 `R` 别名均可用于工具查询及恢复。
- `summarized`：当前正文或释放占位已被摘要覆盖，选区内不再保留逐条占位。

`R` 只是可见状态，不生成新身份，也不会恢复原正文。旧版已经记录的 summary-only 标记保持原来的重放解释；旧版摘要排除不会凭空生成 `R` 占位。查看 `context_status` 可区分步骤边界等待、协议保护、摘要范围外和摘要失败冷却。

## 什么时候提醒释放

候选须在当前上下文中仍可处理，并至少经历两个后续业务步骤。纯 `context_*` 管理调用不推动年龄或冷却。默认在以下情况提醒：积累至少 16000 个候选 token；至少 4000 个候选 token 持续停留 8 个业务步骤；或总输入达到官方有效压力阈值的 80%，且候选至少 4000 token。单个至少 8000 token 的大结果优先排列，但不单独触发。

每次最多列 5 个候选，普通间隔 6 步、压力间隔 4 步；没有释放进展时退避到 12、24 步。新增至少 8000 候选 token 或新的有效释放意图可重置忽略退避，仍遵守最小间隔。提醒只附在原有编号通知中，状态随会话日志保存；排队和已释放内容离开候选池，无候选或摘要进行中不提醒。

## 什么时候生成摘要

有四条独立的摘要触发路径：

1. **常规压力**：达到官方有效压力阈值时执行。
2. **实际溢出**：模型供应商报告上下文超限时走官方恢复。
3. **提前整理**：有排队标记或模型主动请求，并且满足代码的经济门槛时执行。
4. **用户 `/compact`**：绕过经济门槛，执行一次安全的手动摘要。

普通压力和提前整理都保留近期原文尾部，摘要覆盖较旧的**连续前缀**。开头的 system 消息保留，切点不会拆开工具调用与结果。对同一 provider/model 的原生 assistant 回放，选区成本参考该回复的 output usage，而不只看可见正文；最新主请求的输入 usage 校准总压力。不会按加密签名长度估算，也不会把历次完整 input usage 相加。该成本只用于规划，官方剪枝记账与原始签名保持原样。溢出和 `/compact` 使用更激进的保留策略，但仍保留最新的安全尾部。

摘要后先记录预计降幅，再等待下一次主请求的输入 usage 验证；辅助摘要模型的 usage 不参与验证。`context_status` 的 `scheduling.pressure` 给出预计压力、阈值、effect 与 verification，区分等待验证、低于阈值和仍高于阈值。实际未改善会逐步缩小保留预算；若主请求确认仍超阈值，下一轮直接采用最大合法历史前缀，同时保留当前新用户任务、最新业务尾部和完整工具配对。同次处理遵守官方重试次数上限，没有预计改善或选区只剩旧 checkpoint/管理快照时停止继续摘要。保护尾部或固定请求开销可能仍超预算，此时不能仅凭生成 checkpoint 宣称压缩成功。

独立释放不受摘要经济门槛控制，也不因关闭 `compaction.auto` 或 `scheduling.enabled` 停止。覆盖摘要仍替换完整选区；尚未原位处理、但可在该选区安全排除的标记进入摘要输入过滤，范围外标记继续等待。

## 配置

通常可以先使用默认值，只在实际观察后调整。下面列出主要选项及其默认值：

```yaml
compaction:
    auto: true
    thresholdRatio: 0.8
    retainRatio: 0.16
    headroomTokens: 65536
scheduling:
    enabled: true
    proactive: true
    minIntervalSteps: 8
    minSavingsTokens: 2048
    minSavingsRatio: 0.2
    expectedSummaryRatio: 0.2
    paybackTurns: 8
    cacheReadRatio: 0.1
    summaryInputRatio: 1
    summaryOutputRatio: 1
reminders:
    enabled: true
    minAgeSteps: 2
    largeOutputTokens: 8000
    backlogTokens: 16000
    staleTokens: 4000
    staleSteps: 8
    pressureRatio: 0.8
    minIntervalSteps: 6
    pressureIntervalSteps: 4
    ignoredBackoffSteps: [12, 24]
    rearmGrowthTokens: 8000
    maxCandidates: 5
summary:
    reasoning: omit-from-summary
    images: auto
release:
    catalogLimit: 32
```

关键选项：

| 选项                                   | 含义                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `compaction.auto`                      | 关闭普通压力和 backlog 自动摘要；独立释放仍运行，实际溢出恢复、模型显式请求和用户 `/compact` 仍可执行。 |
| `thresholdRatio`                       | 压力比例上限；输出预留与 headroom 可能让触发早于该比例。                                                |
| `retainRatio`                          | 保留近期原文尾部的预算比例，不是压缩后的目标大小。                                                      |
| `scheduling.enabled`                   | 开启经济调度；关闭后，模型显式请求沿用旧的强制摘要行为。                                                |
| `scheduling.proactive`                 | 允许排队标记自动触发低压力摘要；关闭后仍可通过模型显式请求触发。                                        |
| `minIntervalSteps`                     | 距离上次摘要至少经过多少个已提交的 assistant 步骤。                                                     |
| `minSavingsTokens` / `minSavingsRatio` | 最低预计净缩短量，以及相对当前总输入的最低比例。                                                        |
| `paybackTurns`                         | 允许的估算回本周期。                                                                                    |
| `summary.reasoning`                    | 默认只从摘要输入省略 reasoning；`preserve` 将其作为历史文字保留。                                       |
| `summary.images`                       | `auto` 仅向明确支持图片的摘要模型传原图；`references` 固定只传引用。                                    |
| `release.catalogLimit`                 | 按需目录大小，范围 1–128；日常通知最多附带 8 条变化。                                                   |

压力阈值为 `floor(min(C × thresholdRatio, C − R − headroomTokens))`，其中 C 是当前模型容量，R 是输出预留。模型专属参数可以通过官方 `compaction.modelPolicies` 配置。

成本字段是 **HEURISTIC 估算权重**，不是供应商价格。未知缓存按已缓存前缀保守估算。真正提交摘要仍会改变历史前缀，因此不能保证缓存命中或实际节费。

## 图片、文件与恢复边界

- 图片恢复会校验原始存储内容；当前对话模型明确支持图片时，才返回原生图片。
- 文件恢复会读取并校验完整内容，然后返回可读取的文件句柄；这不表示模型已经读过文件正文。
- 摘要模型不支持图片或能力未知时，保留图片引用和相邻文字，不自动生成 OCR 或视觉描述。
- 缺少服务、存储丢失或损坏、模型能力不足、路径无法映射时，会返回明确状态或错误。
- 历史搜索是字面子串搜索，不提供语义图像检索或附件二进制全文检索。

## 记忆插件适配

压缩本身不依赖记忆插件。包导出 `dsh-fold-context/memory`，提供 `ContextMemoryAdapter` 契约，用于将来源引用和摘要交给独立的提炼、存储实现。

当前尚未连接自动提炼流程，也没有内置 Mnemon 写入。安装本插件不会自动创建长期记忆。

## 开发与验证

在本仓库内执行：

```bash
pnpm typecheck
pnpm test
pnpm format:check
```

`pnpm test` 将代码构建到新的临时目录并在那里运行全套测试，不覆盖已安装包共享的 `lib`。只运行某个文件可用 `pnpm test -- attachment-loop.test.mjs`。`pnpm build` 和打包仍会更新本仓库的 `lib`，应在回归通过后执行。

测试使用 mock 模型、内存服务和新的临时会话目录，不调用真实模型，也不修改运行中的 profile。覆盖编号、摘要提交、失败与取消、原文与附件恢复、冷启动、fork、代码调度和增量通知。

普通压力压缩若只选中旧 checkpoint、编号/释放管理通知、重新注入的指令 baseline 或 MCP snapshot，不再重复调用摘要模型；真实业务内容和非 baseline 的指令变化仍可触发。手动 `/compact`、显式 checkpoint 请求与真实溢出恢复保留兜底。摘要输入省略管理通知以及 U/A/T 来源编号，I/F 归档引用和任务本身涉及的编号字符串继续保留。

工程细节见[架构说明](./docs/architecture.md)；参考设计见[Magic Context 对照](./docs/magic-context-research.md)。

## 许可证

[MIT](./LICENSE)。
