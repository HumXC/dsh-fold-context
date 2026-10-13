# dsh-fold-context

压缩优先的 DSH 插件。模型通过稳定编号标记已经用完的工具结果；插件在步骤边界执行释放，并在摘要前移除已标记的工具正文，然后直接调用 DSH 官方摘要和提交实现。

目前为第一版 `0.1.0`，锁定 DSH `0.2.0-rc.2` 的公开契约。工程已创建在工作区，尚未安装到运行 profile。

## 模型可以做什么

| 工具 | 行为 |
| --- | --- |
| `context_release` | 传入当前会话的 `§N§` 工具结果编号和理由，标记工具正文可以释放。返回 queued、deferred、settled、unknown 和 unsupported；未知或不可释放编号会使整批拒绝。 |
| `context_compact` | 请求下一步骤边界执行官方历史摘要，不必等到压力阈值。请求排队，实际结果由 ledger 确认。 |
| `context_status` | 查看预留编号及 reserved/bound/abandoned/summarized 绑定状态，以及工具结果的短预览、保护、释放状态、摘要请求与最近摘要覆盖。可按编号查询省略项。 |

编号使用 Magic Context 风格的 `§1§、§2§…` 标记，其中数字是独立、会话内递增的分配序号，与事件 seq 无关。步骤准入时，在原输入末尾追加声明：例如普通输入绑定 `§1§`，下一条助手回复预留 `§2§`。声明实际提交到日志后才占号；预览、拒绝或准备请求前失败不会消耗编号。助手提交后绑定 `§2§`，同一生成步骤的重试沿用该编号。取消而没有可见输出时编号成为 abandoned，永不回收。

助手提交的 tool-call 列表按模型顺序预留后续工具结果编号，再按调用来源绑定实际结果。这覆盖并发、跳过和崩溃恢复，不依赖工具执行钩子。普通用户输入和助手回复也有编号，但第一版只允许释放工具结果；系统、runtime context、摘要 checkpoint 与编号声明不参与编号。控制工具结果有绑定记录，但不进入可释放目录。

编号声明通过公开 `agent/pre-step` 输入通道提交；编号与绑定由纯事件投影重放。历史正文不插入前缀、不重新编号，释放替换保持原编号。声明会增加少量输入，本插件没有实现缓存断点或调度，也没有验证实际缓存命中率。释放意图协议为 version 2。

事件提交与磁盘落盘有区别：组合中的官方 `session-checkpoint-policy` 在模型分发和顶层工具执行前等待 flush。只有该策略实际启用且 flush 成功，才能保证对应预留依据先落盘；本插件不会通过模型上下文预览偷偷写入日志。

状态为 `available → queued → released`；某个结果被正式摘要覆盖后成为 `summarized`。工具调用成功并返回 queued，只代表意图已进入日志，不能当作释放成功。

最近的工具结果默认保护 2 条，按当前 surface 顺序判断。模型仍可以标记它们，等窗口向前移动再释放。足够短、无法通过占位标记缩短的结果继续保持 queued，避免增加上下文。摘要是独立的历史替换操作，**会覆盖未标记的历史**，并保留官方选区算法决定的最新完整尾部；最近结果保护不是摘要的排除规则。

## 摘要如何复用官方实现

`ContextCompressionEngine` 继承 `BasicCompactionEngine`，只在 `summarize()` 中过滤已标记工具正文，并调用 `super.summarize()`。工具消息的角色、ID、callId 和协议外壳保留，防止孤立工具调用。

官方实现继续负责摘要提示词、模型选择、流式调用、usage/rawOutput、摘要必须缩短的验证、配对合法选区、并发稳定性检查，以及 `compaction/start → compaction/summary → surface replace → compaction/end` 的日志协议。压力和上下文溢出仍使用官方入口；主动摘要将排队意图交给官方入口选择历史前缀。`/compact` 使用相同的 compaction Service。

单条工具释放写入相邻的 `compaction/prune` 和 `tool/result` surface replacement，保留原事件数据，仅替换正文。原文仍在事件日志中。这使用 dsh-context 识别的官方协议；本次测试没有连接正在运行的 dsh-context Web 界面。

## 工程边界

- [domain](./src/domain/numbering.ts)：纯预分配、消息绑定、事件折叠与选择规则；不调用模型或存储记忆。
- [integration](./src/integration/engine.ts)：Cordis 服务、官方摘要继承、释放提交与模型工具注册。
- [memory](./src/memory/contracts.ts)：独立的可选适配契约，包含来源引用、幂等键与明确的记忆保存回执。
- [压缩测试](./test/compression.test.mjs)与[编号测试](./test/numbering.test.mjs)：每项使用独立 Cordis Context、内存 SessionStore、官方服务与模拟模型；编号测试直接经过公开准入 waterfall 和官方恢复事件生成器。

第一版仅发布记忆适配契约，尚未自动执行提炼或写入 Mnemon。压缩不依赖记忆服务。后续记忆适配器需要独立处理提炼策略、写入授权、幂等和失败，不能把压缩成功当作记忆保存成功。

详细设计见 [architecture](./docs/architecture.md)；已研究的 Magic Context 功能和后续边界见 [magic-context-research](./docs/magic-context-research.md)。

## 配置与接入

必须在实际 Agent preset 的 compaction 隔离组中，使用本插件替换 `compaction-basic`，保留 `command-compact`，移除同组的 `tool-result-pruner`。插件发现同 scope 已有 `toolResultPruner` 时会拒绝挂载，以免另一个策略自动截断模型尚未标记的内容。在 Host 根部安装一个同名服务不能覆盖隔离的 preset 服务。

[compaction-group.fragment.yml](./examples/compaction-group.fragment.yml) 是用于自定义 preset 的组片段，不是自动安装脚本，也不是完整 Agent preset。运行 profile 未改动；接入前须把包加入目标 profile，再在对应 preset 的插件列表中替换该组。

插件配置：

```yaml
compaction:
  auto: true
  thresholdRatio: 0.8
  retainRatio: 0.16
  headroomTokens: 65536
release:
  protectRecentResults: 2
  catalogLimit: 32
```

`compaction` 原样使用官方配置 schema。`auto: false` 关闭按压力自动摘要，显式编号释放和主动摘要请求仍在步骤边界执行。`catalogLimit` 的范围为 1–128；目录有省略计数，按 IDs 查询不会依赖目录的位置。

## 本地验证

在仓库根目录执行：

```bash
pnpm --filter dsh-fold-context typecheck
pnpm --filter dsh-fold-context test
```

测试不启动 Web、不打开已有会话、不使用磁盘会话后端、不调用真实模型或外部记忆服务、不改运行 profile。依赖安装与 TypeScript 构建仅发生在工作区。

第一版未实现：原文恢复工具、P1–P4 多层摘要、自动去重、缓存批次调度、图片/推理专门回收，以及实际 Mnemon 写入适配器。原文保留在日志中不等于已经提供模型可调用的恢复接口。
