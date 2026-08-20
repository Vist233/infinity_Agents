# Infinity Agents — Cloudflare Deploy 交接文档

> 最后更新：2026-08-21
> 当前分支：`cloudflare-deploy`；C7 最终运行时代码：`57f6fb9`；已部署 Edge 版本：
> `42b1ecaf-7a97-47d1-ae73-e6b4041fd900`；不可变 Worker 镜像：`sha256:c76aff2544dc...`
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

本地验收已实际验证这一降级路径：Redis 短暂停止时，Relay `/v1/hints` 返回 503，但 v2 Worker
仍保持进程在线并继续收到 D1 `poll 200` 与 heartbeat `200`；恢复后 hint 重新返回 200。管理员已
为 Relay Redis 用户补充固定的 `infinity-public:*` 键模式和 Lua 脚本权限；不要把 Redis 管理密码放进 Worker。

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
- D1：`cloudflare-worker/migrations-infinity/0014_d1_worker_runtime.sql`、
  `0015_c7_runtime_hardening.sql`、`0016_immutable_worker_sessions.sql`。
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
   `09680075-63b3-41cf-8254-cfcf21772272`；`/health` 返回正常，未认证 v2、direct Task
   和凭证恢复路由不会放行。
3. 已在 zhangbot 用户目录安装 Relay，并交给用户级 systemd 管理；Redis 保持回环监听，
   Relay 健康检查和 `/v1/hints` 均通过。授权后仅扩展 Redis `api` 用户到固定
   `infinity-public:*` 键模式并授予 Relay 所需 Lua 脚本权限；没有轮换或暴露其他凭证。
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
   `poll` 成功，Redis 短暂停止时 Relay 503 和一次控制面 TLS 短暂 EOF 都不会再导致 Worker 退出；会话过期会
   自动重连，凭证错误仍会停止。对应回归测试覆盖了这些故障路径。
8. GitHub Actions `32355961608` 已成功发布最新修复后的 amd64/arm64 镜像；当前 v1
   manifest digest 为 `sha256:b0e0dcced7ddc0cc58e314e4aa49985a2a85cff7882ae69f7725d0febdf33e40`。
9. 当前导航源码只有 Analysis、Task Center、ImageJudge，没有 Chat Agent 入口；Task Center
   仍直接展示 `TaskCreationCard`、用户 Worker 管理和超级管理员公共 Worker 管理。
10. 历史 `docker-compose.acceptance.yml` 已删除 Redis 默认密码，所有 Redis ACL 密码都必须
    通过显式环境变量提供。该 Compose 仍是 PostgreSQL 历史验收栈，不是 D1 v2 生产路径。
11. 本机 `infinity-agent-worker-b-v2` 正在运行；最新日志出现 D1 `poll/heartbeat 200` 和 Relay
    `/v1/hints 200`。Redis 短暂停止时仍观察到 D1 `poll/heartbeat 200`，恢复后 D1 Outbox 的
    10 条 pending 记录均一次性发布，Task Attempt 总数保持 4，没有重复 Attempt。本机同时还有旧 P9 PostgreSQL 验收容器，它们不是当前 Worker，
    不得用于 C5 证据，也不得在没有用户授权时删除。
12. 修复 `e55aad5` 后，真实 Case 2 已通过当前 D1/R2/v2 Worker 路径：Task
    `3666d0f1-4581-42e3-b81c-bf195288daa5`、Attempt
    `940b483b-a8e6-43ef-a5a5-0598c3872005`、Artifact
    `6cc37651-2bee-4803-a81c-04b6cfbd76fd`；Artifact 为 1,234,445 bytes，SHA-256
    `1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`。下载 ZIP、
    manifest、94 条序列统计、94-tip Newick、清理和 Worker 继续在线均已验证。

## 7. Cloudflare C7 最终状态

- 当前执行主机已经是本机 Docker，不再等待远程 Worker 主机；
  `infinity-agent-worker-b-v2` 已连接线上 D1 控制面并持续轮询。zhangbot 仍只运行 Redis 和
  Relay，不在 zhangbot 安装 Docker。
- 命名 Tunnel `infinity-redis-relay-prod` 已完成生产切换，固定地址为
  `https://relay.zhangyvjing.com`；Cloudflare 状态 healthy/4 connections，zhangbot 用户级
  `infinity-cloudflared.service` 已启用，Edge 与当前 Docker Worker 均已改用该地址。旧 Quick
  Tunnel 进程已停止。
- 真实 Case 2 已通过。首次失败 Task `424ff7da-6903-42e8-9a55-b09c20033ccf` 继续保留为
  multipart/finalize 缺陷证据，成功证据只认修复后的新 Task `3666...`。
- Case 3 原本用于证明 Scanpy/大结果科学工作负载覆盖；用户已明确要求本轮跳过。它的状态是
  `DEFERRED_BY_OWNER`，不是 PASS。Cloudflare 收口可以继续，但 C7 必须把这项覆盖缺口写入
  最终残余风险，不能声称 Case 2/3 均已验证。
- C5R 已完成：Relay ACL 已在授权后最小化修复，Redis 停止/恢复、D1 fallback、Outbox 重放和
  无重复 Attempt 均已有证据。Redis 内容边界扫描仅发现 `infinity:` / `infinity-public:` 下的
  stream/string 元数据，stream 字段不含输入、Artifact、用户正文或 secret。
- C6 已在真实登录 Chrome 中通过：Analysis、Task Center、ImageJudge、真实 Case 2 详情、账户栏、
  Worker 管理和 Artifact 下载均已验证；下载 ZIP 与服务端 SHA-256 一致。此前两次超时是旧标签页
  被已失效的浏览器控制会话占用，新建标签页后立即成功，不是产品、登录或插件故障。
- C7 已完成代码、测试、发布和线上控制面回归。最终运行时源提交为 `57f6fb9`，Edge 版本为
  `42b1ecaf-7a97-47d1-ae73-e6b4041fd900`；不可变 Worker 镜像为
  `ghcr.io/vist233/infinity-agent-worker@sha256:c76aff2544dcbb93d641af5325ff694366b12d60585ec56c8037392668a89230`。
- 正式镜像首次重启暴露了历史 Attempt 外键阻止删除 Worker Session 的生产缺陷。中间修复
  `b232f97` 恢复了连接，但仍原地覆盖历史 Session；最终 `57f6fb9` + D1 `0016` 改为每次过期
  重连生成新的 `session_id/session_epoch`，旧 Session 保持不可变。正式 Worker B 已真实验证
  epoch 5 保留四个 Attempt 引用、epoch 6 新建、外键检查无错误，connect 201，命名 Relay hints、
  D1 poll 和 heartbeat 持续 200。epoch header 缺省兼容，显式旧 epoch 会被拒绝。
- C7 发布后的 Chrome 页面检查通道超时，但最终部署没有上传任何新静态资产；前端仍是 C6 真实
  登录 Chrome 与 C7 Playwright 11/11 已验证的同一 162 个资产。未用 mock 替代浏览器，最终证据
  由原 C6 登录验收、未变资产、线上 HTTP/API、D1 和真实 Docker Worker 共同组成。
- Case 3 仍为 `DEFERRED_BY_OWNER`，是唯一接受的科学覆盖缺口；它不是 PASS。

## 8. 下一阶段执行顺序

1. 不重做 C0-C7，不重建当前本地 Worker。以 `cloudflare-deploy@57f6fb9` 和 C7 最终 checkpoint
   作为 Cloudflare 产品合同源。
2. 将 Case 2 证据冻结为 PASS；将 Case 3 记录为用户明确延期，不再为本轮创建 Case 3 Task。
3. 保留已通过的 Redis 停止/恢复、D1 Outbox 重试、Worker D1 poll 和任务终态证据；不得把
   Redis 再次变更为事实源。
4. 保留已通过的 C6 真实浏览器证据；C7 后端热修没有改变静态资产。
5. 保留已通过的命名 Tunnel 证据；不要恢复 Quick Tunnel 或双层 Relay 域名。
6. 现在按照 `docs/POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md` 启动 C8：从最终
   Cloudflare 产品树构造 `main` 的纯本地 PostgreSQL + Redis + 本地对象存储版本，不 merge 会
   恢复 Chat Agent 的旧 `origin/main`，也不保留 D1/PostgreSQL 双运行模式。

## 9. 禁止的绕过方式

不要恢复 Chat Agent、不要创建一次性 token、不要让用户填写 Namespace/数据库/Redis、不要
让 Worker 直连 D1 管理接口或 Redis TCP、不要把 PostgreSQL 作为第二事实源、不要通过手工
改 D1 让 Case 变成 succeeded、不要把旧 PostgreSQL Case 2/3 结果当作当前 D1 架构通过。
