# 架构与状态协议

## 目标和第一版边界

本插件负责预分配编号、模型释放意图、工具正文释放和摘要前过滤，摘要算法和持久替换事务继续复用官方 `BasicCompactionEngine`。记忆提炼由另一个可选适配服务负责；第一版尚未调用该服务。

预测性来自明确的身份、意图与结果：模型选择编号，插件验证与排队，实际提交后才改变状态。模型不能把工具返回的 queued 解释为已删除。官方摘要仍按自己的历史前缀策略选区；它会覆盖没有单独标记的历史，工具说明明确披露这一点。

## 分层

```text
模型工具 / PTC 子调用
        │ 结果携带版本化意图回执
        ▼
Session 事件日志 ──► sessionProjections 中的纯 ledger 折叠
                              │
                    编号目录、保护、待处理意图
                              ▼
                     ContextCompressionEngine
                         ├─ 工具正文释放：prune + surface replace
                         └─ 官方历史摘要：过滤正文 → super.summarize()
                              │
                              ▼
                  真正提交的官方事件再次驱动 ledger
                              │
                              ▼
                  有界 runtime context / context_status

未来的记忆适配：来源引用 + checkpoint → 独立提炼与保存回执
```

`src/domain` 不依赖 Cordis Service 生命周期。`src/integration` 负责官方服务、模型工具、步骤边界和日志提交。`src/memory` 不引用压缩引擎。

## 身份与事件折叠

身份使用独立 ordinal 生成 Magic Context 风格的 `§N§` 标记，从 1 开始，只增不减，不使用 seq 或数组位置取号。`numbering.ts` 记录 role、预留来源 reservationSeq、原始绑定 sourceSeq、当前 surface 位置 currentSeq、messageId、turn/step 和调用来源。seq 仅用于定位日志；重复 callId 必须结合 owning turn/step 与 callSeq 判断。surface 顺序由 Session 的节点数组确定，不能按 seq 数值排序。

主助手采用生成前声明：`allocation.ts` 在 `agent/pre-step` 中先 `await next()`，按返回的实际 accepted messages 计算普通输入的编号与下一助手编号，再末尾追加 source.kind=`fold-context-allocation`、form=`notice` 的 user-role 声明。保留原消息对象和 decision 的所有字段。声明不是 runtime snapshot，不会声称替代其他插件的上下文。空首步骤以及非空输入被其他中间件过滤为空的后续步骤保持空，不因声明制造额外模型调用；工具执行后原本无新输入的合法继续步骤仍可预留。

计划本身纯粹且不占号。只有核心提交普通输入及声明的 `user/message` 后，投影才绑定输入并预留助手。声明的 assistantId 必须与提交到该位置时的 nextNumber 一致；若其他准入中间件改变它之前的输入序列，显式报错而不绑定错误编号。声明不得被复制、改写或重排到其声明输入之前。

持久 `assistant/message` 按同 turn/step 绑定预留；`assistant/attempt` 不绑定，重试复用原预留。可见中断回复仍绑定；`step/end` 没有对应输出时将预留改为 abandoned。`turn/end`、`session/end-seed` 清理剩余孤立预留，号码永不复用。

助手提交时，纯投影从其中所有顶层 tool-call 块按模型顺序一次性预留工具结果编号，因此在任何工具执行前已有稳定分配。`tool/call` 记录 callSeq，`tool/result` 优先匹配其 sourceEventSeqs 的调用引用。官方恢复器为未开始调用生成的结果也能通过助手所属 turn/step 与 callId 绑定。PTC 内部分发没有独立模型结果，不另占编号。普通用户输入与助手也编号；系统、runtime context、摘要 checkpoint 和声明不编号。控制工具结果有预留与绑定，但不可释放。

导入的旧日志没有生成前声明，按持久事件顺序确定性建立历史编号，保留所有原文。这些历史助手条目的 declared=false，不能宣称当时模型已经知道其编号。释放替换保留同一编号并更新 currentSeq；完整摘要覆盖后编号成为 summarized。

工具的 `presentationMeta` 将经过验证的 version 2 意图写入真实 `tool/result` 元数据。ledger 只接收本插件版本、合法控制工具名对应的意图；普通工具输出中的类似文本不能触发释放。PTC 通过工具运行时的结构化 trace 传递控制回执；没有成为会话工具结果的子分发本身不会生成可释放编号。`§N§` 中的数字表示预分配序号，不再表示原始事件 seq；version 1 释放意图不会被解释成新版意图。

ledger 注册在 `sessionProjections` 中，以 JSON 状态检查点和纯事件折叠恢复。它不把异步 `session/event` 观察者当作修改事务，不修改发给模型的临时 request 副本。

## 释放提交

1. 工具入口检查编号和理由，去重。未知编号列为 unknown；已知但不是可释放工具结果的编号列为 unsupported；两种情况均整批拒绝。
2. 日志回执使 available 进入 queued。保护窗口中的编号同样可排队，但回执列为 deferred。
3. 步骤边界按当前 surface 检查保护和活跃摘要锁。已不在 surface 的节点不能被错误替换。
4. 生成保留身份和协议外壳的工具消息，只改变 content。若占位文本不能比原文更短，则继续 queued。
5. 同步追加相邻 `compaction/prune` 与单节点 `tool/result` replacement，附原始节点引用。
6. ledger 仅在真实 replacement 引用当前节点且正文精确匹配释放标记时，将其改为 released。

占位文本可见，原始事件留在日志里。此处提供的是保留原文的释放，没有对日志做物理删除，也尚未提供模型恢复工具。

## 摘要与恢复

官方摘要收到保留消息协议结构的输入：queued/released 工具正文替换为释放标记，其余输入保持不变。摘要预算、工具配对、表面稳定性、缩短验证、模型选择、输出记录和生命周期事件由官方实现处理。

`context_compact` 的意图在下一步骤边界使用官方强制选区路径，因此无需达到压力阈值。有足够的合法历史前缀才会提交；暂时没有选区时，请求保持 queued。主动摘要与压力摘要共用引擎。

真正的 checkpoint replacement 才把被覆盖的工具条目改为 summarized，并确认已完成的主动请求。摘要失败以官方 end 事件中的 error 确认，不虚报 applied。

中断后的 `session/end-seed` 是恢复或分叉边界。ledger 清除旧摘要锁，并将旧锁之前尚未确认的主动请求标记为 failed/interrupted，避免 auto:false 会话的释放队列冻结。独立编号也由完整日志重放恢复；孤立预留作废。投影 schema 当前 stateVersion 4。

## 模型目录的预算

编号绑定目录与可释放工具目录各默认返回最近 32 条，最高各 128 条；工具预览最多 100 个 Unicode 码点。两种目录各自记录省略计数。主动请求只显示最近 8 个；最近摘要覆盖的 IDs 同样服从 limit，包含 total/omitted。底层 ledger 保留完整身份和覆盖关系，`context_status(ids=[...])` 可以定位省略的用户/助手/工具绑定及最近摘要覆盖成员。

runtime context 的预览按引用数据描述，不应作为指令。自动保护按当前有效工具结果的表面位置判断，已释放条目不占保护窗口。

## 记忆适配契约

`ContextMemoryAdapter` 是独立 Cordis Service，键为 `contextMemoryAdapter`，公开 `extract(batch, signal?)`。来源 batch 包含版本、sessionId、sourceSeqs、checkpoint 和 idempotencyKey；回执为 stored、duplicate、skipped 或 failed，包含 memoryIds/reason。

未来接入需要在压缩提交之后建立独立任务：摘要成功不等于记忆写入成功，记忆失败也不能回滚或重新解释已提交的压缩。适配器必须遵守目标记忆插件的公开 API、权限和回执，不能直接编辑生成的记忆文件。第一版只定义这条边界。

## 接入与验证范围

Compaction Service 每个 Cordis scope 只能有一个实现。实际 preset 的隔离组需要替换官方 provider，并移除无编号决策的工具截断器；保留官方手动命令。插件拒绝同 scope 的 toolResultPruner。

事件提交并不等于磁盘落盘。官方 `session-checkpoint-policy` 在模型分发与顶层工具执行前 flush，只有它实际组成且 flush 成功时，才保证编号的持久来源先落盘。编号插件不在同步提示回调或事件观察者里追加日志；事件观察者内 append 重入本身被核心禁止。

隔离测试挂载真实插件、官方 TokenMeter、SessionProjectionRegistry、ToolRuntime、SystemPrompt 和 compaction invariants。SessionStore 仅在内存中，LLM 是模拟流。新增测试直接经过公开准入 waterfall，并使用官方 interruptedTurnClosers 验证 started/unstarted 工具恢复。测试覆盖编号、日志与状态协议；真实模型摘要质量、缓存命中率、磁盘 checkpoint 故障、运行 profile 生命周期及 dsh-context Web 展示尚未通过此测试验证。
