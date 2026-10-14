# dsh-fold-context

让 DSH 的长任务上下文压缩更可预测：模型标记已经用完的信息，插件选择合适时机生成摘要，并明确报告哪些内容被排除、哪些内容被摘要覆盖。需要时，可以重新找回原始文字、工具结果、图片和文件。

适合需要持续阅读文件、调用工具、反复调查和跨多轮推进的任务。压缩以 DSH 官方摘要事务为基础，记忆提炼采用独立适配接口。

> 当前版本为 `0.1.0`，支持 DSH `0.2.0-rc.2`。压缩、编号、恢复和调度已有隔离测试；真实模型的摘要质量、缓存命中和节费效果仍需实际评估。记忆适配接口已经提供，自动提炼与 Mnemon 集成尚未实现。

## 能做什么

- **明确的内容身份**：用户文字、助手文字、工具调用与结果、图片、文件分别有稳定编号。模型不用在正文中手工打印编号。
- **有回执的压缩**：标记成功表示已排队；只有摘要真正提交后，才报告实际排除和覆盖结果。
- **代码决定时机**：低压力下按间隔、预计缩短量和回本门槛批量处理，压力或溢出时优先保证任务能继续。
- **可恢复的原始证据**：按编号展开原文，或先搜索历史再恢复。图片会校验后重新传入，文件会校验后提供读取句柄。
- **轻量的状态通知**：日常只追加有界变化，完整目录通过工具按需查询。

## 安装与启用

### 1. 构建插件

需要 Node.js **24.11.0 或更高版本**、pnpm **11.15.0**，以及 DSH **0.2.0-rc.2**。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

如需分发安装包，可在构建后执行 `pnpm pack`；打包时也会自动构建。源码仓库保留锁文件，依赖目录和构建产物不进入 Git，安装包包含运行所需的 `lib/`。

### 2. 安装到目标 DSH profile

通过 DSH 的插件管理功能安装构建后的本地目录，或让 DSH 助手调用 `plugin_manager`，以插件目录的绝对路径作为 `install_bundle` 的 `target`。

安装包后，还需要配置实际使用的 Agent preset。单独在根层挂载插件，不能覆盖 preset 内已经隔离的压缩服务。

### 3. 替换 preset 的压缩组

将 preset 原来的 compaction 组替换为下面的组片段。保留其余 preset 配置。

```yaml
- id: compaction
  name: cordis:group
  group: true
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
```

这是插件列表中的组片段，不是完整 preset。不要在同一压缩 scope 同时启用 `compaction-basic` 或 `tool-result-pruner`。完整选项见[配置示例](./examples/compaction-group.fragment.yml)。

原文恢复需要 `sessionQuery` 服务；图片和文件恢复还需要可见的附件存储，文件句柄需要文件系统路径映射。持久恢复依赖 DSH 会话日志正常保留，以及官方 `session-checkpoint-policy` 成功落盘。

## 日常使用

启用后，模型会收到使用规则和编号声明。通常无需人工管理编号；你可以要求模型在阶段结束后标记已用完的证据，查看待处理内容，或恢复之前的结果。

| 工具 | 用途 |
| --- | --- |
| `context_release` | 标记未来摘要时可排除的内容；返回排队或已结算状态。 |
| `context_compact` | 请求在后续步骤边界生成摘要；低压力下可能等待调度条件。 |
| `context_status` | 查看编号、状态、摘要回执，以及当前计划或等待原因。 |
| `context_search` | 按原文片段、角色或工具名查找当前会话历史。 |
| `context_expand` | 根据编号分页恢复原文，或恢复已校验的图片、文件句柄。 |

例如，模型可以调用：

```json
{"ids": ["§T19§", "§I20§"], "reason": "调查已完成，结论已经保留"}
```

这是 `context_release` 的参数。编号必须来自当前会话，不能照搬示例编号。要找回证据，可以先用 `context_search` 搜索关键片段，再调用：

```json
{"id": "§T19§"}
```

这是 `context_expand` 的参数。恢复结果进入新的上下文，不撤销之前的压缩。文本结果较长时，根据返回的 `nextOffset` 继续读取。

如果你希望立即整理历史，可以使用官方 `/compact`。模型调用 `context_compact` 则会进入代码调度，不保证下一步就执行。

### 编号与状态

| 编号 | 对应内容 |
| --- | --- |
| `§U17§` | 一条用户消息的普通文字 |
| `§A18§` | 一条助手消息的普通文字 |
| `§T19§` | 一次工具调用及其完整结果 |
| `§I20§` | 一次图片出现 |
| `§F21§` | 一次文件出现 |

所有类型共享递增序号。同一图片或文件重复出现，也有各自的编号。U/A 标记只过滤普通文字；I/F 标记只过滤对应附件；T 标记过滤完整调用与结果。

条目的状态按以下含义解释：

- `available`：尚未标记，且未被摘要覆盖。
- `queued`：标记已接收，正在等待能够覆盖它的摘要。
- `released`：已在成功提交的摘要输入中排除。
- `summarized`：原始内容已被摘要覆盖，没有作为单独标记排除。

摘要失败或取消且未提交时，原历史和排队标记保留。查看 `context_status`，可以区分等待、协议保护、范围外标记和失败冷却。

## 什么时候压缩，压缩哪些内容

有四条触发路径：

1. **常规压力**：达到官方有效压力阈值时执行。
2. **实际溢出**：模型供应商报告上下文超限时走官方恢复。
3. **提前整理**：有排队标记或模型主动请求，并且满足代码的经济门槛时执行。
4. **用户 `/compact`**：绕过经济门槛，执行一次安全的手动摘要。

普通压力和提前整理都保留近期原文尾部，摘要覆盖较旧的**连续前缀**。开头的 system 消息保留，切点不会拆开工具调用与结果。溢出和 `/compact` 使用更激进的保留策略，但仍保留最新的安全尾部。

**标记决定选区中哪些内容不再送给摘要模型，不直接决定整个摘要范围。** 选区内未标记的内容仍会被摘要；范围外的标记继续排队。成功提交后，整个选区被摘要替换。

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
summary:
  reasoning: omit-from-summary
  images: auto
release:
  catalogLimit: 32
```

关键选项：

| 选项 | 含义 |
| --- | --- |
| `compaction.auto` | 关闭后停止普通压力和 backlog 自动处理；实际溢出恢复、模型显式请求和用户 `/compact` 仍可执行。 |
| `thresholdRatio` | 压力比例上限；输出预留与 headroom 可能让触发早于该比例。 |
| `retainRatio` | 保留近期原文尾部的预算比例，不是压缩后的目标大小。 |
| `scheduling.enabled` | 开启经济调度；关闭后，模型显式请求沿用旧的强制摘要行为。 |
| `scheduling.proactive` | 允许排队标记自动触发低压力摘要；关闭后仍可通过模型显式请求触发。 |
| `minIntervalSteps` | 距离上次摘要至少经过多少个已提交的 assistant 步骤。 |
| `minSavingsTokens` / `minSavingsRatio` | 最低预计净缩短量，以及相对当前总输入的最低比例。 |
| `paybackTurns` | 允许的估算回本周期。 |
| `summary.reasoning` | 默认只从摘要输入省略 reasoning；`preserve` 将其作为历史文字保留。 |
| `summary.images` | `auto` 仅向明确支持图片的摘要模型传原图；`references` 固定只传引用。 |
| `release.catalogLimit` | 按需目录大小，范围 1–128；日常通知最多附带 8 条变化。 |

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

测试使用 mock 模型、内存服务和新的临时会话目录，不调用真实模型，也不修改运行中的 profile。覆盖编号、摘要提交、失败与取消、原文与附件恢复、冷启动、fork、代码调度和增量通知。

工程细节见[架构说明](./docs/architecture.md)；参考设计见[Magic Context 对照](./docs/magic-context-research.md)。

## 许可证

[MIT](./LICENSE)。
