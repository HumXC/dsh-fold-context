# dsh-fold-context

[![CI and Release](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml/badge.svg)](https://github.com/HumXC/dsh-fold-context/actions/workflows/ci.yml)

让 DSH 的长任务上下文更容易管理：每会话使用稳定的纯数字 ID，模型可以标记已用完的工具结果和单个附件，代码在合适时机合批释放。较旧历史由 DSH 官方摘要事务整理，原始证据保存在会话归档中，支持搜索与恢复。

适合持续阅读文件、调用工具、反复调查和跨多轮推进的任务。模型负责判断证据是否仍有用；插件负责排队、缓存感知调度、压力检查和提交。

> 当前版本为 `0.3.2`，支持 DSH `0.2.0-rc.2`。提供纯数字 ID、独立控制消息、释放调度与摘要；普通控制意图使用 v8 回执，PTC 使用 v9 原生意图记录。真实模型摘要质量、供应商缓存与节费效果需要实际评估。记忆适配接口已经提供，自动提炼与 Mnemon 集成尚未实现。

## 能做什么

- **稳定的纯数字 ID**：消息、工具结果及每次附件出现共享会话内的递增序号，原始正文与助手签名、原生重放保持完整。
- **独立控制消息**：每次模型请求前追加一条 `user` 消息，列出上次分配、本次预留 ID，以及必要的附件映射与释放建议。
- **按后缀成本释放**：近期、低重建成本的工具正文或附件在下个安全边界及时释放；较早的昂贵条目等待覆盖摘要，重建机会或窗口压力可以提前处理。
- **去重提醒**：依据候选收益、窗口压力和状态变化提示检查；未变化的候选不会仅因时间经过反复提醒。
- **统一摘要调度**：先释放、重测，再结合目标窗口、相对缓存成本和窗口安全决定摘要时机，不使用固定回本请求数。
- **可恢复的原始证据**：按 ID 展开原文，或先搜索历史再恢复。图片校验后重新传入，文件校验后提供读取句柄。
- **原生 Web 展示**：五个常规工具使用 DSH 行风格和主题颜色，结果紧跟标题，悬停时左侧图标显示展开箭头，支持中英切换。
- **可核对的释放回执**：替换提交后显示本批 ID、释放原因、等待项目及预计 token 变化。展开区按原因分组，编号横排；选择某个编号可查看已有预览与来源。

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
            policy:
                compaction:
                    auto: true
                    cacheReadRatio: 0.1
      - id: command-compact
        name: "@deepseek-ai/dsh-command-compact"
      - id: tool-result-pruner
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner"
        config:
            thresholdChars: 8192
            headChars: 4096
            tailChars: 1024
```

这里，组的 `config` 是子插件列表；`fold-context` 行下的 `config.policy` 是本插件的基础策略。`policy.compaction.auto` 关闭时，只停止没有申请的常规主动摘要；排队申请、窗口安全恢复和独立释放仍然运行。

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

| 工具              | 用途                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `context_release` | 批量释放已用完的工具结果正文或单个附件；返回排队或已结算状态。     |
| `context_compact` | 请求在后续步骤边界生成摘要；低压力下可能等待调度条件。             |
| `context_status`  | 查看编号、等待原因、调度计划及 `summaryPreparation` 摘要准备状态。 |
| `context_search`  | 按原文片段、角色或工具名查找当前会话历史。                         |
| `context_expand`  | 根据编号分页恢复原文，或恢复已校验的图片、文件句柄。               |

日常使用上述五个工具。开启 **沿用会话生成摘要** 后，模型还会使用条件提交工具 `context_submit_summary`，提交准备指令中的 `checkpointId` 和完整摘要。该工具当前全局注册，但只有本会话存在对应待处理 checkpoint 时才接受提交；返回的验证排队回执不代表替换已经完成。

查询工具的可选参数可以省略或传 `null`，均使用默认行为。`context_search` 还将 `roles: []` 视为搜索全部角色，将 `tool: ""` 和 `cursor: ""` 分别视为不筛选工具和开始新搜索；`context_status` 的 `ids: []` 表示查看默认有界目录。各工具的 `limit` 必须在显式指定时满足范围，`0` 不表示缺省；`context_expand` 的 `offset` 缺省为 `0`。

`context_release` 的 `ids` 必须包含 1–128 个正安全整数，空数组或 `null` 均报错。`context_release` 与 `context_compact` 的 `reason` 必填，去除首尾空白后须为 1–1000 个字符。

例如，模型可以调用：

```json
{ "ids": [19, 20], "reason": "调查已完成，结论已经保留" }
```

这是 `context_release` 的参数。`reason` 保留在内部日志中，工具返回当前排队或结算状态。目标实际结算后，成功的直接 release 调用及其结果会在下一次模型请求前成对清理。包含业务文字、其他工具或未完成目标的调用继续保留。PTC 程序及其结果按普通业务调用保留，程序内的 `context_release` 仍可提交释放意图。

编号必须来自当前会话，不能照搬示例编号。要找回证据，可以先用 `context_search` 搜索关键片段，再调用：

```json
{ "id": 19 }
```

这是 `context_expand` 的参数。恢复结果进入新的上下文，不撤销之前的压缩。文本结果较长时，根据返回的 `nextOffset` 继续读取。

已释放条目的账本保存有原因时，恢复结果包含 `releaseReason`，Web 展开区在原文或附件上方显示“释放原因”。正文与附件均支持；附件优先使用自身原因，其次使用所属消息的原因。记录未保存原因时省略该字段。

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
Review try_release now; call context_release for consumed items after preserving needed facts.
```

`prev` 按进入请求的顺序列出本次新声明的消息 ID；通过 `next` 预声明的助手 ID 在绑定后不会重复列入 `prev`。`next` 给出本次请求预留的助手 ID。`attachments` 仅在有附件时出现，每行依次是附件 ID、所属消息 ID、附件序号（从 1 起）。`try_release` 仅在触发提醒时出现，列出建议检查的 ID，并附一句提示：及时检查候选，保留必要结论后标记已消费内容。候选列表不限制模型主动标记其他 ID，实际释放时机由 Host 调度。

插件依据 `source.kind = 'fold-context-allocation'` 识别控制消息。业务正文中的相同文字保持业务含义，原文不需要携带标签。助手的正文、reasoning、签名与 `replayState` 完整保留。独立摘要请求会从历史投影中排除控制消息；沿用会话生成摘要的回合保留原生历史，并要求摘要正文省略管理信息。控制消息的实际 token 计入压力。

消息 ID 可用于搜索和恢复；释放工具只接受工具结果正文与单个附件，用户和助手文字保持保留。条目状态如下：

- `available`：尚未标记，且未被摘要覆盖。
- `queued`：意图已接收，等待合批条件或覆盖摘要；受保护的助手附件等待覆盖摘要。
- `released`：正文或附件已实际替换，ID 保持不变。
- `summarized`：正文或释放占位已被摘要覆盖；覆盖范围内的逐条占位随之移除。

`context_status` 给出当前等待原因、调度计划和实际释放状态。

Web 消息流区分“标记释放”和“已释放上下文”。实际释放回执按标记原因分组，同组内按已释放与等待原因排列；每个原因只显示一次。编号横向排列，默认最多两行，可展开其余编号。选择某个释放编号可查看来源、已有预览和附件所属消息；完整原文通过 `context_expand` 读取。

## 什么时候提醒释放

候选需要仍可处理，并至少经历两个后续业务步骤。提醒依据候选总收益、相对于目标窗口的压力和失效后缀成本排序；每次最多列 5 个 ID，不附预览。工具仍允许模型一次标记最多 128 个 ID。

提醒只在候选显著增长、发生有效释放进展或进入更高压力档位时重新就绪，并使用有界退避。时间经过、候选 ID 更换或压力在同一档位附近振荡，都不会反复提示。纯管理调用不推动业务年龄。提醒仅建议模型检查，不授权释放。摘要准备通知则来自已经放行的调度计划，不要求模型再申请一次。

## 什么时候释放与生成摘要

`context_release` 先记录 `queued` 意图。规划器逐项计算删除收益及从改写点起失效的缓存后缀；稳定前缀不计重建成本。独立释放批次只选择正净收益条目，零收益或会增加输入的替换继续排队，其原文仍计入后缀成本。近期、低成本条目可在下一安全边界结算，较早的高成本条目通常等待覆盖摘要，不能拖住整批。

处理顺序是：**测量 → 可获准的 release → 重测 → 决定摘要**。已放行摘要覆盖的标记直接随完整选区结算，不在摘要前再单独改写一次。独立重建机会、可信缓存 TTL 到期或窗口压力可以提前处理；TTL 默认关闭，历史 cache miss 不代表未来持续冷缓存。

常规摘要同时考虑目标窗口、单位工作成本和安全余量。缓存越贵，允许延后的窗口越小；缓存越便宜，越倾向延后合批。到达安全边界或供应商实际报告 overflow 时进入恢复。用户 `/compact` 保留手动维护入口；模型工具没有 `immediate` 模式，显式申请仍交给同一调度器。

普通压力和提前整理保留近期原文尾部，摘要覆盖较旧的**连续前缀**。开头的 system 消息保留，切点保持工具调用与结果配对。对同一 provider/model 的原生 assistant 回放，选区成本参考 output usage；最新主请求的 input usage 校准总压力。规划不按加密签名长度估算，也不把历次完整 input usage 相加。溢出和 `/compact` 使用更激进的保留策略，切点仍须合法，摘要仍须保留当前任务。沿用会话时，准备回合新增的尾部不参与本次替换。

摘要提交后先记录预计降幅，再等待后续主请求 input usage 验证；独立摘要请求的 usage 不参与验证。`context_status` 的 `scheduling.pressure` 区分等待验证、低于阈值和仍高于阈值。实际未改善时逐步缩小保留预算；主请求确认仍超阈值时，可采用最大合法历史前缀。同次处理遵守官方重试上限，无预计改善或选区只剩旧 checkpoint/管理快照时停止。受保护尾部或固定输入超过预算时，生成 checkpoint 本身不能证明已满足目标。

关闭 `policy.compaction.auto` 不会停用独立释放、已排队的摘要申请或窗口安全恢复。释放或裁剪解除安全压力后，摘要重新遵守常规开关与成本规划；低于目标窗口时可直接继续任务。覆盖范围以外的标记继续排队。

摘要可以通过独立请求生成，也可以显式选择沿用当前会话 Agent。独立请求使用历史数据投影，按来源剔除控制消息、release 清理通知与内部状态，并过滤选区内可安全排除的释放内容；`summary.reasoning` 与 `summary.images` 控制这条路径的输入。沿用会话时，模型看到完整的当前请求及原生历史，不应用这些投影过滤；最终只替换准备阶段冻结的原始范围，辅助回合产生的新尾部保留原样。

成本估算与摘要准备共用执行条件检查。只有会话驱动、模型准备和容量检查通过，才按完整当前输入与准备指令估算会话摘要，并对可验证的稳定前缀采用缓存折扣；独立回退按历史投影计价，不继承主会话缓存折扣。`context_status.scheduling.summaryInput.execution` 标明估算采用的 `session` 或 `independent` 路径。状态查询只做检查，实际执行前再次验证条件。

## 配置

fold 自行声明配置和默认值，继续使用官方引擎的锁、选区和提交事务。在 **插件 → fold-context → 配置** 中，可以配置摘要模型和全部运行策略。供应商、模型和思考强度选项来自 DSH 已配置的模型目录。

运行策略按组折叠展示，每项都有说明和范围校验：

| 配置组       | 可调整内容                                                                             |
| ------------ | -------------------------------------------------------------------------------------- |
| 窗口与缓存   | 自动摘要、目标 token 数、缓存读价比、摘要输出上限；目标和缓存比可以按供应商/模型覆盖。 |
| 相对成本     | 摘要输入、输出相对权重，以及可选缓存 TTL。                                             |
| 摘要内容     | 历史思考文字、图片或图片引用。                                                         |
| 释放候选提醒 | 是否提示检查候选。                                                                     |

共 4 组、10 个字段。每个字段独立继承 Agent 预设，省略表示继承；`false`、`0` 和显式空模型策略列表保留其含义。模型策略只填写目标或缓存比，供应商/模型组合必须唯一。保存的策略在下一个安全边界刷新；活跃摘要事务或准备计划保持已有快照。

每个摘要模型项有三个选项，前两个可以组合，第三个与前两个互斥：

- **匹配会话时优先**（`preferWhenSessionMatches`，默认 `true`）：供应商与模型 ID 都匹配当前会话时，该项稳定提前，其余项保持列表顺序；关闭后按列表原顺序尝试。
- **沿用会话生成摘要**（`useSessionAgent`，默认 `false`）：仅当排序后的首个候选显式开启，且供应商与模型 ID 都与当前会话精确匹配时，才尝试由主 Agent 准备摘要。无法准备时允许该项通过独立请求摘要。
- **仅为同模型会话生成摘要**（`onlyWhenSessionMatches`，默认 `false`）：供应商和模型 ID 都匹配时才参与候选，并与“匹配会话时优先”的匹配项一起按列表顺序稳定提前；该项只能沿用会话 Agent，禁止降级为独立请求。不匹配时完全跳过，包括失败回退。

开启第三项会自动关闭并禁用前两个选项，关闭后不恢复原值。后端拒绝第三项与任一旧选项同时为 `true` 的配置。手写配置仅指定 `onlyWhenSessionMatches: true` 时，另外两个选项默认关闭；旧配置仍保持原默认值。思考强度不参与供应商和模型的匹配。

列表为空时，使用当前会话的供应商和模型发起独立摘要请求；这不会隐式启用沿用会话。非空列表过滤后没有匹配项时，调度报告“会话模型不匹配摘要配置”，不会隐式添加当前模型。“仅为同模型会话生成摘要”无法沿用会话且没有其他可独立执行的候选时，调度保持等待并报告原因；手动压缩或安全恢复也不绕过该限制。可在列表中添加普通摘要项作为回退。

思考强度选择“自动”时使用摘要模型的供应商默认值，显式选择则用于该项摘要请求。模型不可用、供应商失败、输入窗口不足、输出为空或被截断时继续尝试允许独立执行的候选；取消和事务错误停止。

页面将摘要模型和运行策略一起保存到 profile 根条目 `fold-context-ui` 的 `summaryModels` 与 `policyOverrides`，保存带修订号且整次提交；冲突时保留草稿。没有根条目时使用引擎自身配置。以下模型 ID 请换成 DSH 目录中的实际值：

```yaml
uiOnly: true
summaryModels:
    - provider: deepseek
      model: deepseek-chat
      preferWhenSessionMatches: true
      useSessionAgent: false # 默认关闭；需要沿用会话生成摘要时改为 true
    - provider: openai
      model: gpt-example
      reasoningEffort: high
      onlyWhenSessionMatches: true # 仅在当前会话为 openai/gpt-example 时沿用 Agent
      preferWhenSessionMatches: false
      useSessionAgent: false
policyOverrides:
    compaction:
        cacheReadRatio: 0.1
    reminders:
        enabled: true
```

### 摘要如何执行

默认使用普通独立辅助请求：携带投影后的历史、官方提供的 system、工具定义和摘要指令，标记 `purpose: compaction`，不携带主会话 `sessionId`。独立请求及其中间输出不作为主 Agent 对话轮次写入主消息流，成功摘要由官方事务提交。

开启 **沿用会话生成摘要** 或 **仅为同模型会话生成摘要** 且该项成为首个匹配候选后，插件先冻结原始连续合法选区及对应的消息编号、附件身份和已有 checkpoint，再在官方压缩事务之外向主 Agent 提供内部准备指令。主 Agent 沿用正常工具循环，可以使用已有工具，并通过 `context_submit_summary` 提交摘要。下一安全边界重新验证原选区后，才通过官方 `compactRegion` 提交；准备回合新增的消息和工具结果位于保留尾部，不会被扩入原选区。

准备前会估算整个主请求、准备指令和输出预算能否装入当前窗口。窗口未知、预算不满足、实际溢出、有限提醒与步骤限制内未提交或主会话模型失败时，转向允许独立执行的候选；“仅为同模型会话生成摘要”项在此路径被跳过。已注册的模型重试与溢出恢复处理器保持优先。选区或路由变化、取消和事务错误会中止相应计划。

沿用会话的请求保留原生 replay、历史 reasoning 和图片；`summary.reasoning`、`summary.images` 的输入过滤只用于独立请求。维护期间可临时使用摘要项的思考强度与输出预算，结束后在合法请求边界恢复原始 `maxTokens` 和思考强度；原本由适配器自动决定的值也恢复为自动管理。若 Agent 已关闭，恢复意图随计划保留，在重开后的首个请求前完成恢复。

官方摘要提交成功后，插件在后续模型请求前清理该 checkpoint 的准备指令、提醒，以及完整的纯 `context_submit_summary` 调用与回执；已由官方摘要结算的纯 `context_compact` 调用组也可成对清理。清理使用持久的原生上下文替换，正式 checkpoint 的提示和摘要继续保留，提交参数中的摘要不会随纯提交调用反复进入后续请求。自动续跑的当前步骤保留一句通用的“继续用户任务”触发提示，后续请求前再清理它。

清理不改写原始会话日志：Chat 与 Trajectory 仍可查看原始工具参数和结果，重开会话与 fork 沿用清理后的模型上下文。含非空正文、业务工具、PTC 程序或中间夹杂业务消息的调用组保留；准备期间新增的业务工具结果也继续保留。回执须匹配工具原生渲染的规范成功 JSON；含附加说明、附件、未知字段、重复键或不匹配元数据的结果保留整组。失败、取消或仅收到待验证回执，都不足以清理未成功提交的准备过程。

`context_status.summaryPreparation` 提供 checkpoint、阶段、步骤计数、范围内消息和附件数量、关联事务及原因等状态。供应商缓存命中与实际节费效果需实测。

基础策略放在 Agent preset 引擎的 `config.policy` 中。以下是完整字段示例；通常保留自动目标，只按实际缓存定价调整缓存比：

```yaml
policy:
    compaction:
        auto: true
        # targetTokens: 170000 # 示例绝对值，不是默认值
        cacheReadRatio: 0.1
        summaryMaxTokens: 8192
        modelPolicies: [] # 可填写 provider/model/targetTokens/cacheReadRatio
    scheduling:
        summaryInputRatio: 1
        summaryOutputRatio: 1
        cacheTtlMs: 0
    summary:
        reasoning: omit-from-summary
        images: auto
    reminders:
        enabled: true
```

`cacheReadRatio` 是缓存输入单价除以未缓存输入单价，范围为 0–1，不需要填写货币价格。摘要输入、输出权重同样按主请求未缓存输入单价归一化。TTL 只有可信的同路由缓存命中及经过时间才构成到期证据；未知供应商 TTL 时保持 0。

自动目标初值约为模型窗口的三分之二。安全预算为准备输出和增长保留余量，模型专属绝对目标若超出安全预算会被限制，并在状态中显示有效值。目标是调度偏好，不是每次摘要后保证达到的大小。少于 4 tokens、未知或无效的窗口不能构造可靠预算。主请求输出上限仍由模型适配器管理。

成本模型比较不同启动窗口下每单位新增工作量的预计总成本，包含辅助摘要、缓存读取和真正失效的后缀。增长估计有观测时使用历史样本，冷启动使用保守默认；输出预测受摘要上限约束。所有成本是 **HEURISTIC 估算**，不代表实际费用或未来缓存命中。固定输入、当前任务或受保护尾部过大时，摘要也可能无法满足目标。

`context_status` 报告目标与安全窗口、建议启动位置、当前/最佳单位成本、冷启动或观测增长置信状态，以及摘要输入拆分、等待原因和效果验证。只有后续主请求 usage 能验证压缩效果。`summaryPreparation` 单独报告两阶段摘要的准备状态。

**这是不兼容旧配置的重构。** 旧根字段、组级 `enabled/values` 包装、回本次数、释放最长等待和旧保留比例等字段直接报错，不进行迁移。更新前请按照新结构重新声明策略；本变更不清理历史会话、归档或编号。

## 图片、文件与恢复边界

- 图片恢复会校验原始存储内容；当前对话模型明确支持图片时，才返回原生图片。
- 文件恢复会读取并校验完整内容，然后返回可读取的文件句柄；这不表示模型已经读过文件正文。
- 独立摘要的目标模型不支持图片或能力未知时，保留图片引用和相邻文字，不自动生成 OCR 或视觉描述；沿用会话的摘要回合保留原生图片。
- 缺少服务、存储丢失或损坏、模型能力不足、路径无法映射时，会返回明确状态或错误。
- 历史搜索是字面子串搜索，不提供语义图像检索或附件二进制全文检索。

## 长期记忆

本插件管理会话上下文、摘要与原文恢复。长期记忆的提炼和存储由独立插件负责，安装本插件不会自动创建长期记忆。

## 开发与验证

在本仓库内执行：

```bash
pnpm typecheck
pnpm test
pnpm format:check
```

`pnpm test` 将代码构建到新的临时目录并在那里运行全套测试，不覆盖已安装包共享的 `lib`。只运行某个文件可用 `pnpm test -- attachment-loop.test.mjs`。`pnpm build` 和打包应在独立构建副本中执行；稳定安装包保存在 `~/.dsh/plugin-packages` 等持久目录，通过 DSH 插件管理安装，运行实例与开发目录保持隔离。

测试使用 mock 模型、内存服务和新的临时会话目录，不调用真实模型，也不修改运行中的 profile。覆盖编号、摘要提交、失败与取消、原文与附件恢复、冷启动、fork、代码调度和提醒状态。

普通压力选区仅含 checkpoint、控制消息、释放管理通知、指令 baseline 或 MCP snapshot 时，会跳过摘要调用。真实业务内容与非 baseline 指令变化仍可触发。独立摘要投影按 source 元数据排除注入内容，并保留业务正文中出现的相同控制文字；普通历史来源 ID 设为 null，附件保留归档引用。沿用会话的回合使用原生历史，编号清单用于约束待替换范围。

工程细节见[架构说明](./docs/architecture.md)；参考设计见[Magic Context 对照](./docs/magic-context-research.md)。

## GitHub CI 与发布

GitHub Actions 使用 Node.js 24，并读取 `packageManager` 中锁定的 pnpm 版本：

- 推送 `main`、向 `main` 提交 PR 或手动运行工作流时，检查格式和类型，构建 Host 与 Client，运行全套测试并打包。
- 每次成功构建保留 14 天的 Actions artifact，包含 `dsh-fold-context.tgz` 和 `SHA256SUMS`。
- 推送 `v*` 标签时，先校验标签与 `package.json` 的版本一致，再执行相同检查。通过后自动创建 GitHub Release，上传安装包和校验文件；带 `-` 的版本标记为 prerelease。

发布前先提交版本与代码，再推送对应标签。例如当前包版本为 `0.3.2` 时：

```bash
git tag v0.3.2
git push origin v0.3.2
```

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需额外配置发布凭据。发布后的安装包可从 [GitHub Releases](https://github.com/HumXC/dsh-fold-context/releases) 下载；将安装包和 `SHA256SUMS` 放在同一目录后，执行 `sha256sum --check SHA256SUMS` 校验，再通过 DSH 插件管理安装。

## 许可证

[MIT](./LICENSE)。
