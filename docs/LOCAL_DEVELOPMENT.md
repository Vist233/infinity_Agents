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

### 1. 配置环境

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，至少修改以下密码：
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `DATABASE_URL`（密码需与 `POSTGRES_PASSWORD` 一致）
- `REDIS_URL`（密码需与 `REDIS_PASSWORD` 一致）

### 2. 启动基础设施

```bash
bash scripts/start-local.sh
```

脚本会：
1. 启动 PostgreSQL + Redis（Docker named volume 持久化）
2. 等待健康检查通过
3. 自动运行数据库迁移（幂等）
4. 创建存储目录
5. 输出后续启动命令

### 3. 启动 API

```bash
source .env.local
uvicorn backend.app:app --host 0.0.0.0 --port 8008 --reload
```

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:3000`。

### 5. 注册并启动 Worker（可选）

```bash
# 注册 Worker（API 必须先启动）
bash scripts/enroll-worker.sh

# 将输出的 WORKER_ID 和 WORKER_CREDENTIAL 填入 .env.local
# 然后：
source .env.local
ANTHROPIC_API_KEY=sk-ant-your-key python -m backend.code_agent.worker.consumer_v2 "$WORKER_1_ID"
```

**注意**：`ANTHROPIC_API_KEY` 只在 Worker 进程中设置，不要写入 `.env.local` 的 API 配置段。

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
