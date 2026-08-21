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

## 三个产品区域

- **Analysis**：唯一主 Agent，负责论文研究、方法整理、执行文档和数据关联；
- **Task Center**：任务创建、状态、Attempt、Worker、事件和结果下载，不是第二个 Agent；
- **ImageJudge**：在本地使用参考图和自然语言规则处理图片批次，生成可复核的结构化分类结果，作为后续 Analysis 的数据输入。

## 本地架构

`main` 分支面向纯本地运行时：PostgreSQL 是 Task/Attempt/Worker/Session/Artifact 元数据
唯一事实源，Redis 负责通知和实时事件，FastAPI 后端提供控制面 API，Next.js 前端同源
代理。Worker 通过 HTTP 调用控制面 `/api/worker/v2/*`，不直连数据库。

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

详细说明见 [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)。

## Worker

Worker 在宿主机单独运行，需要提供 Anthropic API Key：

```bash
# 注册 Worker (API 需先启动)
bash scripts/enroll-worker.sh
# 将返回的 credential 填入 .env.local

# 启动 Worker
source .env.local
python -m backend.code_agent.worker.consumer_v2 "$WORKER_1_ID"
```

## 文档

- [本地开发与部署](docs/LOCAL_DEVELOPMENT.md)
- [交接文档](HANDOFF.md)
- [纯本地组件迁移图](docs/MAIN_LOCAL_COMPONENT_MAP_2026-08-21.md)
- [ImageJudge 桌面端](image-judge/README.md)
