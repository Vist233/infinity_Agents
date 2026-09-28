# 技术架构与本地运行

> **历史架构提示**：下方的 D1/Redis/Worker 图仅用于理解旧实现，不是当前分支的交付
> 目标。`cloudflare-deploy` 当前只交付静态前端；任务与论文数据、执行和本地 API
> 运行在用户本地，Worker 配置仅保留作审计/回滚材料。

## 历史架构概览（不作为本分支交付）

```text
浏览器 / 本地客户端（历史）
        |
        |  same-origin REST + SSE
        v
Infinity Agents Worker（历史 cloudflare-deploy）
        |----------------------|
        |                      |
   PaperAgent API        ImageJudge API
        |                      |
      D1 / OIDC          独立 D1 / KV / DO

本地开发时：
浏览器 -> Next.js frontend -> FastAPI backend -> PostgreSQL + PaperAgent tools
ImageJudge -> 独立 Qt 桌面程序
```

`main` 保存产品源码：`agent/`、`backend/`、`frontend/`、`image-judge/`、测试、脚本和文档。`cloudflare-deploy` 保留这些目录的同一份内容，并额外保留历史 `cloudflare-worker/` 配置供回滚审计；当前分支的云端交付是静态前端，默认不部署 Worker。`agent-dev` 仅保留作历史分支。

历史 PaperAgent 会话和消息曾由 Worker/D1 保存；当前前端不再暴露 Paper Chat，Task/Papers 数据由本地运行时负责。ImageJudge 使用独立资源，不与聊天数据共用数据库。登录由 Zhang Auth OIDC 负责。

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

打开 `http://localhost:3000`。本地 Next.js 默认把 `/api/*` 和 `/auth/*` 代理到
`http://localhost:8008`；如果后端地址不同，设置 `API_PROXY_TARGET`。只有在明确提供
HTTPS API origin 时才设置 `NEXT_PUBLIC_API_BASE`。

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

`cloudflare-deploy` 分支不提供 Worker 部署命令；历史配置和检查边界见该分支的 [`cloudflare-worker/README.md`](https://github.com/Vist233/infinity_Agents/blob/cloudflare-deploy/cloudflare-worker/README.md)。
