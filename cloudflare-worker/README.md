# Infinity Agents Edge

本目录是 Infinity Agents 的 Cloudflare Edge：它承载同源登录、Analysis 会话、Task
Center API、Worker v2 控制/数据 API、D1/R2 访问和 ImageJudge API。它不是 Docker Worker
执行镜像；唯一生产 Worker 镜像是仓库根目录 `backend/Dockerfile.worker`。

## 唯一生产数据链路

```text
Cloudflare D1 = Task / Attempt / Worker / Event / Outbox / Artifact 元数据唯一事实源
Cloudflare R2 = Method / Dataset / Artifact 文件本体
zhangbot Redis = 可重建 hint / presence / 实时事件
Docker Worker = HTTPS 调用本 Edge + 容器内直接运行 Claude Code
```

D1 是 Cloudflare 自带的 SQL 数据库，使用 SQLite 语义。生产链路不使用 PostgreSQL、
Hyperdrive 或 `DATABASE_URL`，也不做 D1/PostgreSQL 双写。Docker Worker 不直连 Redis TCP，
而是通过 zhangbot 上受认证的 HTTPS Relay 获取可重建提示；真正的 poll、claim、续租、输入
读取、Artifact 上传和终态更新都由 Edge 的 D1/R2 API 完成。

## Edge endpoints

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/me`
- `/api/sessions/*` 和 `POST /api/chat`
- `/api/tasks/*`、`/api/task-specs/*` 和 `/api/datasets/*`
- `/api/worker/v2/*`
- `/image-judge/*`

旧 `/api/worker/v1/*` 明确返回 `410 LEGACY_WORKER_PROTOCOL_DISABLED`，不能被旧 Worker
静默接入。

## Worker v2

Worker 只使用服务端签发的持久 `WORKER_ID`、`WORKER_CREDENTIAL` 和固定 HTTPS 地址。池和
Namespace 由 D1 策略返回，统一为 `public-default / infinity-public`；Worker 配置不能提交
或覆盖它们。

```text
connect → heartbeat / poll → accept（lease + fencing）
→ 下载冻结的 Method + Dataset（各 25 MiB 上限）
→ 固定 Goal-Driven Prompt + Claude Code
→ R2 单对象或 multipart 上传
→ D1 校验并 finalize Artifact
→ 清空任务目录，继续等待下一任务
```

一个持久 credential 同时只允许一个 active instance；用户可以创建任意数量 Worker，但每个
实例必须使用服务器新签发的 ID/credential。普通用户不填写 Namespace、Pool、数据库、
Redis 地址、Provider 或信任等级。

## 本地/Windows Worker

使用根目录的 `docker-compose.cloudflare-workers.yml` 和
`worker.cloudflare.env.example`。配置文件只填写管理员提供的 Edge/Relay 地址、Worker
ID/credential、固定镜像 digest，以及 Claude 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`
和 API Key/Auth Token；不要填写 PostgreSQL URL、D1 管理 Token、R2 parent key 或 Redis
管理员密码。

```powershell
Copy-Item worker.cloudflare.env.example worker-b.cloudflare.env
docker login ghcr.io
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml pull
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml up -d
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

镜像不包含 Docker CLI、Docker daemon、Docker Socket、PostgreSQL/Redis 客户端或独立
Verifier。Claude Code 在容器内直接运行，任务成功、失败、取消、超时或失租后清理本地
任务目录；结果只通过 R2/D1 合同提交。

## 测试边界

Cloudflare Worker 的类型检查和单元测试覆盖 D1 状态机、credential、lease/fencing、Relay
合同和 multipart。历史 PostgreSQL acceptance 文件仅用于迁移/回归参考，不能作为当前 D1
架构的 Case 2/3 通过证据。真实 C5 必须使用 D1、R2、zhangbot Redis Relay、可达 Docker
Worker 和真实 Claude Code，并记录 Artifact 大小及 SHA-256。
