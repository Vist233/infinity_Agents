# 本地开发与部署

> 最后更新：2026-08-22（L5 一键本地部署）

## 架构概览

```text
浏览器 -> Next.js (port 3000) -> FastAPI (port 8008) -> PostgreSQL + Redis
Worker  -> FastAPI control plane (/api/worker/v2/*)
```

- **PostgreSQL 16**：Task、Attempt、Worker、Session、Event、Artifact 元数据唯一事实源
- **Redis 7**：通知、presence、实时事件（可重建，不保存持久数据）
- **FastAPI**：唯一 HTTP API，提供 Analysis、Task Center、Worker 控制面
- **Next.js**：前端，同源代理 API
- **Worker**：独立进程，通过 HTTP 调用控制面，不直连数据库

所有访问者共享 `local-admin` 用户，无需登录。

## 前置条件

- Python 3.11+（推荐 `pyenv shell Agent`）
- Node.js 22+
- Docker Desktop（用于 PostgreSQL 和 Redis）

## 一键启动

```bash
pyenv shell Agent
pip install -r requirements.txt
bash scripts/run-local.sh
```

首次运行会从样例生成 `.env.local`，并生成 URL-safe 的本地数据库密码。该命令会：

1. 启动 PostgreSQL 和 Redis（Docker named volumes 持久化）；
2. 迁移产品表及 Worker v2 本地状态机；
3. 创建本地对象存储目录；
4. 启动 FastAPI、Next.js 和本地 Worker；
5. 将日志和 PID 写入 `local-data/`，便于停止或排障。

打开 `http://localhost:3000`。停止全部本地服务而不删除数据：

```bash
bash scripts/stop-local-stack.sh
```

### 单独注册 Worker（可选）

```bash
# 注册 Worker（API 必须先启动）
bash scripts/enroll-worker.sh

# 将输出的 WORKER_ID 和 WORKER_CREDENTIAL 填入 .env.local
# 然后：
source .env.local
ANTHROPIC_API_KEY=sk-ant-your-key python -m backend.code_agent.worker.consumer_v2 "$WORKER_1_ID"
```

**注意**：模型 Provider 仅在实际执行研究任务时需要。它不属于本地启动、任务创建、
状态追踪或 Artifact 存储的前置条件。

### Deploying Workers on Windows

Workers can run on Windows machines that connect to the API server over the
local network. Each Windows Worker is a standalone Python process that polls
the control plane for work.

**Prerequisites on Windows**:
- Python 3.11+ installed and on PATH
- Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`
- Repository cloned locally (or at least the `backend/` package)

**Step 1 — Install Worker dependencies** (only `httpx` is needed):

```powershell
pip install httpx
```

**Step 2 — Register the Worker** (from the server where the API runs):

```powershell
# On the server machine (or from any machine with network access):
.\scripts\enroll-worker.ps1 http://<server-ip>:8008
```

This outputs `WORKER_ID` and `WORKER_CREDENTIAL`. Save them.

**Step 3 — Configure and start the Worker**:

```powershell
# Set environment variables for this session:
$env:WORKER_CONTROL_PLANE_URL = "http://<server-ip>:8008"
$env:WORKER_ID = "public-worker-xxxx"
$env:WORKER_CREDENTIAL = "xxxx"
$env:ANTHROPIC_API_KEY = "sk-ant-your-key"
$env:ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
$env:ANTHROPIC_BASE_URL = "https://api.anthropic.com"

# Start the Worker:
python -m backend.code_agent.worker.consumer_v2 $env:WORKER_ID
```

**Step 4 — Deploy a second Worker**:

Run the enrollment script again to get a second credential, then start
a second process with a different `WORKER_ID`:

```powershell
.\scripts\enroll-worker.ps1 http://<server-ip>:8008
# (save the new credentials)
$env:WORKER_ID = "public-worker-yyyy"
$env:WORKER_CREDENTIAL = "yyyy"
python -m backend.code_agent.worker.consumer_v2 $env:WORKER_ID
```

**Important**: The API server's `.env.local` must contain
`REDIS_NAMESPACE=infinity_local` (or `WORKER_PUBLIC_NAMESPACE`) for
Worker enrollment to work.

### Deleting All Workers

To revoke all Worker enrollments (e.g., before decommissioning or resetting):

```powershell
# PowerShell — revokes every registered Worker
.\scripts\delete-all-workers.ps1 http://<server-ip>:8008

# Bash equivalent:
bash scripts/delete-all-workers.sh http://<server-ip>:8008
```

This calls `POST /api/worker-enrollments/{worker_id}/revoke` for each
active Worker. Revoked Workers lose their next poll/heartbeat and disconnect.

---

## 日常操作

| 操作 | 命令 |
|---|---|
| 启动基础设施 | `bash scripts/start-local.sh` |
| 停止（保留数据） | `bash scripts/stop-local.sh` |
| 销毁（删除数据） | `bash scripts/destroy-local.sh` |
| 备份数据库 | `bash scripts/backup-db.sh` |
| 恢复数据库 | `bash scripts/restore-db.sh backups/pg-xxx.sql.gz` |
| 健康检查 | `curl http://localhost:8008/health` |
| 注册 Worker | `bash scripts/enroll-worker.sh` |

## 端口说明

| 服务 | 默认端口 | 环境变量 |
|---|---|---|
| PostgreSQL | 5432 | `PG_PORT` |
| Redis | 6379 | `REDIS_PORT` |
| FastAPI | 8008 | `API_PORT` |
| Next.js | 3000 | — |

如果本机已有 PostgreSQL 或 Redis 占用端口，修改 `.env.local` 中的端口变量和对应的 `DATABASE_URL` / `REDIS_URL`。

## 数据持久化

- PostgreSQL 数据存储在 Docker named volume `pg_data` 中
- Redis 数据存储在 Docker named volume `redis_data` 中
- `docker compose down` 保留数据；`docker compose down -v` 删除数据
- 定期使用 `scripts/backup-db.sh` 创建备份

## 测试

```bash
# 后端测试（不需要 Docker）
python -m pytest tests/ -q --timeout=30

# 需要 PostgreSQL 的集成测试
# 先启动基础设施，然后：
python -m pytest tests/test_local_runtime_pg.py tests/test_task_integration_pg.py -v

# 前端单元测试
cd frontend && npx vitest run

# 前端构建
cd frontend && npm run build
```

## 故障排查

| 问题 | 解决 |
|---|---|
| Docker 连接失败 | 启动 Docker Desktop |
| 端口被占用 | 修改 `.env.local` 中的端口 |
| 迁移失败 | 检查 `DATABASE_URL` 密码是否正确 |
| Redis 连接失败 | 检查 `REDIS_URL` 密码是否正确 |
| Worker 连接失败 | 确认 API 已启动，检查 `WORKER_CONTROL_PLANE_URL` |
