# PAPER-10 真实论文请求根因审计（2026-08-30）

## 范围、基线与安全边界

- 卡片：PAPER-10 的诊断子阶段；目标是解释真实论文请求只显示“现在开始下载并解析 PDF”而没有可观察、可继续的任务状态。
- 分支：`cloudflare-deploy`。
- 本地基线：`154f9e16ddeffcccc2398dbbdf545497ed065bec`；开始和结束时工作区均干净。
- 远端只读核验：`origin/cloudflare-deploy` 精确指向同一 SHA `154f9e16ddeffcccc2398dbbdf545497ed065bec`。
- 本次没有改产品代码、配置或测试，没有 claim 浏览器，没有部署，没有写 Cloudflare、D1、R2、WAF、Secret、Redis 或 zhangbot。
- Cloudflare D1 仅执行了不返回正文、参数、对象键或凭据的 `SELECT` 聚合/元数据查询；所有查询 `exit=0`、`changes=0`、`rows_written=0`。

## 线上请求重建（无正文读取）

审计目标是最新的非 legacy 论文 turn；完整 session/turn/资源/attempt 标识不写入本报告，仅使用 D1 event ID 和脱敏时间窗口。D1 事件存在性、长度和固定短语查询没有返回消息正文。

| 时间（CST） | D1 event | 事实 |
| --- | ---: | --- |
| 00:37:49 | 50 | `user_message`，本次请求开始 |
| 00:37:56–00:39:36 | 51–60 | 5 次 `search_paper` tool call，5 个配对 `tool_result`，结果状态均 `succeeded` |
| 00:39:54 | 61 | 1 次 `materialize_paper` tool call；其关联 content 长度为 134，固定短语“现在开始下载并解析 PDF”的存在性查询返回 `1` |
| 00:39:55 | 62 | `materialize_paper` 配对结果状态 `succeeded`，结果长度 206，并包含 `processing` 标记 |
| 00:39:56 | 63 | `assistant_message` 状态 `completed`，`content` 为 `NULL`；没有后续 `read_paper` 或 `analyze_paper_image` tool call |

因此，可见的下载/解析措辞属于带有 `materialize_paper` 请求的模型 content，而不是 Paper resource 的状态字段。实时流仍会把该 content 当作普通 assistant chunk 显示。

## 对四个问题的证据回答

### 1. Worker → provider → tool loop

代码位置：

- 工具声明在 `cloudflare-worker/src/tools.ts:712-803`：`search_paper`、`materialize_paper`、`read_paper`、`analyze_paper_image`。`request_task_creation` 是另一条 C7 后台任务确认流，不是论文资源创建器。
- 入口和用户事件持久化在 `cloudflare-worker/src/chat.ts:388-486`：先校验 session/user，再把 `user_message` 写入 `chat_events`，然后进入 `streamModelLoop`。
- Tool call 持久化在 `cloudflare-worker/src/chat.ts:192-212`，每个 provider call 在执行前写入 `chat_events` 的 `tool_call`。
- Tool result 持久化在 `cloudflare-worker/src/chat.ts:215-232`；执行完成后写入配对 `tool_result`，并把结果追加回 provider messages。
- 继续循环在 `cloudflare-worker/src/chat.ts:740-829`：有 tool call 时写入、执行、写入结果并在 818-819 `continue`；没有 tool call 时在 822-825 把 content 当作最终回答并结束。
- provider SSE 解析在 `cloudflare-worker/src/chat.ts:850-969`：`delta.content` 在 923-930 直接发出 chunk，`delta.tool_calls` 在 932-940 按 index 累积；没有把“开始下载/解析”这类文字转换成工具调用的规则。

本次真实请求的结论是：模型实际调用了 `search_paper` 5 次和 `materialize_paper` 1 次；没有调用 `read_paper`（分页文本/图片列表入口）或 `analyze_paper_image`。不存在“有效 tool call 被 provider 解析丢弃”的证据：调用和配对结果都已经进入 D1。代码确实会忽略 malformed SSE JSON，但该路径不符合本次已有的持久化事件事实。

### 2. D1 是否创建了真实 Paper 工作记录

创建了，而且不是 C7 `tasks` 行：

- `cloudflare-worker/src/tools.ts:357-368` 把 resource 状态序列化为 `mode=processing`；`materializePaper` 在 371-412 先做 session 授权，再由 `createPaperResource` 创建 `requested` 资源并建立 session link。
- `cloudflare-worker/src/db.ts:579-622` 的 `createPaperResource` 只写 `paper_resources`，不创建 `outbox_events`。
- 本次 D1：1 个 `paper_resources`，来源 `arxiv`，最终 `ready`，12 页、28 图；创建时间 00:39:55，ready 时间 00:41:46。
- 本次 D1：1 个 `paper_processing_attempts`，状态 `succeeded`，处理器为 `paper-processor-zhangbot-v1`；开始时间 00:39:55，完成时间 00:41:46。
- 本次 D1：4 个 Paper audit 记录：`materialize/succeeded`、`extraction/started`、`upload/started`、`upload/succeeded`。
- 本次 turn 没有 `request_task_creation`、task confirmation 或 C7 task event。全局 `outbox_events` 只读聚合显示的都是较早的 `aggregate_type=task` 事件；它是 C7 relay，不是 Paper Processor 队列。

所以，“没有真实任务”只在把 C7 `tasks` 误当成 Paper 工作实体时成立。Paper 的真实 durable work 已创建并完成；缺少的是把它作为用户可见任务呈现，以及在 ready 后继续模型读取的编排。

### 3. zhangbot 是否 poll 到 grant

是。`cloudflare-worker/src/paper-processor.ts:182-197` 的 `poll` 唯一调用 `claimPaperResource`；`cloudflare-worker/src/db.ts:1000-1057` 在 claim 中创建 `paper_processing_attempts` 并将 resource 从 `requested` 转为 `downloading`。因此上述 succeeded attempt 是真实 grant 的直接 D1 证据，不是仅凭进程存活推断。

zhangbot 只读复核同时显示：`infinity-paper-processor.service` 为 `active/running`，`MainPID=2052141`，`NRestarts=0`；Redis、Redis Relay、Cloudflared 也均 active；Processor PID 没有监听端口。user journal 从启动以来只有 systemd 启动行，没有 poll 细节，这是日志能力限制而非 poll 失败：`backend/paper_processor/runner.py:11-29` 没有逐次 poll 日志，空 poll 只 sleep，异常也会被捕获后重连。

### 4. 前端能显示什么，以及为什么看不到 Paper 任务卡

当前前端能显示：

- `frontend/components/chat/RunStatus.tsx:10-31`：流式期间的通用 phase、spinner 和 active tool chips；流结束后 `isLoading=false`，它不再显示。
- `frontend/components/chat/MessagePane.tsx:89-105`：assistant/user 文本；`MessagePane.tsx:116-135`：由 `tool_call/tool_result` 组成的通用 Tool activity timeline。
- `frontend/components/analysis/TaskConfirmationCard.tsx` 以及 `frontend/components/chat/ChatWorkspace.tsx:95-120`：仅用于 C7 `taskDraft/taskConfirmation`，即 `request_task_creation` 确认卡。

当前前端没有 Paper resource 的状态类型、查询/订阅、进度卡或 refresh rehydration。`frontend/lib/api/sessions.ts` 和 `cloudflare-worker/src/sessions.ts:52-137` 只把聊天文本及 tool timeline 返回给前端；前端代码没有调用 `/api/paper/resources/:id`。此外，`toolResultStatus` 只根据结果是否含 `error` 判断调用成败，因此 `materialize_paper` 的“调用成功但资源仍 processing”会呈现为 tool `succeeded`，无法表达 `requested/downloading/extracting/uploading/ready`。

具体可见链：provider 在收到 materialize 前后发出的 content chunk 会被 `use-chat-controller.ts:529-532` 直接追加到 assistant bubble；真实 resource 的 Processor 进度发生在聊天 SSE 结束之后。没有 ready 事件、轮询或 server-side re-drive 将状态带回这条 chat turn，用户就只看到“模型说要开始”，看不到 Paper task/progress card。刷新时，聊天历史也只恢复文本和通用 tool timeline，不恢复 Paper resource 状态。

## 单一主根因与因果链

**主根因：Paper 的异步 resource lifecycle 没有接入 chat turn 的 durable continuation 和前端状态协议。**

因果链如下：

1. 模型正确发出 `search_paper` 与 `materialize_paper`；Worker 正确持久化调用/结果，`materialize_paper` 创建 durable resource 并返回 `processing`。
2. Worker 只在当前 provider loop 内继续一次模型对话；下一次 provider 响应没有 `read_paper`/`analyze_paper_image`，于是 822-825 把无 tool call 的结果视为完成并发 `done`。本次最终 `assistant_message` 甚至为空；此前带工具调用的 content 已被实时显示。
3. zhangbot 随后独立 poll、下载、解析并把 resource 推进到 `ready`；该状态没有触发新的模型 turn，也没有发给前端。
4. 前端只理解 chat/tool/C7 task 状态，不理解 Paper resource lifecycle，因此自然没有可继续的 Paper task card。

这不是 Kimi、WAF、VPN、浏览器控制权、Processor 部署或工具 handler 失败：本次 D1 已证明 tool call、resource、grant、解析和 ready 都发生了。另一个尚未被本次 turn 触发的健壮性缺口是“paper 意图下 provider 只返回 prose 时也会被当成完成”；它应在后续修复卡中由明确的 paper-intent/tool contract 处理，但不能拿它替代本次已有 tool call 的事实。

## 可复现审计步骤（不重放写操作）

1. 使用已有认证请求的时间窗口，在生产 D1 只执行按 `event_type/tool_name/status/created_at` 分组的 `SELECT`，不要选择 `content`、`tool_arguments_json`、`result_summary` 或任何对象/凭据字段。
2. 按 D1 event ID 50–63 重建事件顺序；用 `LENGTH` 和固定短语 `INSTR` 只返回长度/0-1 标记，确认措辞在 event 61 的 tool-call content，不输出正文。
3. 对 `paper_resources`、`paper_processing_attempts`、`paper_resource_audit_events` 只读取状态/来源/阶段/时间/计数；验证 requested→ready、attempt succeeded 和 extraction/upload audit。
4. 在 zhangbot 只读读取 user unit 状态、systemd journal 和监听端口；不要发送新的 Processor 请求，不要触碰环境文件。
5. 用仓库当前代码逐段复核上述行号，并运行本报告对应的本地测试。没有在本审计中重放真实论文请求，避免再次写入 D1/R2 或调用 provider。

## 后续修复卡（不超过三张；本审计不实施）

1. `PAPER-FIX-01 — Paper intent durable orchestration`：为一次论文请求建立可重入的 Paper request/resource correlation；materialize 后把 `processing` 作为明确终态分支，禁止只用 prose 结束；在 ready 后由受控 server-side continuation 或用户可重试的同一 request 驱动 `read_paper`，并为 prose-only provider 响应建立失败/修复合同。
2. `PAPER-FIX-02 — Paper progress read model/events`：复用 session/user ownership，提供只读 resource status/progress（stage、ready/failed、page/image counts、safe error）和 refresh-safe event/correlation；区分“tool invocation succeeded”和“resource ready”。
3. `PAPER-FIX-03 — Durable Paper progress UI`：前端增加 Paper progress card，消费上述 read model，显示 requested/downloading/extracting/uploading/ready/failed/cancelled，支持刷新恢复、取消/重试，并用真实/负向测试证明模型文字不能伪造完成状态。

## 审计结论

- 根因审计：`COMPLETE`。
- Paper 真实资源链：`created → granted → parsed → ready`，有 D1 证据。
- 本次 turn 的文本读取/图片分析：未发生；这是缺少 async continuation 的直接结果。
- Paper 可观察任务 UI：当前未实现；这是最小修复边界的核心。
- PAPER-10 原始发布验收：仍不因本报告而宣称完成；本次仅提交无密钥诊断证据，不推送。
