# dsh-fold-context

[![CI and Release](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml/badge.svg)](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml)

让 DSH 的长任务上下文更容易管理：每会话使用稳定的纯数字 ID，模型可以标记已用完的工具结果和单个附件，代码在合适时机合批释放。较旧历史由 DSH 官方摘要事务整理，原始证据保存在会话归档中，支持搜索与恢复。

适合持续阅读文件、调用工具、反复调查和跨多轮推进的任务。模型负责判断证据是否仍有用；插件负责排队、缓存感知调度、压力检查和提交。

> 当前版本为 `0.2.3`，支持 DSH `0.2.0-rc.2`。纯数字 ID、独立控制消息、释放调度与摘要使用会话协议 v8。真实模型摘要质量、供应商缓存与节费效果需要实际评估。记忆适配接口已经提供，自动提炼与 Mnemon 集成尚未实现。

## 能做什么

- **稳定的纯数字 ID**：消息、工具结果及每次附件出现共享会话内的递增序号，原始正文与助手签名、原生重放保持完整。
- **独立控制消息**：每次模型请求前追加一条 `user` 消息，列出上次分配、本次预留 ID，以及必要的附件映射与释放建议。
- **合批释放**：工具结果正文和单个附件先排队，在缓存重建机会、空闲 TTL 到期、压力、积压或最大等待条件下合批替换为轻量占位。
- **动态提醒**：按候选积累、停留时间和压力建议模型检查已用完的内容，忽略后逐步退避；提醒只列 ID，由模型决定是否释放。
- **按压力决定摘要**：先释放并重新测量，仍有压力才生成摘要；低压力摘要另需满足间隔、预计节省和回本门槛。
- **可恢复的原始证据**：按 ID 展开原文，或先搜索历史再恢复。图片校验后重新传入，文件校验后提供读取句柄。
- **原生 Web 展示**：五个工具使用 DSH 行风格和主题颜色，结果紧跟标题，悬停时左侧图标显示展开箭头，支持中英切换。
- **可核对的释放回执**：替换提交后显示本批 ID、原文预览、释放原因、等待项目及预计 token 变化。

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

开发验证使用 `node scripts/verify-isolated.mjs`，构建产物和测试均放入临时目录。发布前执行 `pnpm pack` 生成安装包，再通过 DSH 插件管理功能安装该安装包或独立的已构建快照。运行中的 DSH 实例应与开发目录隔离，避免通过 `file:` 直接链接正在修改的工作区，以免开发构建或依赖安装影响现有会话。

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

这里，组的 `config` 是子插件列表；`fold-context` 行下的 `config` 才是本插件选项。`compaction.auto` 控制普通压力与 backlog 自动摘要，`scheduling.enabled` 控制低压力摘要的经济调度，`scheduling.proactive` 允许积压标记触发低压力摘要。独立释放仍由合批条件调度。

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

pruner 在符合压缩触发条件时可以先按字符预算截短工具结果，再决定是否生成摘要。`context_release` 记录释放意图，由插件在安全步骤边界检查合批条件；两者都不必调用模型，原始结果保存在会话日志中。普通 pruner 截短只有对应真实释放替换时才形成语义释放回执。

原文恢复需要 `sessionQuery` 服务；图片和文件恢复还需要可见的附件存储，文件句柄需要文件系统路径映射。持久恢复依赖 DSH 会话日志正常保留，以及官方 `session-checkpoint-policy` 成功落盘。

释放元数据使用 v8 回执，记录在本批最后一个 `compaction/prune` 的 `data.foldContextRelease` 中。Client 观察到紧随其后、引用相同目标的替换事件，才展示完成行。排队状态与实际替换分别记录。

完成行显示“已释放上下文 — 预计减少 N tokens”，并保留本批项数与等待项数，数字使用原始十进制形式。token 数按原始消息与替换消息的估算差值计算，扣除占位开销；整条工具结果及其中附件只计一次。净增加时显示“预计增加 N tokens”。

## 日常使用

启用后，模型会收到使用规则和独立的 ID 控制消息。原始用户、助手和工具正文保持原样。通常无需人工管理 ID；你可以让模型在阶段结束后标记已用完的证据，查看排队状态，或恢复之前的结果。

| 工具              | 用途                                                           |
| ----------------- | -------------------------------------------------------------- |
| `context_release` | 批量释放已用完的工具结果正文或单个附件；返回排队或已结算状态。 |
| `context_compact` | 请求在后续步骤边界生成摘要；低压力下可能等待调度条件。         |
| `context_status`  | 查看编号、状态、等待原因、提醒状态及独立摘要调度计划。         |
| `context_search`  | 按原文片段、角色或工具名查找当前会话历史。                     |
| `context_expand`  | 根据编号分页恢复原文，或恢复已校验的图片、文件句柄。           |

例如，模型可以调用：

```json
{ "ids": [19, 20], "reason": "调查已完成，结论已经保留" }
```

这是 `context_release` 的参数。`reason` 保留在内部日志中，工具返回当前排队或结算状态。目标实际结算后，成功的纯 release 调用及其结果会在下一次模型请求前成对清理；包含业务文字、其他工具、日志、自定义返回值或未完成目标的调用继续保留。可明确验证为纯 release 的 PTC 包装同样处理。

编号必须来自当前会话，不能照搬示例编号。要找回证据，可以先用 `context_search` 搜索关键片段，再调用：

```json
{ "id": 19 }
```

这是 `context_expand` 的参数。恢复结果进入新的上下文，不撤销之前的压缩。文本结果较长时，根据返回的 `nextOffset` 继续读取。

如果你希望立即整理历史，可以使用官方 `/compact`。模型调用 `context_compact` 则会进入代码调度，不保证下一步就执行。

### ID、控制消息与状态

每会话从正整数开始分配稳定 ID，消息与附件共享递增序号。同一图片或文件重复出现，各有自己的 ID。工具参数 `id`、`ids` 使用 JSON number；内部记录与响应使用十进制数字字符串。释放后仍使用同一 ID，状态单独表示。

每次请求模型前，插件追加一条独立 `user` 控制消息，例如：

```text
prev: 101 103
next: 104
attachments:
102 101 1
try_release: 12 18
```

`prev` 按进入请求的顺序列出本次新声明的消息 ID；通过 `next` 预声明的助手 ID 在绑定后不会重复列入 `prev`。`next` 给出本次请求预留的助手 ID。`attachments` 仅在有附件时出现，每行依次是附件 ID、所属消息 ID、附件序号（从 1 起）。`try_release` 仅在触发提醒时出现，列出建议检查的 ID。它是建议列表，模型也能主动标记其他可释放 ID。

插件依据 `source.kind = 'fold-context-allocation'` 识别控制消息。业务正文中的相同文字保持业务含义，原文不需要携带标签。助手的正文、reasoning、签名与 `replayState` 完整保留。控制消息从摘要输入排除，其实际 token 仍计入压力。

消息 ID 可用于搜索和恢复；释放工具只接受工具结果正文与单个附件，用户和助手文字保持保留。条目状态如下：

- `available`：尚未标记，且未被摘要覆盖。
- `queued`：意图已接收，等待合批条件或覆盖摘要；受保护的助手附件等待覆盖摘要。
- `released`：正文或附件已实际替换，ID 保持不变。
- `summarized`：正文或释放占位已被摘要覆盖；覆盖范围内的逐条占位随之移除。

`context_status` 给出当前等待原因、调度计划和实际释放状态。

## 什么时候提醒释放

候选须在当前上下文中仍可处理，并至少经历两个后续业务步骤。纯 `context_*` 管理调用不推动年龄或冷却。默认在以下情况提醒：积累至少 16000 个候选 token；至少 4000 个候选 token 持续停留 8 个业务步骤；或总输入达到官方有效压力阈值的 80%，且候选至少 4000 token。单个至少 8000 token 的大结果优先排列，但不单独触发。

每次最多列 5 个候选 ID，不附预览；普通间隔 6 步、压力间隔 4 步，没有释放进展时退避到 12、24 步。新增至少 8000 候选 token 或新的有效释放意图可重置忽略退避，仍遵守最小间隔。该展示上限不限制模型主动标记范围；`context_release` 每次最多接受 128 个 ID。排队和已释放内容离开候选池，无候选或摘要进行中不提醒。

## 什么时候释放与生成摘要

`context_release` 先排队，低压力且缓存仍热时等待合批。独立缓存重建机会、可信主请求 usage 对应的空闲缓存 TTL 到期、普通压力、实际溢出、用户 `/compact`、释放积压或最大等待条件，可以触发批处理。默认单批最低预计收益为 2048 tokens，最大等待 16 个步骤，积压比例为 0.15，空闲 TTL 为 300000 毫秒；TTL 设为 0 可关闭该触发条件。TTL 判断依赖可信 usage，历史 cache miss 只说明那一次请求的状态。

压力处理顺序是：**测量压力 → 合批释放 → 重新测量 → 仍不足才摘要**。释放已经让输入回到目标范围时，本轮可以直接继续主请求。

摘要有四条触发路径：

1. **常规压力**：独立释放后仍达到官方有效压力阈值。
2. **实际溢出**：模型供应商报告上下文超限时走官方恢复，先处理安全可释放内容并复测。
3. **提前整理**：有排队标记或模型主动请求，且满足低压力摘要经济门槛。
4. **用户 `/compact`**：优先处理可释放内容，再按需要执行安全摘要，绕过低压力经济门槛。

普通压力和提前整理保留近期原文尾部，摘要覆盖较旧的**连续前缀**。开头的 system 消息保留，切点保持工具调用与结果配对。对同一 provider/model 的原生 assistant 回放，选区成本参考 output usage；最新主请求的 input usage 校准总压力。规划不按加密签名长度估算，也不把历次完整 input usage 相加。溢出和 `/compact` 使用更激进的保留策略，仍保护当前任务和最新安全尾部。

摘要后先记录预计降幅，再等待下一次主请求 input usage 验证；辅助摘要模型 usage 不参与验证。`context_status` 的 `scheduling.pressure` 区分等待验证、低于阈值和仍高于阈值。实际未改善时逐步缩小保留预算；主请求确认仍超阈值时，可采用最大合法历史前缀。同次处理遵守官方重试上限，无预计改善或选区只剩旧 checkpoint/管理快照时停止。受保护尾部或固定输入超过预算时，生成 checkpoint 本身不能证明已满足目标。

独立释放的合批门槛与低压力摘要经济门槛分别计算。关闭 `compaction.auto` 或 `scheduling.enabled` 时，独立释放仍检查缓存机会、积压和最大等待等条件。覆盖摘要替换完整选区，选区内可安全排除的标记从摘要输入过滤，范围外标记继续等待。

生成摘要和检查图片能力之前，插件过滤独立控制消息、release 清理通知与内部状态记录。辅助请求预算按过滤后的历史估算，并计入保留的 system、工具定义及 framing；过滤通知中的附件不会触发图片能力检查。

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
    releaseMinTokens: 2048
    releaseMaxWaitSteps: 16
    releaseBacklogRatio: 0.15
    cacheTtlMs: 300000
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
| `scheduling.enabled`                       | 开启低压力摘要经济调度；关闭时模型显式摘要请求使用强制路径，独立释放仍检查合批条件。                    |
| `scheduling.proactive`                     | 允许排队标记自动触发低压力摘要；关闭后仍可通过模型显式请求触发。                                        |
| `minIntervalSteps`                         | 距离上次摘要至少经过多少个已提交的 assistant 步骤。                                                     |
| `minSavingsTokens` / `minSavingsRatio`     | 最低预计净缩短量，以及相对当前总输入的最低比例。                                                        |
| `paybackTurns`                             | 默认允许在未来 24 次主请求内估算回本，适合长会话；短任务可显式设为 8。                                  |
| `cacheReadRatio`                           | 默认 0.1，表示缓存读取的相对成本权重；未知命中情况保守按已缓存估算，不为触发摘要而抬高它。              |
| `expectedSummaryRatio`                     | 默认 0.2，预测摘要相对实际辅助请求输入的大小。                                                          |
| `summaryInputRatio` / `summaryOutputRatio` | 默认均为 1，表示摘要路由输入和输出的相对成本权重；按实际路由校准。                                      |
| `releaseMinTokens`                         | 独立释放的最低预计净节省，默认 2048 tokens。                                                            |
| `releaseMaxWaitSteps`                      | 排队释放最大等待步骤，默认 16。                                                                         |
| `releaseBacklogRatio`                      | 释放积压比例门槛，默认 0.15。                                                                           |
| `cacheTtlMs`                               | 可信主请求 usage 对应的空闲缓存 TTL，默认 300000 毫秒；0 关闭 TTL 触发。                                |
| `summary.reasoning`                        | 默认只从摘要输入省略 reasoning；`preserve` 将其作为历史文字保留。                                       |
| `summary.images`                           | `auto` 仅向明确支持图片的摘要模型传原图；`references` 固定只传引用。                                    |
| `release.catalogLimit`                     | 按需目录大小，默认 32，范围 1–128；完整状态通过 `context_status` 查询。                                 |

普通压力阈值为 `max(1, floor(C × thresholdRatio))`，其中 C 是当前模型的 `contextWindow`。保留尾部按 `floor(C × retainRatio)` 或显式 `retainTokens` 计算，并限制在 `0` 到 `阈值 − 1` 之间。模型专属参数通过 `compaction.modelPolicies` 配置；模型专属保留参数优先于全局设置。自动压缩、`context_status` 和释放提醒使用同一预算。

主请求的输出上限由模型适配器管理。任意正安全整数窗口都能得到有效的压缩预算，包括窗口小于主请求 `maxTokens` 或固定安全余量的情况。未知、非正整数或超出安全整数范围的窗口会停用普通压力判断。`headroomTokens` 用作原生摘要的默认输出预算，显式 `compaction.maxTokens` 可以覆盖它。

规划预算不代表供应商接受了相同的输入和输出组合。固定提示词、工具定义、受保护尾部及摘要本身可能超过很小的窗口；系统仍保留工具配对和当前任务，只有生成摘要后的实际用量才能验证是否达到目标。

经济门槛仅用于低压力摘要，成本为摘要调用成本加上本次造成的增量缓存重建成本。同一批释放与摘要共用的重建只计算一次，已发生或本来就需要的重建不重复收费。缓存状态根据当前证据重新判断，历史 cache miss 不代表后续请求一直冷。所有成本均为 **HEURISTIC 估算权重**，不等于供应商实际账单。

`context_status` 按需返回当前阻断原因及下一步动作、固定请求开销与受保护尾部的下限、摘要输入的历史/system/tools/framing 拆分，以及回本所需的未来主请求次数。缺少窗口、无效窗口和模型配置读取失败分别报告；配置读取失败时仍可检查释放 backlog，取消会保持取消结果。

`paybackTurns` 默认 24，表示在未来 24 次主请求内估算回本，短任务可显式设为 8。`not_paid_back` 是对未来收益的预测，单纯多等几个步骤不会累计回本。固定输入或当前任务超过压力阈值时，状态会说明仅摘要旧历史无法达到目标。

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

测试使用 mock 模型、内存服务和新的临时会话目录，不调用真实模型，也不修改运行中的 profile。覆盖编号、摘要提交、失败与取消、原文与附件恢复、冷启动、fork、代码调度和提醒状态。

普通压力选区仅含 checkpoint、控制消息、释放管理通知、指令 baseline 或 MCP snapshot 时，会跳过摘要调用。真实业务内容与非 baseline 指令变化仍可触发。摘要投影按 source 元数据排除注入内容，并保留业务正文中出现的相同控制文字；普通历史来源 ID 设为 null，附件保留归档引用。

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
