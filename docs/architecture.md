# 架构与状态协议

## 目标与层次

模型选择稳定编号，插件记录释放意图，在安全步骤边界独立替换工具结果正文或单次附件。官方 compaction engine 另行生成摘要并替换平衡历史选区。用户文字、助手原记录与签名不原位改写，不引入 DSH 核心补丁；官方 tool-result-pruner 可共存，记忆提炼仍是独立适配契约。

```text
模型工具 / PTC trace → 版本化意图 → Session 日志 → 纯 ledger
                                      │             │
                                      │             ├─ 安全步骤边界 → prune + 同身份替换 → R 占位
                                      │             ├─ 业务步计数 + 提醒状态 → 既有准入通知
                                      │             └─ 官方摘要选区 → 过滤 / fresh evidence → checkpoint
                                      └─ sessionQuery → 原文搜索与附件恢复

可选记忆：来源引用 + checkpoint → 独立提炼与保存回执
```

`domain` 处理编号、纯选择、日志折叠和有界目录。`integration` 注册 Cordis 服务与模型工具，继承官方引擎。`memory` 不引用压缩引擎，也不把摘要成功解释为记忆保存成功。

## 稳定身份与预分配

`§U17§`、`§A18§`、`§T19§`、`§I20§`、`§F21§` 共用正整数 ordinal；seq 定位日志。U/A 是对话检索身份，新的释放请求只接受 T/I/F。原位 T 仅替换结果正文，I/F 仅替换单次附件；相同引用重复出现分别编号。`R` 是当前占位的显示后缀，输入时归一到原 ID，不生成新身份。摘要覆盖后移除逐项占位；旧版通过摘要排除的条目不生成 R。surface 顺序由节点数组决定，不能按 seq 大小推断。

[allocation.ts](../src/integration/allocation.ts) 在 `agent/pre-step` 先 `await next()`，按实际 accepted messages 追加一次 user-role notice。它在后续中间件与官方压缩完成后读取 ledger，因此第一条摘要后请求能收到新的提交回执。保留原消息对象和 decision 字段，不把声明当 runtime snapshot。空首步骤与被过滤为空的输入保持空，合法工具继续步骤仍能预留。

预览纯粹。只有声明被提交后才绑定输入并预留 A；同 turn/step 的 assistant/message 绑定它，assistant/attempt 不绑定。重试沿用预留，可见中断仍绑定。step/end、turn/end 或 session/end-seed 使未绑定编号 abandoned，永不复用。

助手提交时，从 tool-call 块按模型顺序预留 T。在任何工具执行前已有编号；tool/call 记录 callSeq，tool/result 通过来源引用及 owning assistant/turn/step 绑定。重复 callId 不串号，结果不占第二个编号。PTC 内部分发不另占模型消息编号。控制工具仍有调用绑定，但不进入释放及恢复证据集合。

普通 slot 保存当前块类型、调用身份、reasoning 字符数和 replayState 标记；attachment slot 保存 ownerId、原始 sourceSeq/blockIndex、完整 ContentBlock，以及当前 seq/blockIndex。原始引用永不因 offload 或摘要变动。日志 image/offload 的 imageIndexes 是图片序号而非 content 下标，单独折叠到当前 summaryShape.offloaded；因此原图仍可恢复。

准入 version 3 先接纳实际输入及其附件，再预留 A。旧 version 1/2 重放不分配新 I/F，维持已有 ordinal；首次新声明才启用附件协议并接纳存量出现。助手及工具的新附件在消息提交时绑定，控制工具结果和附件恢复 notice 不重新建立证据编号。单节点同身份替换匹配完整引用、按出现顺序保留已有附件身份；新出现立刻建立条目，移除或 checkpoint 后保持 settled 状态，不能晚到地复活 available。

新的释放意图为 version 6，`releaseMode: inline`；旧 version 2/3/4 保持 `summary` 模式。projection stateVersion 为 13，新增业务步、释放进展和提醒状态。调度启用的新摘要请求使用 version 5、标记 retryable；禁用时保留 version 4。旧 failed 请求不会因升级自动重试。原位替换沿用公开 `compaction/prune` 与 `surfaceOp: replace`，原始事件继续保留，不需要核心补丁。

## 动态提醒

`domain/reminder.ts` 是确定性的纯计划器：候选默认至少放置两个后续业务步；积累 16000 token、4000 token 停留 8 步，或输入达到官方有效阈值的 80% 且有 4000 token 候选时提醒。8000-token 大项只影响排序。普通间隔 6 步、压力间隔 4 步；连续忽略退避到 12/24 步，新的有效释放进展或 8000-token 积累增长可解除退避，但不绕过最小间隔。无候选、关闭提醒或正在摘要时不发送。

业务时钟只在已提交业务回复的 step/end 推进。纯管理调用即使附带解释文字也不推进，混合业务调用只计一步。候选计量使用当前 surface 的工具结果，pruner 产生的可见缩短立即反映，queued/released 不再计入。压力沿用官方容量、输出预留、headroom 和精确模型覆盖；容量未知或无效时不触发压力提醒。

allocation 在既有准入 notice 追加最多 5 条候选，预览截短为 80 字符；不增加模型请求。计划预览不写状态，只有被接纳的 `source.releaseReminderState` 才进入纯投影，因此拒绝、取消和未提交预览不会消耗冷却。提醒状态与候选年龄随日志冷重放和 fork 保留。

## 排队、原位替换与摘要配对

context_release 归一 R 别名、去重并验证整批编号；unknown 或 unsupported 使整批拒绝。只有意图真正进入日志才从 available 变为 queued。`commitInlineReleases` 在官方压力/调度路径前批量处理，auto 和 scheduling 均关闭时仍可生效，摘要锁存在时等待。每次同步先规划再追加 prune/replace；替换保留消息 ID、工具调用 ID 与来源引用，完成后 flush。个别附件用编号占位替换当前原生块，其他内容保持；编号重绑跳过已标记出现，防止相同附件的兄弟条目串号。

助手原记录保持完整，助手附件或已 offload 的受保护出现等待覆盖摘要。`released` 只表示真实替换或真实摘要排除；R 占位指向当前 marker 节点，后续摘要覆盖能移除它。原位释放之后的 context_expand 是新证据，不撤销替换。

成功控制回执在已有改写内清理：只删除目标全部结算、无签名且没有普通文字/其他工具的完整 release 调用与结果组，保留最近两组。清理不另发起改写，也不把最早变化点移到本次原位目标之前；受保护或更早的旧组可以继续保留。失败/拒绝和原始日志不删，替换通知不创建新的业务编号。

官方引擎选择原始平衡连续范围。`summarize()` 取得该范围及官方可能保留的头部 system 输入，用 `projectSummaryInput(state, input.messages, startSeq, summaryPolicy)` 新建历史数据请求，再交给 `super.summarize()`。保留原有最前面的 system；后续历史各块编码为包含 id、role、blockIndex、type 的 JSON 记录，明确它们是证据而非新指令。

文本和工具参数作为历史数据；原生 assistant/tool 消息、replayState、签名和 usage 不转发。投影先省略本插件的编号/释放管理通知，再进行身份检查；U/A/T 来源编号不交给摘要模型，普通记录使用 id:null。附件保留 I/F 归档引用但不携带 ownerId；完整身份与覆盖关系继续留在 ledger/projection 回执中。摘要指令明确区分来源标签和任务内容，禁止复制或编造来源前缀，业务文本/代码中真正讨论的编号字符串保持原样。旧 checkpoint 正文不以正则全局删号，避免损坏业务内容。工具结果保留 callId、isError，空结果或附件全被标记后仍保留 outcome 记录。未知块和含糊身份显式失败。

普通压力尝试按实际 surface 切片检查业务证据：旧 checkpoint、编号/释放通知和纯状态/释放控制调用不构成新证据。agent-instructions baseline 与 MCP snapshot 使用每类最近的内容/identity 指纹识别重复注入；相同快照不构成证据，实际内容或 workspace identity 变化仍构成证据，首个带真实 changes 的 baseline 也不会被一概排除。指纹随 projection 重放和缓存恢复，不保存额外正文。这些 baseline 仍保留在主请求中，覆盖真实业务的摘要也可读取它们；只改变自动摘要触发判断。没有业务证据时，在 compaction/start 和辅助请求之前停止。显式 checkpoint 请求的首个提交、手动 compactNow 和真实 context-overflow 路径保留兜底。

`domain/pressure.ts` 注册独立、可重放的 `contextCompressionPressure` 投影，只存当前 surface 的轻量成本与最近主请求采样，不存签名正文。同一路由的原生回放成本取可见估算与该回复 outputTokens 的较大值；它是保守选区估计，不是精确的回放计费。主请求锚点使用 input + cacheRead + cacheWrite，不把各回复完整 input 相加，不按 encrypted signature 长度计算。模型路由改变后，旧路由回放成本与输入锚点不再用于校准。选区保留路由图片定价和官方工具配对检查，提交继续调用官方 compactRegion，`shadowedTokenCount` 继续由 SDK 的原始估算产生。

原生回放额外成本的扣减锚点独立跟随 SDK 已提交的 assistant/message，assistant/attempt 只更新主请求校准与效果，不能复活已移除的回放成本。规划同时受当前有效 surface 成本下限约束，不修改 DSH 的原生 contextPressure 或其 footer。摘要后记录 before/after 估计并等待下一次主请求 usage；compaction 的辅助 usage 不参与。观察值扣除摘要后新增内容的估算变化，独立报告实际主请求输入是否低于当前阈值。未观察到改善时逐步降低保留预算；确认主请求仍超阈值时，下一轮采用最大合法前缀，保留当前新用户任务、最新业务尾部与完整工具配对。同次压力处理每次有预计改善才继续，最多 compactionRetries + 1 次；业务证据检查阻止 checkpoint 自循环，模型切换立即将旧 effect 标为 route_changed。

允许排除的条目必须同时满足：queued、queuedAt 严格小于 compaction/start.seq、当前节点属于选区、消息身份及调用配对仍成立。范围外或摘要开始后的标记不进入本次过滤。

旧 U/A 排除意图只作用于普通 text，不控制相邻附件或 tool-call；新请求不接受 U/A。尚未原位处理而进入摘要的 T 要求调用和结果均在选区、callId 唯一，才从临时历史输入同时排除。I/F 只过滤当前绑定的出现；范围外和受保护条目继续等待。已原位移除的内容不伪造成新的摘要排除回执。

`summary.reasoning` 为 `preserve` 或默认 `omit-from-summary`。preserve 将助手 reasoning 按原文字节编码为普通历史记录，omit 仅在新摘要请求中省略并独立记录原始编号、sourceSeq/currentSeq、blockIndex 和 Unicode 码点数。原文和签名仍保留在日志。签名历史不作为原生回复转发，因此 transcript 模式不需要旧 native 模式的 replayState／仅剩 reasoning 保护；旧摘要重放仍使用旧规则。

`summary.images: auto` 解析与官方相同的实际摘要路由：会话 header 或 agent options → 精确 modelPolicies override → summary provider/model 默认值 → 会话路由。仅明确声明 image inputModalities 才传原生 ImageBlock；能力未知、文本模型、references 配置或 logged offload 均保留引用证据。FileBlock 由 DSH 转成确定性文件句柄，不代表模型读取了文件内容。

官方继续负责 tools、摘要指令、路由、stream、usage/rawOutput、取消、选区平衡、稳定性及缩短验证。summary 增加事务关联的 `[fold-context-projection:2 …]` 标记，保存 reasoning 与已选定 native/references 图像策略；version 1 历史标记仍沿用旧规则。标记计入缩短验证，不绕过官方提交。

## 真实提交与可重放回执

ledger 与临时请求共用 selectedExclusions，模式和 reasoning 策略来自持久标记，不能根据当前配置重新解释历史。

1. compaction/start 保存 compactionId 和授权截止 seq。
2. 匹配的 compaction/summary 验证首块策略标记；当前协议按 transcript 计算 excludedIds 和独立 projection 回执；无标记的历史摘要按旧 native 规则重放。无效标记或事务身份不符不能伪造处理回执。此时仍不结算 released。
3. 立即相邻的 user/message checkpoint 必须匹配 compactionId，引用该 summary，实际移除的 surface 位置切片必须逐项等于 shadowedSeqs。
4. 只有这个真实提交才将 pending excludedIds 设为 released，其他覆盖条目设为 summarized；范围外条目保持 queued。
5. 最后 end 清理 pending 事务。session/end-seed 清理中断锁，旧主动摘要请求成为 failed/interrupted。

单独 summary 记录、checkpoint source 标记或某个引用不足以证明过滤已应用。失败／取消发生在 replacement 之前不改变原 surface 与标记；replacement 已提交后，即使 end 或 flush 随后失败，也不能倒置已发生的提交。

released 表示该编号被排除于此次摘要输入，不保证别处没有相同内容。lastSummary.ids 是完整覆盖，excludedIds 是标记排除，projection.omittedReasoning 是独立 reasoning 策略，projection.attachments 是附件投影动作：native-image、reference-only、file-handle、marked-excluded、tool-pair-excluded。列表分别有界、有 omitted 计数，可按 ID 定位，完整回执由日志重建。

附件动作描述插件构造的摘要输入；native-image 表示转交原生图片投影，file-handle 表示转交句柄，均不是供应商已理解内容的证明。下游图片缩放与预算继续由 DSH adapter 管理。

## 代码调度、失败与安全路径

[调度器](../src/domain/scheduler.ts) 是纯选区建议和经济门槛；[引擎](../src/integration/engine.ts) 提供真实计量、路由、工具配对边界，并交由官方事务执行。候选选区按 surface 位置保持官方尾部保留语义，保留最前面的 system；缺少合法工具配对边界则不选。真正替换仍需通过官方选区、稳定性及缩短验证。

低压力下 `context_compact` 的显式模型请求与 queued-release backlog 共用门槛，context_release 仅提交排队意图。默认 `enabled: true`、`proactive: true`；backlog 需在候选范围内有实际可过滤的标记，显式请求不要求标记。默认需距最近摘要至少 8 个已提交助手步骤，净节省至少 2048 tokens、占当前总请求至少 0.2，预计在 8 个回合内回本。间隔从已提交 assistant slot 的 sourceSeq 推导，不是进程内调用次数。选区范围包含未标记历史，收益不能只算被标记条目。

所有成本标记 **HEURISTIC**，以归一化未缓存 token 为单位。`expectedSummaryRatio` 默认 0.2；`cacheReadRatio` 默认 0.1；`summaryInputRatio`、`summaryOutputRatio` 默认 1。令 S 为整个选区 token，I 为过滤后辅助摘要请求估算，P 为预计摘要 token，T 为保留尾部 token，H 为请求开销，r 为有效缓存读取比例，则主要估算为：

```text
P = ceil(I × expectedSummaryRatio)
netSavingTokens = max(0, S − P)
savingsRatio = netSavingTokens / currentTotalTokens
rebuiltSuffixTokens = P + T + H
initialRebuildPenalty = cachedPrefixAssumed ? rebuiltSuffixTokens × (1 − r) : 0
summaryCost = I × summaryInputRatio + P × summaryOutputRatio
perTurnSaving = netSavingTokens × r
breakEvenTurns = ceil((initialRebuildPenalty + summaryCost) / perTurnSaving)
```

I 使用实际摘要投影的估算，包含保留 system、过滤后的历史、请求开销及 256 tokens 固定 framing 余量；P、成本和回本均是预测。每回合无正收益或无法表示有限回本时，breakEvenTurns 返回 null；当前请求 token 为 0 时 savingsRatio 为 0。最近 usage 未提供 cacheReadTokens 时保守假定前缀已缓存，使用配置 r；明确未缓存时 r 默认 1、无首次重建惩罚。路由签名只记录估算来源，既不证明后续供应商命中，也不推断 TTL 或真实费用。

官方压力在经济/冷却检查前执行，实际 `context-overflow` 直接交回基础引擎；两条安全路径绕过经济门槛。用户 `/compact` 直接使用继承的 `compactNow`。内部基础引擎以 `auto: true` 保留官方溢出监听器，插件另记用户 `compaction.auto`：false 关闭普通压力与 backlog，仍允许实际溢出和显式模型请求。`proactive: false` 只关闭低压力 backlog；`enabled: false` 关闭经济调度，显式请求沿旧的强制摘要路径。

失败的 version 5 摘要请求保留 retryable。最近一次摘要后的 `compaction/end` 错误与错误后已提交的助手 slot 推导冷却步数 `max(1, min(8, minIntervalSteps))`；新的 queued 释放或摘要意图可令剩余等待为 0。失败不创建额外重试事件或运行期重试计数器；恢复和 fork 继续依据各自日志。历史 version 4 failed 请求不参与自动重试。官方提交后，之前 queued 及 failed/retryable 请求才成为 applied。

`context_status` 返回 scheduling.policy、auto、revision、decision、reason、selection、failure、plan 和 pressure；plan 中 markedIds 按查询 limit 截断并报告 omitted，失败 error 最多 1000 字符。pressure 返回选择用的预计总量、回放额外成本、最近主请求输入、当前阈值、预计是否低于阈值以及最近摘要的 effect/verification，不返回逐节点成本表。verification 区分 awaiting_replacement、awaiting_usage、below_threshold、above_threshold、unknown_target 和 route_changed；observedSavingsTokens 是移除新增内容估算后的观测值，不代表精确供应商账单。reason 包括 disabled、no_selection、no_marks、min_interval、min_savings、min_ratio、not_paid_back、eligible，以及 no_business_evidence、ineffective_compaction、active_compaction、no_route、invalid_capacity、invalid_retention、state_changed、failed_cooldown 等。查询只预览，不消耗稳定编号、不追加日志或修改 surface。

## 准入 ledger、目录与恢复

不再注册自动完整 ledger 的 systemPrompt runtime 快照；静态策略仍提供工具用法。普通消息正文和前缀不变。有界 ledger 变化追加到已有 allocation version 3 notice：最多 `min(8, catalogLimit)` 条，优先交付已知行的语义变化，再交付其他发生变化的非 available 行和新的 available 行。变化依据来源、当前绑定、排队事件及最近摘要覆盖；指纹淘汰不构成新变化。指纹仅为状态与 pendingReason；已准入的 U/I/F 和新预留 A 已由同 notice 声明，不重复列为 ledger 行。lastSummary 水位变化单独报告有界覆盖与排除 ID，省略行显示 omitted 并留在 context_status 的按需目录，不在后续准入中反复广播。

source 的 `ledgerView` version 1 只持久化最近交付的有界 `{id, fingerprint}` 和 `summaryWatermark`，不保存完整目录、正文预览或 token 计数。前视图只扫描当前 surface 末尾最多 64 个节点；最新 notice 缺少有效元数据、属于旧协议或未找到时发 bootstrap，不从更旧 notice 冒认最新视图。元数据与 notice 一同由核心提交，预览或准备失败不改变已交付水位。插件不单独删除旧 notice；官方 checkpoint 可以覆盖选区内的 notice，下一次准入按当前 surface 重新建立交付依据。

ledger 的状态始终由会话日志投影重建；resume/fork 不依赖进程内通知缓存。完整目录在 `context_status` 按需查询，返回列表仍有界，省略项可按 ID 定位。编号和正文目录各默认 32、最高 128 条，预览最多 100 个 Unicode 码点。pendingReason 区分 awaiting_covering_summary、summary_in_progress、outside_selection、summary_failed 与 protocol_protection。目录包含当前 summaryPolicy；历史摘要 projection 保留当时的策略及独立省略统计。

U/A/T 的 context_expand 经 sessionQuery.readEvent 读取 sourceSeq，单 text 原样返回，其他内容以可逆 JSON 返回；码点分页默认 4000、最高 16000。I/F 的 offset 必须是 0，逐项验证调用 agent 会话、sourceSeq、原角色、owner messageId、原始 blockIndex 与完整引用，调用方不能指定 ref、路径或 sessionId。

I 要求当前会话路由明确支持 image，readImage 验证存储，纯 render 返回元数据和新的原生 ImageBlock，去除旧 offloaded 状态。F 完整流式消费 readFileStream、等待末尾完整性检查、验证字节数，fs 把 host path 映射到工具命名空间；无映射只报告已验证引用，不冒充可读宿主句柄。不得收集文件全量正文进内存。

attachments 与 fs 是可选服务；缺失、未知图片能力或不可映射路径有明确状态，存储损坏和缺失成为工具错误。PTC image-rich 子调用由核心 auto-defer，文件子调用使用自有 notice defer 已验证结果；notice 不再编号。不能宣称完整 PTC runtime 已实测，当前测试覆盖公开 nested ToolRuntime 边界。

context_search 用 observeSession immutable lease，只检索当前会话原始证据，字面匹配保留空白并排除控制参数与输出。默认 8、最多 20 个命中；每个命中最多列出 8 个 I/F。cursor 绑定会话、条件及首轮 throughSeq。租约由 finally 释放。无文本线索的附件按 owner 目录定位，不提供图片语义搜索或二进制全文搜索。

查询不会把旧原文插回历史，恢复输出作为新工具结果进入上下文。原文保留依赖 DSH 日志和编号可重建；插件不另存数据库。

## 可选记忆与接入

ContextMemoryAdapter 服务的 extract(batch, signal?) 接收版本、sessionId、sourceSeqs、checkpoint、idempotencyKey；回执为 stored/duplicate/skipped/failed。未来调用必须独立安排提炼和保存，遵守目标记忆插件的 API 与授权，不能编辑生成的记忆文件或回滚已提交压缩。

每个 Cordis scope 只有一个 compaction provider。公共 bundle 的 `cordis.patch.yml` 按 Loader row id 对 `preset-standard`、`preset-ptc`、`preset-cordis` 做完整 config 覆盖，因为 Loader 不深合并 config。配置来自 DSH `0.2.0-rc.2` 的公开 shipped 模板，保留全部默认字段和 `!!js` 表达式，只在启用的 compaction 组中用 fold-context 替换 compaction-basic，保留 command-compact 和 tool-result-pruner。各组保持原有 `compaction: true`、`toolResultPruner: true` isolation realm；pruner 配置为 `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`。DSH 提供官方运行包，pruner 仅作为本包的开发依赖支持隔离共存回归。恢复需要可见 sessionQuery。
自定义 preset 可省略 tool-result-pruner，但不能同时挂载第二个 compaction provider。普通 pruner 在官方条件满足时可以先截短正文，再决定是否摘要；本插件原位释放则在步骤边界独立运行，使用独立语义意图及实际占位结算。两者均保存原始事件；普通 pruner 截短本身不构成语义 released。

profile 中优先级更高的自定义 preset 快照仍可能覆盖公共 bundle，需要在其 compaction 组单独同步；公共包不复制用户专属 profile 内容。既有会话保留启动时的 preset revision，应在新会话验证。本次打包不修改运行 profile。

Session 提交不等于磁盘成功。官方 session-checkpoint-policy 实际启用且 flush 成功时，才保证模型分发／工具执行前的来源先落盘。插件不在同步提示回调或事件观察者里追加日志。

验证使用公开 RAM 服务、官方 AgentLoop、本地 mock adapter、真实 LocalAttachmentStore 和临时 JSONL。独立进程验证冷恢复与 fork，包括原始 I/F、二进制校验和子会话私有附件隔离；公共 imageOffloadProjection 验证 derived 图像与 live/cold 回执一致。业务时钟、提醒持久化、拒绝/取消纯预览、可见 token 计量、原位释放及控制回执清理有独立回归；历史 summary-only 测试显式构造旧意图，不伪称当前工具仍接受 U/A。真实模型视觉理解、供应商缓存和实际节费、完整 PTC runtime 及异常断电仍需另行验证。安装替换现有包后依照 plugin_manager 的 application 结果判断是否需要重启；既有会话仍使用原 preset revision。
