# dsh-fold-context

[![CI and Release](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml/badge.svg)](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml)

让 DSH 的长任务上下文压缩更可预测：已用完的工具结果和单个附件可独立释放，保留可恢复的编号占位；较旧历史由官方摘要流程整理。插件按积累、停留时间和压力提醒模型检查候选，并明确区分排队、实际释放和摘要覆盖。

适合需要持续阅读文件、调用工具、反复调查和跨多轮推进的任务。压缩以 DSH 官方摘要事务为基础，记忆提炼采用独立适配接口。

> 当前版本为 `0.2.3`，支持 DSH `0.2.0-rc.2`。独立释放、编号别名、提醒、摘要、恢复、原生回放选区与压力效果跟踪通过隔离测试验证；真实模型摘要质量、供应商缓存与节费效果仍需实际评估。记忆适配接口已经提供，自动提炼与 Mnemon 集成尚未实现。

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

需要 Node.js **24.11.0 或更高版本**，以及 DSH **0.2.0-rc.2**。安装插件和启用压缩引擎是两个步骤：安装只加载 Web 展示，压缩引擎需要接入你实际使用的 Agent preset。

### 1. 安装到目标 profile

从 GitHub 安装到 `web` profile：

```bash
dsh plugin --profile web add github:HumXC/dsh-fold-context
```

使用其他 profile 时，将 `web` 换成对应名称。GitHub 安装通过 `prepare` 从源码构建；如果 pnpm 提示阻止了该 Git 依赖的构建，按提示批准本仓库对应的准确依赖键，再重新执行安装命令。

也可以从 [GitHub Releases](https://github.com/HumXC/dsh-fold-context/releases) 下载已构建的安装包，通过 DSH 插件管理功能安装。

本地开发使用 `packageManager` 锁定的 pnpm **11.15.0**，在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

然后通过插件管理功能安装构建后的本地目录。让 DSH 助手调用 `plugin_manager` 时，使用 `install_bundle`，`target` 写成 `dsh-fold-context@file:/绝对路径/dsh-fold-context`。执行 `pnpm pack` 可生成安装包；打包时也会自动构建。

### 2. 在自己的 preset 中替换压缩引擎

安装会通过随包发布的 [cordis.patch.yml](./cordis.patch.yml) 在 profile 根层挂载 `fold-context-ui`（`uiOnly: true`），用于加载工具卡片和释放过程展示。要启用 `context_*` 工具、释放、提醒和摘要功能，需要在会话所用 preset 的 compaction 组内挂载压缩引擎。

先确认会话使用哪个 preset，再修改该 preset 的完整声明中的 `config.plugins`。找到 `id: compaction` 组，在组内做下面的替换，保留其余插件和配置：

```diff
-      - id: compaction-basic
-        name: "@deepseek-ai/dsh-compaction-basic"
+      - id: fold-context
+        name: dsh-fold-context
```

将该组的 `disabled` 设为 `false`，保留 `compaction: true` 和 `toolResultPruner: true` 的隔离设置。下面是完整的 compaction 组片段，放在 **preset 的 `config.plugins` 列表内**，用于替换其中的 compaction 组：

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

这里，组的 `config` 是子插件列表；`fold-context` 行下的 `config` 才是本插件选项。`compaction.auto` 控制普通压力与 backlog 摘要，`scheduling.enabled` 控制经济调度，`scheduling.proactive` 控制低压力下的释放 backlog 摘要。完整可调参数及注释见[配置示例](./examples/compaction-group.fragment.yml)。

每个 compaction scope 只保留一个压缩引擎，不能同时挂载 `compaction-basic` 和 `dsh-fold-context`。`command-compact` 提供手动 `/compact`，`tool-result-pruner` 可选共存，后两者的运行包由 DSH 提供。仅在 profile 根层增加引擎行，无法替换 preset 内的隔离服务。

#### 使用内置 preset、还没有自己的声明时

先导出当前 profile 的配置，作为本地核对依据：

```bash
dsh --profile web --dump-config > web.config.yml
```

在导出结果中找到实际使用的声明，例如 `id: preset-standard`，将**这一整条声明**复制到你自己的 profile 覆盖层，再只替换其中的 compaction 组。默认覆盖文件为 `~/.dsh/profiles/web/cordis.patch.yml`；设置了 `DSH_HOME` 时，使用该目录下的 `profiles/web/cordis.patch.yml`。已有同 id 的覆盖时，直接修改已有条目；其他 profile 补丁条目继续保留。也可以在自己维护的 preset bundle 中完成同样修改。

**不要把上面的组片段直接粘到 profile 补丁顶层，也不要用它替换整份 preset。** 当前 Loader 不会进入 `config.plugins` 查找组 id，对 preset 的 `config` 也不做深度合并。覆盖内置 preset 时必须保留该声明完整的 `id`、`order`、全部 `plugins`、其他原有字段及 `!!js` 表达式；否则可能丢失其他工具。只复制目标 preset，保留你已有的自定义内容，不要把整个导出结果覆盖回 profile 文件。

### 3. 生效与检查

安装返回 `restart-required` 时，先重启 DSH，再刷新页面；live profile 应用成功后可刷新页面。修改 preset 后创建一个选择了该 preset 的**新会话**进行验证，已有会话不会自动切换正在使用的 preset revision。

在新会话中让助手调用 `context_status`：能调用该工具，才说明压缩引擎已接入。仅看到专用卡片样式不能证明引擎已经启用。若没有 `context_*` 工具，检查是否修改了当前会话选择的 preset、compaction 组是否启用，以及是否仍只挂载了根层的 `uiOnly` 展示入口。

pruner 在符合压缩触发条件时可以先按字符预算截短工具结果，再决定是否生成摘要。`context_release` 则记录语义意图，在下一安全步骤边界独立替换已选正文；两者都不必调用模型，原始结果保存在会话日志中。仅出现普通 pruner 截短不构成语义释放回执。

原文恢复需要 `sessionQuery` 服务；图片和文件恢复还需要可见的附件存储，文件句柄需要文件系统路径映射。持久恢复依赖 DSH 会话日志正常保留，以及官方 `session-checkpoint-policy` 成功落盘。

释放过程元数据记录在本批最后一个 `compaction/prune` 的 `data.foldContextRelease` 中。Client 只有观察到紧随其后、引用相同目标的替换事件，才展示完成卡片；排队、普通 pruner 截短以及未完成的 prune 都不会显示为已释放。

卡片标题显示“已释放上下文 — 预计减少 N tokens”，并保留本批项数与等待项数。token 数按本批原始消息与替换消息的估算差值计算，已扣除占位开销；整条工具结果及其中的附件只计一次。若占位较长导致净增加，则显示“预计增加 N tokens”。

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

`R` 只是可见状态，不生成新身份，也不会恢复原正文。查看 `context_status` 可区分步骤边界等待、协议保护、摘要范围外和摘要失败冷却。

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
    paybackTurns: 24
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

| 选项                                       | 含义                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `compaction.auto`                          | 关闭普通压力和 backlog 自动摘要；独立释放仍运行，实际溢出恢复、模型显式请求和用户 `/compact` 仍可执行。 |
| `thresholdRatio`                           | 普通压力阈值占当前 `contextWindow` 的比例。                                                             |
| `retainRatio`                              | 近期原文尾部占当前窗口的预算比例；保留目标最多为触发阈值减 1，不是压缩后的目标大小。                    |
| `headroomTokens` / `compaction.maxTokens`  | 原生摘要请求的默认输出预算与显式输出上限；不参与普通压力阈值计算。                                      |
| `scheduling.enabled`                       | 开启经济调度；关闭后，模型显式请求沿用旧的强制摘要行为。                                                |
| `scheduling.proactive`                     | 允许排队标记自动触发低压力摘要；关闭后仍可通过模型显式请求触发。                                        |
| `minIntervalSteps`                         | 距离上次摘要至少经过多少个已提交的 assistant 步骤。                                                     |
| `minSavingsTokens` / `minSavingsRatio`     | 最低预计净缩短量，以及相对当前总输入的最低比例。                                                        |
| `paybackTurns`                             | 默认允许在未来 24 次主请求内估算回本，适合长会话；短任务可显式设为 8。                                  |
| `cacheReadRatio`                           | 默认 0.1，表示缓存读取的相对成本权重；未知命中情况保守按已缓存估算，不为触发摘要而抬高它。              |
| `expectedSummaryRatio`                     | 默认 0.2，预测摘要相对实际辅助请求输入的大小。                                                          |
| `summaryInputRatio` / `summaryOutputRatio` | 默认均为 1，表示摘要路由输入和输出的相对成本权重；按实际路由校准。                                      |
| `summary.reasoning`                        | 默认只从摘要输入省略 reasoning；`preserve` 将其作为历史文字保留。                                       |
| `summary.images`                           | `auto` 仅向明确支持图片的摘要模型传原图；`references` 固定只传引用。                                    |
| `release.catalogLimit`                     | 按需目录大小，范围 1–128；日常通知最多附带 8 条变化。                                                   |

普通压力阈值为 `max(1, floor(C × thresholdRatio))`，其中 C 是当前模型的 `contextWindow`。保留尾部按 `floor(C × retainRatio)` 或显式 `retainTokens` 计算，并限制在 `0` 到 `阈值 − 1` 之间。模型专属参数通过 `compaction.modelPolicies` 配置；模型专属保留参数优先于全局设置。自动压缩、`context_status` 和释放提醒使用同一预算。

主请求的输出上限由模型适配器管理。任意正安全整数窗口都能得到有效的压缩预算，包括窗口小于主请求 `maxTokens` 或固定安全余量的情况。未知、非正整数或超出安全整数范围的窗口会停用普通压力判断。`headroomTokens` 用作原生摘要的默认输出预算，显式 `compaction.maxTokens` 可以覆盖它。

规划预算不代表供应商接受了相同的输入和输出组合。固定提示词、工具定义、受保护尾部及摘要本身可能超过很小的窗口；系统仍保留工具配对和当前任务，只有生成摘要后的实际用量才能验证是否达到目标。

成本字段是 **HEURISTIC 估算权重**，不是供应商价格。未知缓存按已缓存前缀保守估算。真正提交摘要仍会改变历史前缀，因此不能保证缓存命中或实际节费。

`context_status` 按需返回当前阻断原因及下一步动作、固定请求开销与受保护尾部的下限、摘要输入的历史/system/tools/framing 拆分，以及回本所需的未来主请求次数。缺少窗口、无效窗口和模型配置读取失败分别报告；配置读取失败时仍可检查释放 backlog，取消会保持取消结果。

例如选区 8000 tokens、过滤后辅助输入 6000、保留尾部 3000、固定头部 1000 时，默认权重预测摘要 1200，摘要成本 7200，加上首次缓存重建 3780，每次后续主请求预计节省 680，约需 17 次请求回本。其他门槛满足时，默认 24 次周期允许执行，显式 8 次周期继续等待。`not_paid_back` 是对未来收益的预测；单纯多等几个步骤不会累计回本。固定输入或当前任务已超过压力阈值时，状态会明确说明仅摘要旧历史无法达到目标。

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

普通压力压缩的选区若仅包含已有 checkpoint、编号/释放管理通知、重新注入的指令 baseline 或 MCP snapshot，会跳过摘要调用；真实业务内容和非 baseline 的指令变化仍可触发摘要。手动 `/compact`、显式 checkpoint 请求与真实溢出恢复保留兜底。摘要输入省略管理通知以及 U/A/T 来源编号，I/F 归档引用和任务本身涉及的编号字符串继续保留。

工程细节见[架构说明](./docs/architecture.md)；参考设计见[Magic Context 对照](./docs/magic-context-research.md)。

## GitHub CI 与发布

GitHub Actions 使用 Node.js 24，并读取 `packageManager` 中锁定的 pnpm 版本：

- 推送 `main`、向 `main` 提交 PR 或手动运行工作流时，检查格式和类型，构建 Host 与 Client，运行全套测试并打包。
- 每次成功构建保留 14 天的 Actions artifact，包含 `dsh-fold-context.tgz` 和 `SHA256SUMS`。
- 推送 `v*` 标签时，先校验标签与 `package.json` 的版本一致，再执行相同检查。通过后自动创建 GitHub Release，上传安装包和校验文件；带 `-` 的版本标记为 prerelease。

发布前先提交版本与代码，再推送对应标签。例如当前包版本为 `0.2.3` 时：

```bash
git tag v0.2.3
git push origin v0.2.3
```

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需额外配置发布凭据。发布后的安装包可从 [GitHub Releases](https://github.com/HumXC/dsh-fold-context/releases) 下载；将安装包和 `SHA256SUMS` 放在同一目录后，执行 `sha256sum --check SHA256SUMS` 校验，再通过 DSH 插件管理安装。

## 许可证

[MIT](./LICENSE)。
