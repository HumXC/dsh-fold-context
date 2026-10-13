# Magic Context 功能研究与采用边界

研究对象是本地保存的 CortexKit Magic Context `v0.40.1`，固定提交 `a239835e161efc730f0da8472786fe372626e66b`。这些结论描述该快照，不保证当前上游版本相同。更早的完整研究已另存项目 Documents；本页记录与新插件相关的功能索引。

本插件采用“稳定身份 → 模型标记 → 延后提交 → 真实回执”的思路。不会照搬 Magic Context 的记忆系统，也不假定其全部自动回收机制都由模型选择。

| 功能 | 研究结论 | 本插件第一版 |
| --- | --- | --- |
| 稳定编号 | 工具内容有身份，模型选择身份，不依赖当前数组位置。 | 使用 Magic Context 风格的 `§N§` 标记和独立的会话内序号；助手生成前声明，工具结果按调用顺序预留，替换后身份保留。 |
| 显式 reduce | 模型标记，插件执行；标记不代表立刻丢弃，受最近窗口和执行策略影响。 | context_release 明确区分 queued、deferred 与真实 released。 |
| 自动回收 | 存在压力/水位驱动回收，不是所有丢弃都有单独模型编号选择。 | 不引入额外盲目工具截断；仍保留明确披露选区的官方摘要。 |
| Historian 分层摘要 | 对旧原文按工作目标分段，预生成 P1–P4，另提炼 facts/events/user observations/primer。 | 暂不实现；直接复用官方单层摘要。 |
| Decay 渲染 | 根据年龄、重要性和预算选择已有摘要层，P5 为省略归档；不是每次递归重新摘要。 | 后续候选。层级切换需独立回执和恢复策略。 |
| 去重与清理 | 对安全读/搜/诊断结果做精确去重，清理重复注入，并有紧急路径。 | 暂不实现。 |
| smart drops | 默认关闭；可清理旧 todo、旧 reduce 和低价值元信息，受缓存策略和保留规则约束。 | 暂不实现。 |
| caveman 文本缩减 | 默认关闭；确定性但有损，按年龄用不同强度，基于 pristine 原文并持久化深度。 | 暂不实现。 |
| reasoning / 图片回收 | 可清理旧推理和已处理图片，有供应商协议与缓存批次保护。 | 暂不实现。富媒体只随明确工具正文释放或官方摘要选区处理。 |
| wrapup / recomp / flush | 用户命令分别整理历史、重建分层资料、强制应用 pending 操作。 | 保留官方 /compact；context_compact 是模型可排队的主动摘要入口。 |
| search / expand | 查找和恢复存储原文；不同文档描述存在差异，不能泛化为任何原文都保证可恢复。 | 仅保留原事件日志，尚未提供模型恢复工具。 |
| 事实进入记忆 | 事实提升与会话摘要是不同产物。 | 独立 ContextMemoryAdapter 契约；未接入 Mnemon 写入。 |

## 关键源码索引

以下路径均相对旧插件 vendor 的 `packages/plugin/src`：

- `features/magic-context/tagger.ts`：工具身份绑定。
- `tools/ctx-reduce/constants.ts`、`hooks/magic-context/apply-operations.ts`：标记、保护和真实丢弃。
- `hooks/magic-context/historian-prompt.source.md`：工作目标分段、多层摘要和独立事实提炼。
- `hooks/magic-context/decay-render.ts`：年龄、重要性和预算驱动的层级选择。
- `hooks/magic-context/heuristic-cleanup.ts`：精确去重、注入清理和紧急策略。
- `config/schema/magic-context.ts`、`hooks/magic-context/caveman-cleanup.ts`：可选清理与确定性缩减。
- `hooks/magic-context/strip-content.ts`：旧推理和图片回收的协议保护。
- `features/builtin-commands/commands.ts`：用户命令，与模型工具入口分离。

这些是参考实现的职责索引，不是新插件的运行依赖。后续功能应继续保持来源身份、已提交状态、恢复能力和记忆写入回执相互独立。
