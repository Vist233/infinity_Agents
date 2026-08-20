# ADR：Cloudflare D1 + zhangbot Redis 的唯一 Worker 架构

> 状态：Accepted
> 生效日期：2026-08-20
> 决策者：项目负责人
> 替代：`ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md` 中 PostgreSQL 事实源和 Worker 直连 PostgreSQL 的决定
> 实施计划：`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`

## 1. 最终决定

Infinity Agents 只保留一套生产任务架构：

```text
Cloudflare D1 = Task / Attempt / Worker / Event / Artifact metadata 唯一事实源
Cloudflare R2 = Method / Dataset / Artifact 文件对象
zhangbot Redis = task hint / Worker presence / 实时事件
Cloudflare Worker = 浏览器 API + Worker Control/Data API + D1/R2 binding
Docker Worker = Redis 等待通知 + HTTPS 调用 Cloudflare Worker API + Claude Code 执行
```

D1 是 Cloudflare 自带 SQL 数据库，使用 SQLite 语义，不是 PostgreSQL。当前目标不使用
PostgreSQL，也不使用 Hyperdrive。Docker Worker 不获得 Cloudflare Account API Token，
不直接调用管理用途的 D1 REST API；它只使用自己的持久 Worker credential 调用平台固定
HTTPS API，由 Cloudflare Worker 通过 `env.DB` binding 访问 D1。

## 2. 单一事实源

- Task、Attempt、lease、fencing、Worker enrollment/session、Event、Outbox 和 Artifact metadata 只写 D1；
- 文件本体写 R2，D1 保存 object key、size、SHA-256、manifest 和发布状态；
- Redis 只保存可重建的 opaque hint、presence 和实时事件；
- Redis 清空不能丢 Task、Attempt 或 Artifact；
- 禁止 D1/PostgreSQL 双写；
- 禁止把本地 PostgreSQL acceptance 结果当作当前 D1 架构的发布证据。

## 3. 用户与 Worker 权限

浏览器用户和执行 Worker 是两种不同身份：

- 浏览器用户只能查看自己的 Session、Task、Event 和 Artifact；
- `created_by` 只用于网页查询、审计和下载授权；
- 所有兼容 Worker 属于同一 `public-default` Pool 和 `infinity-public` Namespace；
- Worker 领取查询不按 Task 创建者过滤，可以执行任何用户的 queued Task；
- 不存在 `general/full`、`trusted/student` 或用户私有执行池；
- 普通用户只能点击“创建”触发服务端签发 Worker ID/credential，并查看自己触发签发的 Worker 状态；
- Namespace、Pool、D1、R2、Redis、Provider、协议和调度策略只由超级管理员配置；
- 一个 credential 同时只能绑定一个 active Worker session；
- 可以签发任意数量 Worker，不存在 A/B 或两个 Worker 上限。

旧 D1 表中的 `trust_level`、`task_class` 和类似字段必须迁移为单一 public 值后删除，或在
迁移窗口内保持完全不可影响调度；最终生产 schema 不保留第二套执行策略。

## 4. Worker Control/Data API

Docker Worker 只通过固定 HTTPS 路由访问 D1/R2：

```text
POST /api/worker/v2/connect
POST /api/worker/v2/heartbeat
POST /api/worker/v2/poll
POST /api/worker/v2/tasks/:id/accept
POST /api/worker/v2/tasks/:id/renew
GET  /api/worker/v2/tasks/:id/spec
GET  /api/worker/v2/tasks/:id/inputs/:resource
POST /api/worker/v2/tasks/:id/artifacts/start
PUT  /api/worker/v2/tasks/:id/artifacts/:upload/parts/:part
POST /api/worker/v2/tasks/:id/artifacts/:upload/complete
POST /api/worker/v2/tasks/:id/fail
POST /api/worker/v2/tasks/:id/cancelled
```

具体路径可以在第一张合同卡中微调，但只能有一个版本化协议。所有任务数据查询必须同时
绑定经过认证的 `worker_id + session_id + attempt_id + lease_token + fencing_epoch`，不能提供
通用 SQL、通用 D1 查询或按任意用户读取数据的接口。

## 5. D1 原子状态机

D1 使用固定 prepared statements 和条件更新：

```text
queued Task
→ UPDATE ... WHERE status='queued' AND active_attempt_id IS NULL
→ changes 必须等于 1
→ 创建 Attempt、lease、fencing epoch 和 Event
```

Task 创建必须在一个 D1 batch/transaction 中写入 Task、幂等记录、Event 和 Outbox。claim、
续租、失败、取消和完成都必须检查当前 Attempt、lease 和 fencing。重复 Redis hint、重复
HTTP 请求或旧 Worker 回写不能产生第二个有效 Attempt或覆盖新 Attempt。

D1 没有 PostgreSQL RLS。浏览器隔离和 Worker能力必须通过认证后的固定路由、每条 prepared
query 中的 owner/lease 条件、字段 allowlist 和 Alice/Bob/旧 lease 负向测试实现，不能在
文档中继续声称 PostgreSQL RLS提供保护。

## 6. zhangbot Redis 与 Relay

zhangbot 上现有 Redis 是唯一 Redis。它不保存业务事实，也不向 Cloudflare暴露 raw Redis
command。由于 Cloudflare Worker不能直接使用普通 TCP Redis，增加一个最小 HTTPS Redis
Relay：

```text
D1 Task + Outbox 原子提交
→ Cloudflare Worker/Scheduled flush 使用服务端 Secret 调 Relay
→ Relay 幂等写入 Redis Stream opaque task hint
→ Docker Worker Consumer Group 收到 hint
→ Worker 调 Cloudflare Worker API 做 D1 条件 claim
```

Relay 只接受固定事件类型、event ID、task ID、namespace 和签名，不接受 raw key、raw command、
用户数据、Method/Dataset、Provider Secret 或任意 Redis payload。Relay失败时 D1 Outbox 保持
pending，恢复后重放。Worker也可以低频调用受认证 poll 作为通知恢复机制，但不能建立第二
任务事实源。

## 7. Docker 与 Goal-Driven Runtime

已经验收的以下边界继续有效：

- 唯一生产镜像：`backend/Dockerfile.worker`；
- 唯一 Runtime：`backend/code_agent/worker/claude_runtime.py`；
- 一个长期容器对应一个 Worker；
- Claude Code 在同一容器内以非 root 子进程执行；
- 不安装/调用 Docker CLI，不挂 Docker Socket，不使用 Docker-in-Docker；
- 平台固定 Goal-Driven Prompt，Task goal 只写冻结 `task_spec.json`；
- Method 与 Dataset 各自 25MB 上限；
- 结果使用 streaming/multipart 上传；
- 没有独立 Verifier，但 finalize 必须校验 active lease、fencing、size、SHA-256、manifest、ZIP 和 R2 object；
- 每次任务后清空本地 Task目录并继续等待。

## 8. 凭证与 Secret

- Worker credential由服务器生成，D1保存 hash；需要“取回并复制”时，只能保存使用平台 KEK 加密的 ciphertext；
- credential 明文不进入日志、Artifact、Redis、Git或浏览器 Local Storage；
- Worker只获得自己的持久 credential和最小 Redis ACL credential；
- Provider配置由超级管理员提供，优先使用 Attempt-scoped模型能力；
- Worker不获得 Cloudflare Account Token、D1管理 Token、R2 parent key或 Redis管理员密码；
- 撤销 Worker 后，其 active session、lease续期、输入下载、上传和 finalize全部失败。

## 9. 当前代码判定

截至当前 `cloudflare-deploy` C4 候选版本：

- 唯一 `backend/Dockerfile.worker` 已切换到 `consumer_v2`；唯一生产 Runtime 仍是
  `backend/code_agent/worker/claude_runtime.py`；
- `/api/worker/v2/*` 已实现 D1 session、CAS claim、lease/fencing、R2 input 和 multipart
  Artifact finalize；旧 `/api/worker/v1/*` 不属于新协议；
- `backend/redis_relay.py` 和 Edge outbox relay 已实现固定 HTTPS Relay 合同，但尚未部署
  到 zhangbot；
- 镜像内不包含 PostgreSQL/Redis 客户端、Docker CLI、Docker socket 或旧 Consumer；
- 旧 Python PostgreSQL/RLS 文件和旧迁移表仍仅用于历史测试/迁移兼容，不能通过当前
  `docker-compose.cloudflare-workers.yml` 作为生产 Worker 启动；C5 真实链路通过后再按调用
  关系删除无依赖的历史文件；
- C5 的真实 D1/R2/Claude Case 2、C5R Redis恢复、C6真实登录浏览器审查和命名 Tunnel
  生产切换均已通过；Case 3由用户明确延期并记为 `DEFERRED_BY_OWNER`。C7发布收口仍未完成。

## 10. 发布门槛

必须使用同一候选版本完成：

- 本地/预生产 D1 + R2 + zhangbot Redis Relay + 真实 Docker Worker；
- Case 2与Case 3；
- 跨用户公共 Worker领取，同时浏览器 Alice/Bob仍隔离；
- 重复 hint、双 Worker claim、失租、撤销、Redis清空和 Relay重放；
- 大 Artifact multipart、下载 hash和任务后清理；
- 前端、后端/Edge、Docker和浏览器审查；
- Git commit、checkpoint、GitHub、GHCR和Cloudflare版本可追溯。

在这些门槛通过前，不部署 Cloudflare，不发布 GHCR，不宣称线上 Worker闭环完成。
