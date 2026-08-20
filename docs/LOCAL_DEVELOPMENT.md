# 技术架构与本地运行

> **2026-08-20 目标架构提示**：本页的PostgreSQL命令只用于旧本地实现。当前唯一目标见
> [`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`](./ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)：
> D1是Task事实源，R2保存文件，zhangbot Redis负责hint/presence/事件，Docker Worker通过
> Cloudflare Worker v2 HTTPS API访问D1/R2。

## 架构概览

```text
浏览器 / 本地客户端
        |
        |  same-origin REST + SSE
        v
Infinity Agents Worker（cloudflare-deploy）
        |----------------------|
        |                      |
   PaperAgent API        ImageJudge API
        |                      |
      D1 / OIDC          独立 D1 / KV / DO

本地开发时：
浏览器 -> Next.js frontend -> FastAPI backend -> PostgreSQL + PaperAgent tools
ImageJudge -> 独立 Qt 桌面程序
```

`main` 保存产品源码：`agent/`、`backend/`、`frontend/`、`image-judge/`、测试、脚本和文档。`cloudflare-deploy` 保留这些目录的同一份内容，并额外提供 `cloudflare-worker/` 以及 Cloudflare 部署配置。`agent-dev` 仅保留作历史分支。

PaperAgent 的会话和消息由当前运行环境的持久化数据库保存；生产环境使用 Infinity Worker 的 Agent D1。ImageJudge 使用独立资源，不与聊天数据共用数据库。登录由 Zhang Auth OIDC 负责。

## 本地运行 Web 产品

### 1. 启动 FastAPI 后端

```bash
pyenv shell Agent
pip install -r requirements.txt

export DATABASE_URL="postgresql://app_user:your_password@localhost:5432/app_db"
export MOONSHOT_API_KEY="your_api_key_here"

pyenv shell Agent
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
```

### 2. 启动 Next.js 前端

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:3000`。如果前端需要连接其他后端地址，可设置 `NEXT_PUBLIC_API_BASE`；默认使用当前页面的同源 API。

生产登录和会话 API 需要 Zhang Auth OIDC。不要把任何真实密钥提交到 Git；本地只通过环境变量提供 `MOONSHOT_API_KEY`、数据库连接和 OIDC 配置。

## 本地运行 ImageJudge

ImageJudge 是独立的 Qt 桌面程序，不会随 FastAPI 或 Next.js 自动启动。进入 `image-judge/` 后按该目录说明安装依赖并运行；模型 Key 由用户在程序中手动输入，程序不依赖系统钥匙串。

## 测试

```bash
# Frontend
cd frontend
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:e2e

# Python backend
cd ..
pyenv shell Agent
pytest -q
```

`cloudflare-deploy` 分支的 Worker 检查和部署命令见该分支的 [`cloudflare-worker/README.md`](https://github.com/Vist233/infinity_Agents/blob/cloudflare-deploy/cloudflare-worker/README.md)。
