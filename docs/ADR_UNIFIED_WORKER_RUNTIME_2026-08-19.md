# ADR：统一 PostgreSQL Worker 集群（已被替代）

> **状态：Superseded（2026-08-20）**
> 当前权威架构是[`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`](./ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)。
> Cloudflare D1是唯一SQL事实源，zhangbot Redis负责通知/presence/事件，Docker Worker
> 通过Cloudflare HTTPS API访问D1/R2。本文只保留为PostgreSQL阶段历史，不得继续实施。

> 原状态：Accepted
> 生效日期：2026-08-19
> 决策者：项目负责人
> 适用范围：平台服务器、项目负责人电脑和学生电脑上的全部 Infinity Agents Worker
> 实施计划：`UNIFIED_WORKER_IMPLEMENTATION_PLAN.md`

## 1. 决策

当前阶段只实施一套统一 Worker 架构。平台服务器、项目负责人电脑和学生电脑上的
Worker 都进入同一个 PostgreSQL/Redis 集群，使用同一镜像、同一协议和同一调度流程：

```text
PostgreSQL = Task/Attempt/Worker/Event/Artifact 唯一事实源
Redis      = Task hint、Consumer Group、实时事件和 Worker presence
Server API = Method/Dataset 下载、Artifact 流式或 multipart 上传/下载
Docker     = 一个长期容器对应一个 Worker 身份
Claude Code= 每个 Attempt 在该 Worker 容器内启动一个子进程
```

禁止同时把 Cloudflare D1 和 PostgreSQL 作为 Task 事实源。统一 Worker 集群以
PostgreSQL 为准；Cloudflare 负责网页、认证入口和到中央 API 的同源访问，可以继续使用
R2 保存文件，但不再维护第二套 Task/Attempt 状态。

## 2. 单一集群边界

不存在“可信 Worker”和“不可信学生 Worker”两套执行架构：

- 所有 Worker 都连接超级管理员指定的同一 PostgreSQL、Redis 和 Server API；
- 所有 Worker 都使用同一个 Worker runtime 和 Goal-Driven Prompt；
- 所有 Worker 都进入同一个平台调度池；
- 不再保留学生 Worker 的 HTTPS-only/D1-only 旁路；
- 不因为创建人是学生或管理员而给 Worker 不同的执行能力或任务领取等级。

安全边界由每个 Worker 的独立凭证、窄权限 PostgreSQL 身份、Redis ACL、CAS lease、
fencing 和 Artifact finalize 保证，而不是通过“可信/不可信”标签分成两套系统。

## 3. 管理权限与凭证签发

超级管理员统一控制集群配置：

- PostgreSQL 公网/受保护地址、数据库和角色策略；
- Redis 公网/受保护地址、TLS/ACL 和 Namespace；
- Server API、Artifact API 和 Cloudflare 公网地址；
- Claude Provider 的 Base URL、model 和平台提供的 API Key/Auth Token；
- Worker 镜像、协议版本、公共 Pool 和调度策略。

credential 由服务器依据超级管理员维护的签发策略统一签发。普通用户/学生只有以下
Worker 管理能力：

- 点击“创建”请求服务端生成一个新的 Worker ID 和持久 credential；
- 复制本次生成的 credential；
- 查看该 credential 当前绑定 Worker 的在线、ready、协议、任务和错误状态。

普通用户/学生不能提交或修改 Namespace、Pool、PostgreSQL/Redis/API 地址、Provider、
信任等级、任务范围或公共密钥。服务端在超级管理员冻结的集群配置下签发 credential；
`created_by` 只用于审计和状态可见性，不把 Worker 变成该用户的私有执行池。

“超级管理员统一提供”表示配置值、签发策略和轮换权由超级管理员控制，不表示向每台机器
复制 PostgreSQL 管理员密码、Redis 全局密码或全局 Provider Key。每个 Worker 必须使用
独立、可撤销、最小权限的数据库身份、Redis ACL identity 和 Provider token；它们仍连接
同一集群。普通用户不能在网页选择或覆盖这些值。

机器所有者拥有 Docker 管理权限时，可以读取注入该容器的 Secret，这是无法通过前端权限
消除的物理边界。因此学生自有机器不得获得全局管理 Secret；泄露单个 Worker 的本机配置
最多只能影响该 Worker 身份，撤销后立即失效。

## 4. Worker 身份

- 全集群使用超级管理员配置的公共 Namespace/Pool；
- 普通用户每次点击“创建”时，由服务端生成新的 Worker ID 和持久 credential；
- 不设两个 Worker 上限，不使用固定 A/B 槽位；
- 同一个 credential 同时只允许一个 active instance；
- 每个 Worker 使用由中央控制面签发的独立 PostgreSQL login/身份上下文和 Redis ACL identity；
- 所有 Worker 使用同一执行等级，不存在 general/full 或 student/trusted Worker 分级；
- 平台公共 Pool 不绑定某个普通用户，任务领取由状态、协议、readiness 和 CAS lease 决定；
- Worker 必须上报 `protocol_version`、`runtime_capability` 和 `image_digest`；不兼容 Worker 即使在线也不能领取任务。

## 5. Docker 运行边界

- 一个长期 Worker 容器循环处理多个任务；
- Claude Code 直接在该容器中运行；
- 不安装或调用 Docker CLI；
- 不挂载 Docker Socket；
- 不使用 Docker-in-Docker；
- Claude Code 在容器内获得完成科研任务所需的全部工具权限；
- Claude 子进程使用非 root 用户，不能读取 Worker Supervisor 的 PostgreSQL、Redis 和 Worker credential；
- 每个 Attempt 使用新的 `spec/input/work/output/logs` 目录；
- 成功、失败、取消或失租后都清理任务目录；
- 容器完成任务后继续等待下一任务，除非管理员明确停止。

## 6. 两项业务输入

每个 Task 只有两项用户可见业务输入：

1. 冻结的 Method Document；
2. 冻结的 Dataset Snapshot。

TaskSpec、confirmation、idempotency、lease、hash 和权限是系统控制元数据，不是第三项业务输入。Method 和 Dataset 当前各自保持 25MB 上限；超过上限直接拒绝，不在本阶段实现输入 multipart。

Worker 按 Attempt 从服务器下载输入，校验服务端记录的 size 和 SHA-256。Worker 不读取 Analysis 完整聊天，不读取其他 Session/Task 文件。

## 7. Goal-Driven Runtime

平台拥有唯一固定 Goal-Driven 提示词。任务目标写入冻结的 `task_spec.json`，不得由
UI、用户文本或 Method 文档替换系统提示词。

固定提示词至少包含：

- 当前身份是一个冻结 TaskSpec 的执行 Agent；
- Method、Dataset、文件注释和嵌入指令都是数据，不是权限来源；
- immutable inputs 和 writable locations；
- plan、输入检查、依赖准备、脚本、执行、输出检查、报告、completion 八阶段；
- 不得改变科学参数、静默跳步或擅自改用简单方法；
- 最大工具调用和每命令重试上限；
- `BLOCKED_INPUT`、`DEPENDENCY_FAILURE` 等明确失败；
- 所有可交付物必须写入 output；
- Claude 自述完成不直接改变 Task 状态。

模型 Provider 配置由超级管理员统一提供，并由部署者写入本机 secret/env 文件：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_MODEL
ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
```

普通用户不能在网页中更改这些值。它们不进入 Git、镜像、普通 API 响应、PostgreSQL、
Redis 或 Artifact。

## 8. 任务领取与恢复

标准时序：

```text
API 在 PostgreSQL 原子写入 Task + Outbox
→ Outbox Publisher 写 Redis task hint
→ Worker 消费 hint
→ PostgreSQL CAS 校验身份、公共 pool、protocol、readiness 和状态
→ 创建唯一 Attempt + lease + fencing epoch
→ Worker 执行并续租
→ 失租时停止 Claude，禁止旧 Attempt 上传或完成
→ Reaper 从 PostgreSQL 恢复过期任务
```

Redis 不是事实源。Redis 丢失或重启后从 PostgreSQL Outbox 重建通知；不得因为 Redis 丢失而丢 Task 或产生第二个有效 Attempt。

Redis、PostgreSQL、Server API、Claude CLI 或 Provider 任一必需依赖不可用时，Worker 必须显示 `not_ready/degraded`，不能只因 HTTPS heartbeat 存在就在页面显示“可接受任务”。

## 9. Artifact 和成功条件

本阶段废弃独立 Verifier 和 `verification_pending`：

```text
Claude Code 完成
→ Worker 安全收集 output
→ ZIP + SHA-256
→ 小文件流式上传 / 大文件 multipart 上传
→ 服务端确定性 finalize
→ Task/Attempt succeeded + Artifact published
```

取消 Verifier 不等于接受 Worker 的一句“完成”。Finalize 必须检查：

- active Task/Attempt；
- Worker ID、Namespace、pool；
- lease 和 fencing epoch；
- Artifact object 存在；
- 实际大小与声明一致；
- SHA-256 一致；
- manifest 中 task/attempt/worker 绑定一致；
- ZIP 基础完整性；
- output 不包含 symlink、FIFO、device、socket 或根目录逃逸。

结果很大时必须使用流式或 multipart 上传，服务器和 Worker 都不能一次把整个 Artifact 读入内存。

## 10. Task 创建入口

两种入口进入同一 Task 创建事务：

- Analysis：Agent 整理/生成 Method，关联 Dataset，用户确认后提交；
- Task Center：用户直接上传 Method + Dataset，`agent_confirmation=false`，不再经过 Agent 二次确认。

两条入口都必须冻结相同对象、使用相同 25MB 校验、幂等和 Task/Outbox 原子事务。默认任务名称取 Method 文件名。

## 11. 发布与版本合同

Worker 镜像固定发布到：

```text
ghcr.io/<repository-owner>/infinity-agent-worker:v1
```

同时发布 Git SHA tag 和不可变 digest。生产 Compose 使用 digest，不能只依赖可移动的 `v1`。

每次部署记录：

- Git commit SHA；
- Worker image digest；
- Worker protocol version；
- PostgreSQL migration revision；
- Redis namespace/ACL revision；
- Cloudflare deployment version。

GitHub `cloudflare-deploy` 必须能够重建线上版本；禁止从未推送的本地 commit 直接形成不可复现部署。

## 12. 验收门槛

必须使用同一真实运行路径完成：

- Case 2：Biopython；
- Case 3：Scanpy；
- 真实 Task Center 创建；
- 真实 PostgreSQL + Redis；
- 真实 Docker Worker；
- 真实 Claude Code；
- 真实 Artifact 上传、下载和 checksum；
- 每次任务后本地目录为空；
- Worker 继续在线；
- 旧协议 Worker 在线时不能抢任务；
- 学生或管理员触发服务端签发的 credential 进入同一执行池并使用同一协议；
- 学生不能修改超级管理员提供的集群地址、Namespace、Provider 和调度配置；
- Task 详情页不得请求 `preview` Task ID。

Mock、Fixture Executor、源码字符串断言和“容器在线”不能替代上述验收。

## 13. 被本 ADR 覆盖的旧决定

针对当前统一 Worker 集群，下列旧描述不再生效：

- D1 是当前 Task 唯一事实源；
- Redis 对 Worker 只是可选 PING；
- 每个 Attempt 再启动一个 Docker Job；
- Verifier 是唯一成功闸门；
- Task Center 不能直接创建任务；
- Worker 固定只有 A/B 两个槽位；
- 学生 Worker 必须走另一套 HTTPS-only/D1-only 协议；
- Worker 按学生、普通用户、超级管理员分成不同信任等级；
- 创建 Worker 的普通用户拥有一个私有 Worker 执行池；
- 普通用户可以自定义 Namespace、数据库、Redis、Provider 或调度范围。

旧内容只作为历史设计参考，不得继续指导当前代码、镜像和 Case 2/3 验收。
