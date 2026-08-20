# Infinity Agents — Cloudflare Deploy 交接文档

> 最后更新：2026-08-20
> 当前分支：`cloudflare-deploy`；本次 Worker 修复代码：`a3bcc10`；线上代码候选：`cc88c73`
> 本文只描述当前 D1 目标架构。旧 PostgreSQL/RLS 文档、旧 Worker 协议和旧 Compose
> 文件属于历史资料，不能作为新机器或生产部署说明。

## 0. 不可改变的架构约束

- Cloudflare D1 是唯一 SQL 数据库，也是 Task、Attempt、Worker、Session、Event、Outbox
  和 Artifact 元数据的唯一事实源。
- Cloudflare R2 保存 Method、Dataset 和最终 Artifact 文件本体；D1 只保存对象键、大小、
  SHA-256、manifest 和发布状态。
- zhangbot 上的唯一 Redis 只保存可重建的任务提示、presence 和实时事件。它只监听回环地址，
  通过 HTTPS Relay 对外提供固定接口；浏览器和 Docker Worker 不直连 Redis TCP。
- 生产 Worker 只使用持久 credential 调用 `infinity.zhangyvjing.com/api/worker/v2/*`。
  Worker 不持有 Cloudflare Account Token、D1 管理 Token、R2 parent key、Redis 密码或任意
  SQL 连接串。
- 所有 Worker 都属于固定的 `public-default / infinity-public` 公共池；没有可信/不可信等级、
  学生私有池、用户自定义 Namespace 或两个 Worker 上限。
- 一个持久 credential 只能对应一个 active instance。要开第二个容器，必须由服务端签发
  第二个 Worker ID 和 credential，不能复制第一个 credential。
- `backend/Dockerfile.worker` 是唯一生产镜像。容器内直接运行 Claude Code，不使用
  Docker-in-Docker、Docker Socket、Verifier 或第二个任务容器；任务完成、失败、取消或失租
  后清理 attempt 工作目录，只保留上传到 R2 的结果。
- Method 和 Dataset 单个均不超过 25 MiB；大结果使用 R2 multipart 和最终整体 SHA-256 校验。

## 1. 产品和执行闭环

```text
研究问题
  -> Analysis Agent 检索、阅读论文并整理执行文档
  -> 关联 Method + Dataset，展示给用户确认
  -> Task Center 在 D1 创建 queued Task
  -> D1 Outbox -> zhangbot HTTPS Redis Relay（仅唤醒提示）
  -> Docker Worker v2 通过 HTTPS poll/claim
  -> 下载冻结的两个输入文件 + 固定 Goal-Driven Prompt
  -> 容器内直接运行 Claude Code
  -> R2 multipart 上传 result.zip
  -> D1 校验 lease/fencing/size/SHA-256 并发布 Artifact
  -> 网页查看、下载结果
```

Analysis 负责理解问题、查论文、比较方法和整理可执行文档，不应把 DOI、LOD 或一组刻板
字段当成用户最终目标。Task Center 负责异步任务、状态、Attempt、Worker、日志和结果，
不是第二个聊天 Agent。ImageJudge 是本地图像数据生产工具，不参与 Worker 任务控制面。

## 2. 线上组件

| 组件 | 位置 | 责任 |
|---|---|---|
| Edge Worker | `infinity.zhangyvjing.com` | 同源登录/API、D1/R2、Worker v2 控制面、Outbox 定时转发 |
| D1 | `infinity-agents-db` | 唯一 SQL 事实源 |
| R2 | `infinity-agents-resources` | 输入和 Artifact 文件 |
| Redis | `ssh zhangbot`，127.0.0.1:6379 | 可重建 hint/presence/事件 |
| HTTPS Relay | zhangbot 用户级 systemd | 固定 `/health`、`POST /v1/events`、`GET /v1/hints` |
| Docker Worker | 外部 Windows/Mac/Linux 机器 | 领取任务、运行 Claude Code、上传结果 |

当前 Relay 的源代码是 `backend/redis_relay.py`，依赖是 `requirements.relay.txt`。在
zhangbot 上它安装到用户目录并由 `infinity-redis-relay.service` 管理，绑定
`127.0.0.1:8090`；Redis ACL 凭证只存在远程配置文件，不写入仓库。

## 3. Worker v2 合同

```text
POST /api/worker/v2/connect
POST /api/worker/v2/heartbeat
POST /api/worker/v2/poll
POST /api/worker/v2/tasks/:id/accept
POST /api/worker/v2/tasks/:id/renew
GET  /api/worker/v2/tasks/:id/spec
GET  /api/worker/v2/tasks/:id/inputs/method|dataset
POST /api/worker/v2/tasks/:id/artifacts/start
PUT  /api/worker/v2/artifacts/:upload/parts/:part
POST /api/worker/v2/artifacts/:upload/complete
POST /api/worker/v2/tasks/:id/fail
POST /api/worker/v2/tasks/:id/cancelled
```

连接时固定发送：

```text
WORKER_PROTOCOL_VERSION=2
WORKER_RUNTIME_CAPABILITY=goal-driven-claude-code
```

服务端从 D1 返回 Pool 和 Namespace，Worker 不得自行提交或修改它们。D1 的 poll 只是候选；
真正的领取由带 fencing epoch 的 CAS accept 完成。续租、输入下载、分片上传和完成都再次
校验 Worker、Session、Attempt、lease token 和 fencing epoch。Redis 不可用时，Worker 仍然
可以继续 D1 poll；Redis 不是第二个任务状态源。

本地验收已实际验证这一降级路径：Relay `/v1/hints` 返回 503 时，v2 Worker 仍保持进程在线
并继续收到 D1 `poll 200`。若要恢复 Redis 唤醒提示，zhangbot 的 Relay Redis 用户必须由管理员
补充固定的 `infinity-public:*` 键模式和 Lua 脚本权限；不要把 Redis 管理密码放进 Worker。

## 4. 容器配置

生产 Compose 是仓库根目录的 `docker-compose.cloudflare-workers.yml`，模板是
`worker.cloudflare.env.example`。Windows 机器上的完整流程见
`docs/WORKER_ONBOARDING.md`：

```powershell
Copy-Item worker.cloudflare.env.example worker-b.cloudflare.env
# 填入管理员提供的 Worker ID、持久 credential、镜像 digest、Relay HTTPS 地址、
# hint token，以及批准的 ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / API Key 或 Auth Token。
docker login ghcr.io
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml pull
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml up -d
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

配置文件不得上传 GitHub。不要填写 PostgreSQL、`DATABASE_URL`、Redis admin URL、D1 管理
Token、R2 parent key、Namespace、Pool 或信任等级。

Claude provider 的三项配置只传给容器内的非 root Claude 子进程；Worker credential、Relay
hint token 和控制面地址不会传给 Claude。固定 Goal-Driven Prompt 位于
`backend/code_agent/worker/claude_runtime.py`，任务中的 Method/Dataset 是不可信输入，不能
覆盖平台目标、输出目录、权限边界或完成判定。

## 5. 当前实现文件

- Edge：`cloudflare-worker/src/worker-v2.ts`、`src/lease-recovery.ts`、`src/outbox-relay.ts`、
  `src/index.ts`。
- D1：`cloudflare-worker/migrations-infinity/0014_d1_worker_runtime.sql`。
- Worker 客户端：`backend/code_agent/worker/control_plane.py`、`consumer_v2.py`、
  `executor_v2.py`。
- Runtime：`backend/code_agent/worker/claude_runtime.py`。
- 镜像：`backend/Dockerfile.worker`。
- Relay：`backend/redis_relay.py`、`backend/Dockerfile.redis-relay`。
- 主架构和继续执行顺序：`docs/ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`、
  `docs/D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`。

旧的 `backend/code_agent/worker/consumer.py`、`executor.py`、`reaper.py`，旧的
`docker-compose.acceptance.yml` 和 PostgreSQL 测试只保留给历史回归/迁移参考，不能被新
Docker 镜像或 v2 生产路径调用。C5 完成后再按调用图做有目标的清理，不能把旧测试误当成
线上 Worker。

## 6. 已完成的远程动作

截至 2026-08-20：

1. 已将 `0014_d1_worker_runtime.sql` 应用到线上 D1 `infinity-agents-db`；已确认
   `worker_pool_policy`、`workers`、`worker_sessions_runtime`、`task_attempts`、
   `outbox_events` 和 Artifact multipart 表存在，策略为 `public-default / infinity-public`。
2. 已将 Edge Worker 和静态前端部署到 `infinity.zhangyvjing.com`，当前版本为
   `489d6721-1075-44cb-9b42-b77c233708a9`；`/health` 返回正常，未认证 v2、direct Task
   和凭证恢复路由不会放行。
3. 已在 zhangbot 用户目录安装 Relay，并交给用户级 systemd 管理；Redis 保持回环监听，
   Relay 健康检查通过，但当前 `/v1/hints` 因 Redis `api` ACL 键模式不匹配返回 503，
   等待管理员明确授权后修正共享服务 ACL。
4. 已使用公共 Worker 3 的持久 credential 完成 v2 `connect` 和 `poll` 协议验收；返回池、
   Namespace、协议能力正确，空队列返回 `next_poll_seconds=5`。换用不同 instance 的第二次
   connect 被正确拒绝，证明“一 credential 对应一个 active instance”规则生效。
5. D1 里原报告的 Task `4350c45b-fd0c-4771-b654-c6df32e95f9c` 仍真实存在，归属用户正确，
   但状态是旧链路留下的 `failed`，不是数据库不存在。
   只读追查其事件序列为 `task_queued -> task_claimed -> task_failed`；对应 Attempt
   `832d5c78-7990-4684-a5d9-76b6432bc22b` 只存在于历史 `worker_attempts` 表，在当前
   v2 的 `task_attempts` 表中不存在。因此它不能作为 v2 Attempt/Artifact 证据，也不能
   通过手工改状态重用；新的验收必须创建一条新的 queued Task 并由 v2 Worker 领取。
6. Task Center 直接创建已修正为调用 `/api/tasks/direct`；本地 43 个单元测试和 6 个
   Playwright 用例通过，线上未认证请求返回 `401 UNAUTHENTICATED`。
7. 已在本机用 `backend/Dockerfile.worker` 构建并启动 v2 Worker；Cloudflare D1 `connect`/
   `poll` 成功，Relay 503 和一次控制面 TLS 短暂 EOF 都不会再导致 Worker 退出；会话过期会
   自动重连，凭证错误仍会停止。对应回归测试覆盖了这些故障路径。
8. GitHub Actions `32355961608` 已成功发布最新修复后的 amd64/arm64 镜像；当前 v1
   manifest digest 为 `sha256:b0e0dcced7ddc0cc58e314e4aa49985a2a85cff7882ae69f7725d0febdf33e40`。

## 7. C5 尚未完成的部分

- 当前 zhangbot 没有 Docker，也不是 Worker 主机；它只运行 Redis 和 Relay。`infinity` 与
  `codex.mlamp.cn` 两个 SSH 目标当前不可达，因此还没有可执行 Worker 3 容器的远程主机。
- 当前 Tunnel 是 Quick Tunnel，域名为临时地址，适合本次链路验收，不是常驻生产入口；常驻
  Worker 上线前必须改为管理员控制的命名 Cloudflare Tunnel，并把地址更新到 Edge 和 Windows
  交接配置。
- 真实 Case 2/3 必须从网页/同源 Task API 创建 queued Task，使用真实 Method/Dataset，
  再由可达的 Docker Worker 调用 Claude Code 并上传 R2 Artifact。现有 Task 是失败历史记录，
  不能通过手工改 D1 状态伪造重试。
- 浏览器扩展和应用内浏览器都对线上域名返回客户端拦截，因而本次页面验收使用了 Edge API、
  D1 和 Relay 的协议级证据；不能把浏览器 UI 结果写成已通过。
- 修复后的 Worker 镜像已发布 GHCR；命名 Tunnel、真实 Case 2/3、浏览器 C6 和最终 C7
  code review 仍是发布门禁。

## 8. 交接给下一位执行者的顺序

1. 先取得真实 Worker 3 主机或让管理员在目标 Windows 机器启动 `worker-b`；不要在 zhangbot
   上安装 Docker，也不要碰现有 Redis 服务。
2. 用管理员签发的 Worker 3 credential 配置镜像和 Claude provider；同一 credential 不要在
   第二台机器并发启动。
3. 让用户在 Task Center 创建/提交真实 Case 2，记录 Task、Attempt、Worker、D1 事件、Relay
   hint、R2 object、大小和 SHA-256；确认目录清空后再跑 Case 3。
4. 关闭或恢复 Redis，确认 D1 Outbox 重试、Worker D1 poll 和任务终态不丢失；验证大结果走
   multipart、旧 lease 不能完成、取消不会发布 Artifact。
5. 配置命名 Tunnel，替换所有临时 Relay URL；随后才发布 GHCR、推送 GitHub 和执行最后的
   Cloudflare/浏览器验收。

## 9. 禁止的绕过方式

不要恢复 Chat Agent、不要创建一次性 token、不要让用户填写 Namespace/数据库/Redis、不要
让 Worker 直连 D1 管理接口或 Redis TCP、不要把 PostgreSQL 作为第二事实源、不要通过手工
改 D1 让 Case 变成 succeeded、不要把旧 PostgreSQL Case 2/3 结果当作当前 D1 架构通过。
