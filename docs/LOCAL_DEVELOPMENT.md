# 本地开发与部署

> 最后更新：2026-09-28

## 架构

```text
浏览器 -> Next.js (127.0.0.1:3000) -> FastAPI (127.0.0.1:8008) -> PostgreSQL
                                                                    -> LOCAL_OBJECT_ROOT
单个 Worker -> HTTP 轮询 /api/worker/v2/* --------------------------^
```

PostgreSQL 保存 Session、Paper、Data Collection、Task、Attempt、Worker、事件和 Artifact 元数据；本地对象目录保存 PDF、数据集、Method 与结果字节。SSE 直接从 PostgreSQL 事件表补读，Worker 通过定时 HTTP 轮询恢复待领任务、过期租约和重启后的状态。

本地运行不需要 Docker、Redis 或独立消息队列。PostgreSQL 必须由操作系统原生安装并启动；启动器不会安装、启动或停止 PostgreSQL 服务。

### 平台范围

Attempt 工作区的 Python 应用层路径校验、归属标记、临时目录和 Claude 子进程环境不依赖 macOS 专用沙箱，按 macOS、Linux 和 Windows 的 Python 语义实现；当前回归验证在 macOS/POSIX 主机完成。`scripts/start-local.sh`、`stop-local.sh`、`destroy-local.sh`、`backup-db.sh` 和 `restore-db.sh` 依赖 Bash、POSIX `ps`/`kill`/`tar`，只作为 macOS/Linux（或等效 POSIX 环境）脚本验证，不是原生 Windows 启停器。

Windows 原生运行时需要手动完成等效流程：启动 PostgreSQL，设置 `.env.local` 中的连接、绝对 Windows 路径、`WORKER_CONTROL_PLANE_URL`、`WORKER_ID`、`WORKER_CREDENTIAL` 和 Claude provider 环境变量，然后运行：

```powershell
python -m backend.db_migrate
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008
# 另一个 PowerShell 窗口
python -m backend.code_agent.worker.consumer_v2 $env:WORKER_ID
```

当前范围没有经过验证的原生 Windows PowerShell 启停、备份或恢复实现；可以在 WSL 等 POSIX 环境使用 Bash 脚本，但这不等同于原生 Windows 验证。

## 前置条件

- Python 3.12+；可使用虚拟环境，项目开发者也可使用 `pyenv shell Agent`
- 本机 PostgreSQL，且 `pg_isready`、`psql`、`pg_dump` 在 PATH 中
- Node.js/npm（要启动前端时）
- Claude Code CLI（要执行任务时）
- 模型/API 凭证，仅写入 Worker 配置

## 一键启动

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cd frontend && npm ci && cd ..
cp .env.local.example .env.local
# 修改 DATABASE_URL，或填写 PG_HOST/PG_PORT/POSTGRES_*；确认本地绝对路径
bash scripts/start-local.sh
```

`scripts/start-local.sh` 会：

1. 检查 `pg_isready`、数据库连接和迁移；
2. 只为不存在且随后确认为空的 `LOCAL_DATA_ROOT`、`WORKER_WORK_ROOT` 创建归属标记，并检查 `LOCAL_OBJECT_ROOT`；已有 data/work 根必须有匹配标记，启动器不会接管或盖章已有数据，根之间不得互相嵌套；
3. 用当前已激活的 Python 运行 `backend.db_migrate`；
4. 启动 loopback API，若 `frontend/node_modules` 存在则启动前端；
5. 只有配置 `WORKER_1_ID` 与 `WORKER_1_CREDENTIAL` 时才启动唯一 Worker。

API、前端和 Worker 的 PID/log 文件在 `LOCAL_DATA_ROOT/.runtime/`。停止时：

```bash
bash scripts/stop-local.sh
```

停止脚本只停止本地 API、前端和 Worker，保留 PostgreSQL 与文件数据。

## Worker 注册与配置

API 启动后执行：

```bash
bash scripts/enroll-worker.sh
```

把返回值写入 `.env.local`：

```dotenv
WORKER_1_ID=public-worker-...
WORKER_1_CREDENTIAL=...
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=...
```

Worker 只访问 `WORKER_CONTROL_PLANE_URL`，不接触 PostgreSQL 连接串。没有 Relay、6379 服务或内存队列时，轮询、claim、租约续期、Artifact 分片上传和恢复仍由 PostgreSQL-backed API 完成。

## Attempt 工作区与执行安全

`WORKER_WORK_ROOT` 必须是明确的绝对目录。每个服务端生成的 `attempt_id` 只映射到一个直接子目录；Worker 创建归属标记以及 `input/`、`output/`、`spec/`、`work/`、`logs/`、`home/`、`tmp/`。应用自己的路径策略会拒绝相对穿越、绝对输入、非法组件和已存在的符号链接，并在 Artifact 收集和清理前再次检查边界。根目录外哨兵不应被这些应用操作删除。

Claude 直接以 `work/` 为 cwd，HOME、缓存、临时目录指向 attempt 内目录；Worker 不把控制面 credential、数据库连接串或 Relay 配置传给 Claude。Claude 通过 `--permission-mode`、`--tools`、`--allowed-tools` 使用自身权限机制，默认不传 `--dangerously-skip-permissions`。默认 `Bash(*)` 是可信本机科学任务执行所需的显式 allow-list，可通过 `CLAUDE_ALLOWED_TOOLS` 收窄。

重要限制：这不是 OS 级沙箱。Claude、Shell 或其子进程以当前用户权限运行，仍可能直接读取/修改 attempt 外的用户可访问路径；cwd、环境、提示词、路径检查和外部哨兵测试都不能证明恶意命令被系统拒绝，也不能完全消除符号链接竞态。当前范围不实现 macOS `sandbox-exec`、Docker、Windows Job Object、Linux namespace 或虚拟机隔离。不可信任务必须另行设计隔离方案。

## 备份与恢复

必须同时备份 PostgreSQL 和对象目录，不能只备份其中一项：

```bash
bash scripts/backup-db.sh
bash scripts/restore-db.sh \
  backups/pg-<timestamp>.sql.gz \
  backups/objects-<timestamp>.tar.gz
```

备份只接受带归属标记的 data 根及其直接 `objects/` 子目录，备份输出不能落在 data 根内。恢复前停止 API 和 Worker；恢复会预检完整的 PostgreSQL gzip、对象归档成员、路径穿越/符号链接/特殊文件，并先把 SQL 和对象归档解压到 data 根内的受控临时目录。数据库应用 schema 的重建和 dump 导入在同一事务中执行并启用 `ON_ERROR_STOP`；只有数据库恢复成功后才替换对象目录，因此数据库导入失败时会保留原数据库和原对象目录。数据库与文件目录不具备跨系统单一原子提交：若数据库已提交而对象目录替换或回滚失败，脚本会报错并尽可能保留旧目录，旧目录可能位于 `.restore-old-objects.*`；此时必须保持服务停止，人工核对并完成恢复/对账后再启动。恢复后先检查任务与 Artifact 数量，再重新启动服务。`scripts/destroy-local.sh` 会在二次确认后删除配置数据库和本地数据目录，PostgreSQL 服务本身不受影响。

## 健康检查与故障排查

```bash
curl http://127.0.0.1:8008/health
curl http://127.0.0.1:8008/api/health/local-runtime
```

`/health` 只反映 PostgreSQL 和本地对象目录；`/api/worker/health` 读取 PostgreSQL 中的 active Worker session。数据库不可用时启动器失败并给出连接错误，不会回退到远程服务或其他数据库。

| 问题 | 检查 |
|---|---|
| PostgreSQL 未就绪 | `pg_isready -h 127.0.0.1 -p 5432`，再核对 `DATABASE_URL` 或 `PG_*` |
| 迁移失败 | 查看数据库权限与 `infinity_runtime.schema_migrations` 校验和 |
| Worker 未领取任务 | 检查 `/api/worker/health`、`WORKER_CONTROL_PLANE_URL`、credential 和 Worker log |
| Claude 无法执行工具 | 检查 `CLAUDE_PERMISSION_MODE` 与 `CLAUDE_ALLOWED_TOOLS`；确认任务是可信本机代码 |
| 文件路径被拒绝 | 使用 attempt 内相对 object key；不要提交 `..`、绝对路径或符号链接 |

## 本地测试

```bash
eval "$(pyenv init - zsh)"
pyenv shell Agent
pytest -q

# 有真实 PostgreSQL 时运行 Worker v2 API/控制流集成验收；不需要 Claude 或模型密钥
LOCAL_RUNTIME_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/infinity_local \
  pytest -q tests/test_local_runtime_api.py

# 其他真实 PostgreSQL 集成组；跳过不计入验收
pytest tests/test_local_runtime_pg.py tests/test_task_integration_pg.py -v

cd frontend && npm run lint && npm run typecheck && npm run build
```
