# 架构与状态协议

## 职责边界

模型判断证据是否仍有用，并通过 `context_release` 标记工具结果正文或单个附件。Host 保存意图，在安全步骤边界决定何时合批释放；释放后重新测量压力，必要时调用 DSH 官方摘要事务。Client 展示工具状态与已经提交的释放回执。

实现分为三层：

- `src/domain`：纯数字 ID、归档索引、释放账本、提醒、合批计划、摘要选区、预算和经济估算。
- `src/integration`：工具注册、每请求控制消息、会话事件、官方压缩事务、原文恢复与附件校验。
- [client.js](../src/client.js)：DSH 原生工具行、释放完成行及插件配置页；[client-release.js](../src/client-release.js) 提供原因分组、紧凑编号与按需详情；配置草稿、修订号冲突和模型目录状态由页面控制器处理。

压缩事务由官方 `compaction` 服务提交。插件保留工具调用与结果配对、当前任务和安全尾部，通过 `sessionQuery` 恢复原始事件。会话持久化依赖官方 checkpoint policy；插件内部的释放意图、完成回执和摘要 checkpoint 各自承担不同职责。

## 会话 ID 与原始内容

每会话使用同一个递增序列，为用户消息、助手消息、工具结果及每次图片、文件出现分配稳定 ID。ID 在内部为正整数的十进制字符串，在工具参数 `id` 和 `ids` 中为 JSON number，数值须处于安全整数范围。工具响应和归档索引保留数字字符串，条目类型由字段说明。

释放与摘要覆盖只改变状态，ID 不变。工具结果正文有自己的身份，附件通过 `ownerId` 关联所属消息，并保存附件顺序。同一附件出现在不同消息时，各次出现分别编号，释放范围按出现位置判断。

用户、助手和工具原始正文保持原样。助手的 reasoning、签名与 `replayState` 完整保留，分配信息不写入业务正文。业务中出现的 `prev:`、`next:` 或 `try_release:` 文字仍属于业务内容。

协议版本为 8。持久意图与释放回执通过准确的版本、类型和字段验证后参与处理。档案与回执仅支持当前协议，读取异常须以显式状态或错误呈现。

## 每次模型请求的控制消息

在每次主模型请求前追加一条独立 `user` 消息：

```text
prev: 101 102
next: 103
attachments:
102 101 1
try_release: 12 18
Review try_release now; call context_release for consumed items after preserving needed facts.
```

- `prev`：上次请求分配的 ID。
- `next`：本次请求预留的 ID。
- `attachments`：有附件时才出现，每行是附件 ID、owner ID、附件在 owner 中的序号，序号从 1 开始。
- `try_release`：触发提醒时才出现，候选行只列 ID，下一行提示模型及时检查并标记已消费内容。

控制消息以 `source.kind = 'fold-context-allocation'` 识别。消费端根据 source 元数据处理，不用正则匹配正文来判断消息类型。source 同时承载持久化所需的分配和提醒状态。

控制消息参与实际主请求，其 token 计入压力。数据投影路径按来源过滤控制消息、release 清理通知与内部状态；同模型原生前缀路径保留请求历史以争取缓存，由追加的摘要指令要求忽略管理信息。图片能力检查始终忽略控制通知的附件。

## 工具参数契约

可选参数通过宿主 DSL 的 `oneOf` 显式接受原类型或 `null`，缺省与 `null` 使用相同默认行为。查询入口归一化兼容占位：`context_search` 的空 `tool`、空 `cursor` 和空 `roles` 数组分别对应无工具筛选、新搜索与全部角色；`context_status` 的空 `ids` 数组对应默认有界目录。归一化后的角色与工具筛选参与游标指纹，翻页仍绑定同一会话、查询、筛选及归档快照。

必填参数保持严格校验。释放 ID 数组必须包含 1–128 个正安全整数；释放与摘要请求的原因去除首尾空白后须为 1–1000 个字符。显式数值必须满足整数及范围约束，`0` 不作为 `limit` 的缺省值。宿主 DSL 未提供的长度和数值约束写入参数说明，由执行入口校验。

## 释放账本

`context_release` 每次接受 1–128 个数字 ID。请求记录意图后返回排队、已结算、未知或不支持的目标。用户与助手文字可搜索和恢复，释放目标为工具结果正文和单个附件。

状态独立于 ID：

| 状态         | 含义                                       |
| ------------ | ------------------------------------------ |
| `available`  | 未标记，且未被摘要覆盖。                   |
| `queued`     | 已接收意图，等待合批条件或安全的覆盖摘要。 |
| `released`   | 目标正文或附件已实际替换。                 |
| `summarized` | 目标正文或释放占位已被覆盖摘要吸收。       |

工具结果释放只替换结果正文，保留调用和助手原始记录；附件释放只替换对应出现。受原生回放保护的助手附件等待覆盖摘要，避免单独修改签名消息。

意图和实际替换分别提交。失败或取消时，未完成项目继续排队；账本只在观察到相应提交后结算。覆盖摘要选区内可安全排除的排队目标进入摘要过滤，范围外目标继续保留。

## 合批调度

释放请求先排队。低压力且当前缓存仍热时，调度等待合适的重建机会。安全步骤边界检查以下信号：

- 本来就要发生的独立缓存重建机会。
- 可信主请求 usage 对应的空闲 TTL 已到期。
- 普通压力、供应商 overflow 或用户 `/compact`。
- 达到释放积压门槛或最长等待步骤。

默认配置：

```yaml
scheduling:
    releaseMinTokens: 2048
    releaseMaxWaitSteps: 16
    releaseBacklogRatio: 0.15
    cacheTtlMs: 300000
```

`releaseMinTokens` 是独立释放的最低预计净节省；`releaseMaxWaitSteps` 限制排队等待；`releaseBacklogRatio` 控制积压比例门槛；`cacheTtlMs` 为可信 usage 对应的空闲缓存 TTL，0 关闭该触发条件。强制处理路径与低压力路径分别判断收益和紧迫程度，`context_status` 返回当前计划和阻断原因。

历史 cache miss 仅说明当次请求的缓存情况。后续调度根据最新 usage、时间和当前输入重新判断，避免把历史 miss 固定解释为未来持续冷缓存。缺少可信 usage 时，TTL 不能凭空构造缓存到期证据。

独立释放不调用摘要模型，也不使用低压力摘要回本门槛。`compaction.auto` 控制自动摘要，`scheduling.enabled` 控制摘要经济调度；释放仍检查自身的缓存机会、积压和最大等待条件。

## 压力处理与摘要

处理顺序为：

```text
pressure -> release -> remeasure -> summary if still needed
```

先基于实际输入与最新可信主请求 usage 测量压力，再处理安全可释放内容，按替换后的历史重新测量。释放已经足够时，本轮继续主请求。仍有压力时才进入摘要规划。实际 overflow 先处理可释放内容，再进入原生恢复。用户 `/compact` 直接使用 SDK 的持锁维护事务，排队目标通过同一摘要提交结算，保护最新任务与工具配对。

普通压力阈值为 `max(1, floor(contextWindow × thresholdRatio))`。窗口必须是正安全整数。保留目标按 `retainTokens` 或 `floor(contextWindow × retainRatio)` 计算，并限制在 0 至阈值减 1 之间。`headroomTokens` 为摘要默认输出预算，显式 `compaction.maxTokens` 可覆盖它。

摘要覆盖较旧的连续历史前缀，保留开头的 system 与近期安全尾部。切点须保持工具调用与结果完整；原生 assistant 回放的规划成本参考同一 provider/model 的 output usage。最新主请求 input usage 校准总压力，历史请求的完整 input usage 不累加到选区成本。

摘要路由由 fold 自有 `summaryModels` 有序列表决定；`preferWhenSessionMatches` 默认 true，供应商与模型都匹配会话的开启项稳定提前，其余项保持顺序。空列表跟随会话。显式强度覆盖该项请求；未指定强度时，同模型沿用会话强度，其他模型交给供应商默认值。profile 根 `uiOnly` 条目提供 `foldContextSettings` 服务，保存 `.volatile()` 列表，preset 内的引擎在每次摘要时读取；没有根服务时使用引擎本地配置。页面只通过 settings Remote 的修订号保护 `mutate` 写入该字段。

引擎保留 `BasicCompactionEngine` 继承和官方事务，只替换辅助摘要实现。同模型且没有选区排除或图片引用要求时，原样转交历史消息、原生签名、工具定义和 toolHistory，追加最后一条摘要指令，复用 `sessionId` 并标记 `purpose: compaction`。该流直接调用 LLM，不进入 Agent turn/inbox；只有成功 checkpoint 由原事务提交。缓存命中是供应商行为，不作保证。

需要过滤释放内容、处理图片引用或改用其他模型时，生成历史数据投影：剔除来源标记的控制信息，默认省略 reasoning，附件保留归档引用；`preserve` 可保留 reasoning 文字。`summary.images: auto` 只向明确支持图片的路由传原图。checkpoint stamp 记录实际策略：原生前缀为 preserve，数据投影使用配置策略。

候选按顺序执行，模型或传输失败、供应商确认窗口不足、无效/空/截断输出只推进到下一项。用户取消、未分类的内部错误及事务错误直接终止；候选之间不提交失败输出。候选窗口已知时，按估计输入收紧输出预算；估算不足以拒绝输入，超限判断以供应商响应为准。全部失败时保留各候选错误并由官方流程关闭事务。

辅助请求预算包括过滤后的历史、保留的 system、工具定义和 framing。固定输入、受保护尾部或摘要输出仍可能超过很小的模型窗口；预算规划只能预测，真实主请求 usage 验证结果。

摘要后记录预计降幅，等待后续主请求 input usage 验证。辅助摘要模型的 usage 不参与主请求效果确认。仍超阈值时逐步缩小保留预算，必要时采用最大合法前缀；同次处理遵守官方重试上限。无预计改善，或普通压力选区只含 checkpoint、控制消息、baseline、MCP snapshot 等内部材料时，停止重复摘要。

## 低压力摘要经济模型

只有低压力摘要使用回本门槛。计划需满足最小间隔、预计净节省量、节省比例和未来请求内的回本要求。默认 `paybackTurns` 为 24，未知缓存按已缓存前缀保守估算。

总成本为：

```text
upfrontCost = summaryCost + incrementalRebuildCost
```

`summaryCost` 使用摘要输入和预计输出的相对权重。`incrementalRebuildCost` 只计算本次决策额外造成的缓存重建成本。同批释放与摘要共用的重建只计算一次；已发生或独立机会本来就需要的重建不重复计入。摘要净收益扣除可直接释放的选区内容，比例门槛使用释放后的预计输入，避免待释放标记自己制造重建许可。独立重建许可只覆盖其原有失效点之后的释放目标；本插件自己的释放及清理改写不能提供这项许可。未来节省与当前缓存证据共同决定预计回本请求数，等待几个步骤本身不会累计收益。

主要默认值如下，其余配置见 [README](../README.md)：

```yaml
scheduling:
    enabled: true
    proactive: true
    minIntervalSteps: 8
    minSavingsTokens: 2048
    minSavingsRatio: 0.2
    expectedSummaryRatio: 0.2
    paybackTurns: 24
    cacheReadRatio: 0.1
    summaryInputRatio: 1
    summaryOutputRatio: 1
```

成本字段均为 HEURISTIC 估算，不保证供应商缓存命中或实际节费。`context_status` 按需给出调度原因、辅助请求预算拆分、受保护尾部和固定输入下限、压力效果与验证状态。

## 提醒与管理调用清理

候选需要仍在当前上下文中且经过 `minAgeSteps`。默认至少 16000 候选 tokens，或 4000 tokens 停留 8 个业务步骤，或总压力达到有效阈值 80% 且候选至少 4000 tokens 时提醒。单个 8000 tokens 大结果优先排列。

候选行只列 ID，默认最多 5 个，后附一句及时检查并标记已消费内容的提示；数量只限制展示，模型可以主动标记其他合法 ID。普通间隔 6 步、压力间隔 4 步，忽略后退避到 12、24 步，新增候选与实际释放进展可使提醒重新就绪。纯管理调用不推动业务年龄和提醒冷却。排队与已释放目标离开候选池。

目标实际结算后，成功的直接 `context_release` 调用及结果可在后续模型请求前成对清理。调用组必须只包含该工具，结果必须与原始身份、内容和元数据一致，组内不能夹杂业务消息。所有 PTC 程序、结果及混合调用组按业务内容保留；嵌套释放通过工具派发事件提交意图。清理产生的 developer 替换记录不提供独立重建信用。

## 归档与恢复

`context_search` 对会话内原始正文做字面子串搜索，支持角色与工具名过滤、分页和 continuation cursor。`context_expand` 按稳定 ID 分页恢复文字，返回 `nextOffset` 供继续读取。恢复进入新的上下文，不改变原目标的释放或摘要状态。

恢复元数据通过 `recoveryReleaseMetadata` 从账本读取。只有确认 `released` 的记录才可带有可选 `releaseReason`，排队或仅由摘要覆盖的标记不冒充已完成释放。附件优先使用自身记录的原因，否则读取所属消息的原因；缺少历史原因时省略。分页、重放与冷启动沿用同一条账本证据。`context_search` 只返回原有状态信息，避免在多条搜索命中中重复加入原因。

图片恢复校验原始存储并确认当前模型支持图片后传入原图。文件恢复校验完整内容并返回可读句柄；句柄交付与模型已读取文件正文分别表示。缺少服务、存储丢失、校验失败、能力不足或文件路径映射失败须显式报告。

归档是原始证据源，当前上下文的轻量占位与摘要只是投影。重启和 fork 需沿会话事件重建数字 ID、意图和状态，保留相同源记录的身份边界。

## 配置所有权与生效

profile 根条目 `fold-context-ui` 提供 `foldContextSettings`，持有 `summaryModels` 与 `policyOverrides` 两个 volatile 字段。运行策略分 compaction、release、summary、scheduling、reminders 五组，各组保存 `enabled` 与 `values`。`enabled: false` 代表继承该 Agent 预设；启用时整组使用界面值，防止根条目的默认值覆盖已有预设。

策略目录集中记录 37 个字段及其双语说明、默认值和约束，并覆盖按模型策略的可选字段。Host schema 与 Client 共享同一个规范化校验器，Client 构建把目录与自包含校验器注入普通 JavaScript 工厂，不依赖 Harness Client 私有包。Host 在持久化前拒绝非法边界和递减的退避列表。

页面用同一个 namespace revision 原子保存模型列表与全部策略，断线、冲突或异常回执保留草稿。新引擎从根服务选取运行策略并克隆快照，运行中的原生事务保持自己的配置；摘要模型仍在每次摘要时读取最新列表。

## Client 回执与行展示

最终释放 prune 在 `data.foldContextRelease` 写入 v8 回执。Client 验证版本、数字字符串 ID 及数组结构，并要求紧随的替换事件引用同一 prune 目标，才展示完成行。仅有排队意图、普通 pruner 截短或未完成的替换均不足以宣称释放完成。

Host 回执包含 `released`、`pending` 数组，条目保留 `id`、类型、owner、预览、标记原因和等待原因等字段。Client 按精确的标记原因组合两类记录，再在每组内区分已释放与各类等待原因；分组与编号保持首次出现顺序。编号区域按实际可用宽度与字体测量，默认最多两行，隐藏编号不挂载到 DOM，可通过展开控件完整显示。单项详情只显示已有元数据，全视图同时只展开一项。预计 token 变化按本批消息替换差值计算，整条工具结果与所含附件只计一次，并扣除占位开销。

工具与完成行沿用 DSH 原生样式：结果紧跟标题，悬停或聚焦时左侧图标切换为箭头，保持图标尺度；数字使用未分隔的十进制文本。页面文案支持中英切换，结构异常回退为可查看的原始输出。

## 验证边界

Client 测试由 [client.test.mjs](../test/client.test.mjs) 和 [client-release.test.mjs](../test/client-release.test.mjs) 覆盖：工具状态、数字参数与响应、语言切换、回执与替换配对、旧协议拒绝，以及原因精确分组、超过 128 个编号、双行测量、单项详情、键盘焦点与字体加载重测。[release-reason.test.mjs](../test/release-reason.test.mjs) 与附件、持久化测试验证恢复原因及状态来源。Host 调度、编号与摘要由对应隔离测试验证；Client 测试不证明真实浏览器布局或供应商缓存收益。

完整测试使用隔离临时构建，安装与打包构建更新仓库 `lib`。并行编辑时可仅把当前 Client 源码和直接测试复制到临时目录运行，避免覆盖其他代理的构建产物。
