# Infinity Agents

Infinity Agents 是面向生命科学研究的 Method-to-Result 工作台：从研究问题、论文方法和数据集，到可追溯的异步任务、Artifact 与 Task Center 结果。

## 本地架构

```text
浏览器 -> Next.js -> FastAPI -> PostgreSQL
                         |          （状态、元数据、事件）
                         -> 本地对象目录（PDF、数据集、结果）

单个本机 Worker --HTTP 轮询--> FastAPI
```

本地版的业务事实源只有 PostgreSQL；文件本体位于配置的本地对象目录。运行时不要求 Docker、Redis、Cloudflare、D1、R2 或独立消息队列。API、前端和 Worker 默认只监听回环地址。

平台边界：`backend/code_agent/worker/attempt_workspace.py` 的 Attempt 路径与进程环境策略按 macOS、Linux 和 Windows 的 Python 应用层语义编写；当前验证是在 macOS/POSIX 主机完成的。`scripts/*.sh` 是 Bash 启停、备份和恢复脚本，只支持 macOS/Linux（或等效 POSIX 环境），不是原生 Windows 启动器。

产品区域包括 Analysis、Papers、Data Collections、Task Center 和独立的 ImageJudge 桌面应用。

## 快速开始

前置条件：本机已安装并启动 PostgreSQL、Python（推荐 `pyenv shell Agent`）、Node.js、Claude Code CLI 和模型凭证。

```bash
pyenv shell Agent
pip install -r requirements.txt
cp .env.local.example .env.local
# 编辑 .env.local；DATABASE_URL 可直接填写，也可使用 PG_* 字段生成
bash scripts/start-local.sh
```

启动器会检查原生 PostgreSQL、迁移数据库，只为不存在且随后确认为空的数据/工作根创建归属标记，并启动 API；已有目录必须带匹配标记，启动器不会接管或盖章已有数据。若已安装前端依赖则启动 Next.js；若 `.env.local` 已配置 `WORKER_1_ID` 和 `WORKER_1_CREDENTIAL`，再启动唯一 Worker。

首次运行若尚未有 Worker：

```bash
bash scripts/enroll-worker.sh
# 将返回的 WORKER_ID/CREDENTIAL 写入 .env.local 的 WORKER_1_ID/WORKER_1_CREDENTIAL
bash scripts/start-local.sh
```

Windows 原生环境请手动执行等效步骤：先启动本机 PostgreSQL，设置 `DATABASE_URL`、`LOCAL_DATA_ROOT`、`WORKER_WORK_ROOT`、`LOCAL_OBJECT_ROOT`、`WORKER_CONTROL_PLANE_URL`、`WORKER_ID`、`WORKER_CREDENTIAL` 和 Claude provider 环境变量，再运行 `python -m backend.db_migrate`、`python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008`，另一个 PowerShell 窗口运行 `python -m backend.code_agent.worker.consumer_v2 $env:WORKER_ID`。当前仓库没有经过验证的原生 Windows PowerShell 启停/备份/恢复脚本；不要把 Bash 脚本的验证结果当作 Windows 原生启动验证。

常用操作：

```bash
bash scripts/stop-local.sh
bash scripts/backup-db.sh
bash scripts/restore-db.sh backups/pg-<timestamp>.sql.gz backups/objects-<timestamp>.tar.gz
bash scripts/destroy-local.sh   # 明确确认后才会删除数据库和本地文件
```

备份要求 `LOCAL_DATA_ROOT/.infinity-agents-root` 与 `LOCAL_DATA_ROOT/objects` 处于受控路径；恢复会先验证完整的 PostgreSQL gzip、拒绝对象归档中的路径穿越、符号链接和特殊成员，再在受控临时目录验证后替换对象目录。数据库重建和 dump 导入在同一事务中执行并启用 `ON_ERROR_STOP`，只有数据库恢复成功后才替换对象目录。数据库和文件目录不是单一跨系统原子提交：若数据库已恢复但对象目录替换或回滚失败，脚本会报错并尽可能保留旧对象目录（可能位于 data 根下的 `.restore-old-objects.*`），必须停留在停机状态人工核对和恢复后再启动服务。

详细配置、迁移和验收命令见 [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)。

## Worker 执行边界

Worker 为每个服务端生成的 Attempt 在 `WORKER_WORK_ROOT/<attempt-id>/` 下创建 `input/`、`output/`、`spec/`、`work/`、`logs/`、`home/` 和 `tmp/`。应用管理的下载、对象键、Artifact 收集和清理会规范化路径、拒绝 `..`/绝对路径/符号链接逃逸，并使用归属标记核对清理目标。

Claude 使用 attempt 作为 cwd，获得最小化环境和明确的任务提示；默认不使用 `--dangerously-skip-permissions`，而是使用 Claude 自身的 `--permission-mode`、`--tools` 与 `--allowed-tools`。默认 `Bash(*)` 是为了让可信科学任务执行生成脚本，仍然代表当前用户权限下的可信本机代码。

这些措施是应用层约束，不是操作系统级沙箱：任意 Shell、Claude 工具调用或子进程仍可能读取或修改当前用户有权限访问的 attempt 外路径，且无法完全消除并发符号链接替换竞态。不得把 cwd、提示词或越界测试当作“进程只能访问 attempt 目录”的证明；不可信任务需要另行设计 OS/虚拟机隔离。

## 开发约定

- PostgreSQL 是唯一持久状态源；任务通知和 SSE 直接读取 PostgreSQL 事件表。
- 不运行 GitHub Actions，不推送远端，除非用户另行授权。
- 运行 Python 前先执行 `pyenv shell Agent`。
