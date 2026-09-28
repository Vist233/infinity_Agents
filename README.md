# Infinity Agents

Infinity Agents 是面向生命科学研究的 Method-to-Result 工作台。它不是多个并列聊天
Agent，而是一条从研究问题、论文方法和数据到异步执行结果的完整链路。

## 产品闭环

```text
研究问题
→ Analysis 搜索、阅读和比较论文
→ 整理 Method Document 并关联 Dataset Snapshot
→ 用户确认，或在 Task Center 直接创建
→ PostgreSQL Task + Redis 通知
→ Docker Worker 内的 Goal-Driven Claude Code 异步执行
→ Artifact 上传、校验和发布
→ 用户在 Task Center 查看并下载结果
```

## 产品区域

- **Analysis**：论文研究、方法整理、对话会话和可追溯工具事件；
- **Papers**：本地 PDF 上传、页面文本/图片清单、Paper Profile 和失败可恢复状态；
- **Data Collections**：本地数据集上传、结构画像、能力标签和论文—数据可行性匹配；
- **Task Center**：任务创建、状态、Attempt、Worker、重试、事件和结果下载；
- **ImageJudge**：在本地使用参考图和自然语言规则处理图片批次，生成可复核的结构化分类结果，作为后续 Analysis 的数据输入。

## 本地架构

`main` 分支面向纯本地运行时：PostgreSQL 是会话、论文、数据集、Task/Attempt/Worker、事件和
Artifact 元数据的唯一事实源；受控本地对象目录保存文件本体；Redis 只负责 outbox 通知、presence
和可重建实时事件。一个 FastAPI 进程同时提供 Analysis、Papers、Data Collections、Task Center
和 `/api/worker/v2/*` 控制面，Next.js 通过同源代理访问它。Worker 通过 HTTP 调用控制面，不直连
PostgreSQL 或 Redis。

无需登录——所有访问者共享同一 `local-admin` 用户，适用于学校内网等局域网场景。

## 快速开始

```bash
# 1. 安装 Python 依赖
pyenv shell Agent
pip install -r requirements.txt

# 2. 复制并编辑环境配置
cp .env.local.example .env.local
# 编辑 .env.local 设置数据库密码

# 3. 启动基础设施 (PostgreSQL + Redis)
bash scripts/start-local.sh

# 4. 启动 API (终端 1)
source .env.local
uvicorn backend.app:app --host 0.0.0.0 --port 8008 --reload

# 5. 启动前端 (终端 2)
cd frontend && npm install && npm run dev
```

首次启动会应用 `backend/local_runtime/sql/0001_canonical_runtime.sql` 和
`0002_product_workspace.sql`。`0002` 将 Paper、Discovery、聊天事件和本地任务重试合同纳入
PostgreSQL；迁移带校验和，已应用的文件不能被静默改写。

浏览器入口为 `/`（Analysis）、`/papers`、`/data-collections` 和 `/task-center`。论文和数据集
处理在本地 API 内执行，失败会保留安全错误码和进度记录；没有远程 Cloudflare Processor 或远程
对象存储依赖。独立 Processor 协议默认不启用，只有在补齐显式的 session/attempt/fencing
凭证边界后才可接入。

详细说明见 [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)。

## Worker

Worker 在宿主机单独运行，需要提供 Anthropic API Key：

```bash
# 注册 Worker (API 需先启动)
bash scripts/enroll-worker.sh
# 将返回的 credential 填入 .env.local

# 启动 Worker
source .env.local
pyenv shell Agent
python -m backend.code_agent.worker.consumer_v2 "$WORKER_1_ID"
```

## 文档

- [本地开发与部署](docs/LOCAL_DEVELOPMENT.md)
- [交接文档](HANDOFF.md)
- [纯本地组件迁移图](docs/MAIN_LOCAL_COMPONENT_MAP_2026-08-21.md)
- [ImageJudge 桌面端](image-judge/README.md)
