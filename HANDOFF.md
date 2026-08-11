# Infinity Agents — Handoff / 交接文档

> 最后更新：2026-08-11
> 分支：`stepfun-agent-developing`
> 当前验证：后端全量回归 `279 passed, 44 skipped`，前端 Vitest `25 passed`、Playwright E2E `8 passed`，ruff、lint/typecheck 通过，Next webpack production build 通过；隔离 PostgreSQL RLS 凭证绑定、信任分级、租约领取/完成、无上下文探针通过。

> **当前权威实现**：Worker 使用 `backend/Dockerfile.direct-worker`，在 Worker 容器内直接启动 Claude Code；不挂载宿主机 Docker Socket，也不在容器内启动 Docker。网页任务接口使用登录会话与 CSRF，Worker 使用数据库保存摘要的持久凭证；凭证不是一次性 Token。远程 Worker 通过受凭证和租约保护的输入下载、产物上传接口与中心 API 交换文件。本文早期历史段落若与上述说明冲突，以当前代码、`worker.env.example` 和 `docs/WORKER_ONBOARDING.md` 为准。

---

## 1. 项目概述

Infinity Agents 是一个多智能体工作台，包含三条产品线：

| 产品 | 路径 | 说明 |
|------|------|------|
| **PaperAgent** | `/`（前端）+ `agent/`（后端） | 检索、阅读和整理论文（PubMed / Europe PMC / arXiv），OIDC 登录后使用 |
| **CodeAgent** | `/code-agent`（前端）+ `backend/code_agent/`（后端） | 基于 Claude Code 的科学数据分析任务执行引擎（Infinity Agent） |
| **ImageJudge** | `/image-judge`（下载页）+ `image-judge/`（桌面端源码） | 基于参考图的桌面图像分类工具，GitHub Release 分发 |

本文件重点记录 **CodeAgent 任务执行系统** 的架构与实现状态，以及 2026-08 生产加固后的运维要点。

---

## 2. 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js 14 (App Router), React, TypeScript, Tailwind CSS, Vitest + Playwright |
| 后端 | FastAPI, Python 3.11, asyncpg, SSE-Starlette |
| 数据库 | PostgreSQL（asyncpg 驱动；本地开发在 Docker 容器 `prisma-postgres-1`，端口 5450，trust 认证） |
| 任务队列 | Redis Streams (redis-py >= 5.0)；本地容器 `infinity-redis`，端口 6379 |
| 执行 | Direct Worker 容器直接运行 Claude Code；不挂载 `docker.sock`，不使用 Docker-in-Docker；Lease Reaper 使用独立数据库角色 |
| 认证 | OIDC/本地开发登录会话；Worker 使用每个 Worker 独立的持久凭证 |

---

## 3. 系统架构

```text
用户浏览器
    |
    | REST + SSE（/api/* 由前端 :3000 rewrites 代理到后端 :8000）
    v
FastAPI Backend (backend/app.py)
    |
    |--- Task API（创建/查询/取消/SSE/产物下载，会话 + CSRF 鉴权）
    |--- PaperAgent API + /ws/chat（OIDC + 每用户限流）
    |--- ImageJudge 下载页（纯静态，无后端）
    |
    +--- PostgreSQL（任务状态、事件、产物、Outbox）
    +--- Redis（Stream 队列 + SSE 事件流 + 心跳 + 限流计数器）
    |
    +--- Worker A / Worker B / ...（消费 Redis Stream，直接执行 Claude Code）
            |
            | 本地输入可直接读取；远程输入通过控制面下载
            |   claude --print <prompt>（Worker 容器内子进程）
            v
        产物收集 → 本地或控制面上传 → Verifier 验证 → Artifact 原子发布 → SSE 推送
```

### 数据流（任务创建 → 完成）

```
前端上传执行文档(method source) + ZIP 数据集 → POST /api/task-specs + /api/dataset-snapshots
  → POST /api/tasks（幂等性检查 + DB 插入 status=queued）
    → OutboxEvent 写入 outbox_events 表（pending）
      → OutboxPublisher 轮询 pending → 写入 Redis Stream `stream:tasks:execute`
        → Worker 消费 → try_claim_task (CAS 原子认领) → Direct Claude Code 执行
          → 本地收集或控制面上传 → Verifier 验证 → Artifact ZIP 原子发布
            → Task 状态 → succeeded/failed/cancelled/timeout
              → task_events 表 + Redis Stream → SSE 推送给前端
```

**可靠性要点（Outbox 模式）**：任务创建先写 DB，Redis 宕机时事件保持 pending，
Redis 恢复后 OutboxPublisher 自动排空——已用真实停机测试验证。
`/api/outbox/publish` 在 Redis 不可用时**返回 503 拒绝**，绝不静默标记 published（防丢事件）。

### Worker 水平扩展

新 Worker 节点先在任务中心签发唯一的 Worker ID/Namespace 和持久凭证，再配置
`worker.env` 指向中心 Redis、PostgreSQL/API 与模型服务。启动后自动加入 Redis 任务竞争队列，
CAS 租约保证同一任务只被一个 Worker 认领；凭证撤销后该 Worker 不能继续握手。详见
`docs/WORKER_ONBOARDING.md`。

---

## 4. 目录结构

```
infinity_Agents/
├── backend/
│   ├── app.py                          # FastAPI 主应用（PaperAgent + Task API + SSE）
│   ├── auth.py                         # OIDC: require_user / verify_websocket_token
│   ├── db.py                           # 数据库初始化 + 全部 schema（21 张表）
│   ├── db_rls.py                        # 请求/Worker/Outbox 上下文与连接池隔离
│   ├── Dockerfile.direct-worker        # Direct Worker 镜像（代码烘焙进镜像）
│   ├── code_agent/
│   │   ├── models.py                   # Task/TaskSpec 数据模型 + 状态机 TRANSITIONS
│   │   ├── task_service.py             # 服务层（CRUD、CAS claim、requeue、Outbox、Artifact）
│   │   ├── redis_client.py             # Redis 客户端（Stream/心跳/限流；断连时 fail-open）
│   │   ├── outbox.py                   # OutboxPublisher（lifespan 自动启动轮询）
│   │   ├── retry_policy.py             # 失败分类 + 指数退避(full jitter)
│   │   ├── verifier.py                 # 多级验证器（file/format/content/... + 领域规则）
│   │   ├── analysis_agent.py           # TaskSpec 生成（LLM，无 key 时降级 mock）
│   │   └── worker/
│   │       ├── consumer.py             # Worker 主循环 + 失败分类路由
│   │       ├── reaper.py               # 独立 Lease Reaper（专用数据库角色）
│   │       ├── direct_runtime.py       # Claude Code 直接运行器（取消 + 超时）
│   │       └── executor.py             # 执行编排（产物写入 ARTIFACT_STORAGE_ROOT）
├── frontend/
│   ├── app/
│   │   ├── page.tsx                    # 首页路由（PaperAgent 聊天）
│   │   ├── code-agent/
│   │   │   ├── page.tsx                # 任务创建（执行文档 + ZIP 数据集上传）+ 任务列表
│   │   │   └── tasks/[task_id]/        # 任务详情（SSE 实时事件 + 产物下载）
│   │   └── image-judge/page.tsx        # ImageJudge 示例 + 下载页（Windows/Linux 平台直链）
│   ├── components/chat/ChatWorkspace.tsx       # Analysis/Chat 共用工作区
│   ├── components/chat/MobileWorkspaceMenu.tsx # 移动端工作区抽屉
│   └── lib/                            # i18n.tsx（中英）、api/tasks.ts、runtime-config.ts
├── image-judge/                        # 桌面端源码 + 打包脚本
├── .github/workflows/imagejudge-package.yml  # Windows EXE + Linux DEB 打包发布
├── docker-compose.local.yml            # Redis + worker-a/b + outbox-publisher
├── worker.env.example                  # 远程 Worker 接入配置模板
├── docs/
│   ├── LOCAL_DEVELOPMENT.md            # 本地开发指南
│   └── WORKER_ONBOARDING.md            # Worker 接入 + 生产安全清单
├── tests/                              # 后端测试（23 个文件）
└── HANDOFF.md                          # 本文件
```

**注意**：旧的聊天室（`/ws/code`、`/ws/analysis`、`/api/code/sessions`）与
`/code-agent/analysis` 页面已在重构中删除，任务创建改由 `/code-agent` 页面的
"执行文档 + 数据集" 表单完成。

---

## 5. 数据库 schema

`backend/db.py` 的 `init_db()` 共 21 张表：

- **PaperAgent**：sessions, messages, paper_records, authorized_paper_refs,
  session_paper_links, session_uploaded_papers, paper_cache, paper_records_global,
  paper_cache_global, session_tool_calls, session_context_compression
- **Task 系统**（核心 9 张）：projects, task_specs, method_sources,
  dataset_snapshots, tasks, task_attempts, task_events, outbox_events, artifacts,
  idempotency_keys

### tasks 表关键字段

| 字段 | 说明 |
|------|------|
| status | draft / queued / claimed / running / succeeded / failed / cancelled / timeout |
| phase | RUNNING 子状态：preparing / executing / verifying / packaging |
| lease_owner / lease_token / lease_expires_at | CAS 租约三元组；终态保留租约标记至自然过期，数据面策略仍只允许 active claimed/running |
| attempt_count / max_attempts（默认 3） | 重试计数 |
| next_attempt_at | 退避重试的到期时间，claim 时要求 `<= NOW()` |
| error_message | 已 sanitize 的错误信息（≤500 字符） |

### task_attempts

每次执行一条记录：worker_id、attempt_index、container_id、exit_code、
failure_code（失败分类码）、failure_detail、token_usage。

### outbox_events

status: pending / published / failed；含 retry_count、last_error、next_attempt_at。
OutboxPublisher 只发布 pending；发布失败保持 pending 等待下轮。

### artifacts

artifact_id、storage_path、checksum_sha256、content_type；下载时受
`ARTIFACT_DOWNLOAD_ROOT` 白名单约束。

### method_sources（执行文档）

用户上传的执行方法文档（HTML/PDF 等自由格式），任务通过 `method_source_id` 关联。

---

## 6. 状态机

```
draft → queued → claimed → running → succeeded
          ↑          |          |
          |          |          +→ failed / timeout / cancelled
          |          +→ cancelled
          +← failed/timeout（可重试时 re-queue，带 next_attempt_at 退避）
```

**失败分类**（`retry_policy.py`）：
- 不可重试：`verification_failed`、`invalid_spec`、`dataset_invalid` → 直接 failed
- 可重试：`infrastructure_error`、`execution_error`、None → attempt_count < max_attempts
  时 requeue，延迟 = `random(0, min(5 * 2^attempt, 300))` 秒（指数退避 + full jitter）

**CAS 保护**：`try_claim_task` 原子 UPDATE（queued + 租约过期 + 退避到期）；
`requeue_task` / `update_task_status` 要求 `WHERE lease_token = $2`，防止过期 Worker
醒来后污染已被接管的任务。

---

## 7. 后端 API 端点

### PaperAgent（OIDC 鉴权：`require_user` / WebSocket token）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST/GET/DELETE | `/api/sessions[/{id}]` | 会话管理（POST 受限流保护） |
| POST/GET | `/api/sessions/{id}/uploads/papers` | 论文上传 |
| GET | `/api/sessions/{id}/messages` | 历史消息 |
| WS | `/ws/chat` | 聊天流（受限流保护：默认 3 次/分钟/用户） |

### Task API（浏览器使用 HttpOnly 登录会话 + CSRF）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects/default` | 默认项目 |
| POST | `/api/method-sources/upload` | 上传执行文档 |
| POST | `/api/task-specs` | 创建 TaskSpec |
| POST | `/api/dataset-snapshots/upload`、`/api/dataset-snapshots` | 数据集上传/登记 |
| POST | `/api/tasks` | 创建任务（支持 idempotency_key） |
| GET | `/api/tasks`、`/api/tasks/{id}` | 列表 / 详情 |
| POST | `/api/tasks/{id}/cancel` | 取消（运行中置 cancel_requested_at） |
| GET | `/api/tasks/{id}/events`、`/events/stream` | 事件列表 / SSE 实时流 |
| GET | `/api/tasks/{id}/artifacts`、`/api/artifacts/{id}` | 产物列表 / 下载 ZIP |
| POST | `/api/worker-enrollments` | 管理员签发持久 Worker 凭证 |
| POST | `/api/worker-enrollments/{worker_id}/revoke` | 撤销 Worker 凭证 |
| GET | `/api/worker/tasks/{id}/inputs/{kind}` | 按 Worker 凭证和租约下载 dataset/method |
| POST | `/api/worker/tasks/{id}/artifacts` | 按 Worker 凭证和租约上传结果 ZIP |
| POST | `/api/worker/poll` | 仅本地显式开发开关可用；部署环境返回 404 |
| POST/GET | `/api/outbox/publish`、`/api/worker/health` | 仅本地显式开关或管理员可用 |

### SSE 行为（`/api/tasks/{id}/events/stream`）

- 优先从 Redis Stream 读事件并按 `task_id` 过滤；Redis 不可用时回退 DB 轮询 task_events 表
- 支持 `last_event_id` 断点续传（前端自动重连）
- Redis 事件若已有数据库事件号，SSE ID 为 `redis_cursor|db:<task_event_id>`；Redis 故障时可无重复地切到 DB 游标
- 每 15 秒发送 `: keep-alive` 心跳注释；连接最长 2 小时后优雅关闭
  （`SSE_MAX_CONNECTION_SECONDS` 可调），前端重连不丢事件

---

## 8. Worker 执行流程

### 主循环（consumer.py）

```
run_worker(worker_id, db_pool, redis_client, docker_image)
  ├── ensure_consumer_group("stream:tasks:execute", "task-workers-v1")
  ├── _heartbeat_loop        — 每 15s 更新 Redis 心跳
  └── _process_next_task     — 循环
        ├── consume_tasks (XREADGROUP, block 5s)
        ├── try_claim_task (CAS)
        ├── execute_task (executor.py) + 后台取消检测协程
        │     ├── Worker 私有 scratch 目录接收输入并生成结果
        │     ├── 通过控制面下载输入并上传结果归档
        │     └── direct_runtime 启动 Claude Code，默认任务超时 12h
        ├── 失败 → _fail_or_requeue（按 failure_code 分类）
        └── ack_message (XACK)

dedicated reaper service
  ├── 每 10s 扫描过期租约
  ├── attempt_count < 3 → requeue（带退避 next_attempt_at）
  └── attempt_count ≥ 3 → failed
```

### 取消流程

用户取消 → DB 置 `cancel_requested_at` → Worker 后台协程检测 → `cancel_event` →
Claude Code 子进程 SIGTERM（30s 宽限）→ SIGKILL → 状态置 cancelled → SSE 推送终态。

### Redis 客户端与任务真相源

`redis_client.py` 对 API 侧连接故障返回安全默认值，任务状态仍以 PostgreSQL 为准；
任务投递依赖 Outbox 在恢复后补齐。Worker 在 Redis 断开时不会退回未经保护的数据库轮询，
而是重连并等待认证 Redis Stream。

---

## 9. 安全措施（2026-08 生产加固后）

| 项 | 状态 |
|----|------|
| 浏览器 Task API 使用登录会话 + CSRF；未认证部署默认拒绝 | ✅ `LOCAL_DEV_OPEN_TASK_API=1` 仅允许本地开发显式打开 |
| Worker 使用每个 Worker 独立的持久凭证，数据库只保存摘要，可撤销 | ✅ |
| `/api/outbox/publish` Redis 断连返回 503，不静默丢事件 | ✅ |
| Redis 可选密码（compose `REDIS_PASSWORD` → requirepass） | ✅ 生产必须设置 |
| paperAgent `/ws/chat` + `/api/sessions` 每用户 3 次/分钟限流 | ✅ fail-open；`PAPER_CHAT_RATE_LIMIT/WINDOW` 可调 |
| 错误 sanitize（路径/URI/凭证脱敏 + 500 字符截断） | ✅ `_sanitize_error` |
| Direct Worker 不挂载 Docker Socket/Docker-in-Docker，任务超时默认 12h | ✅ 仍需专用主机/账号承载 Claude Code |
| 产物下载白名单 + 禁符号链接 + 禁路径遍历 | ✅ `ARTIFACT_DOWNLOAD_ROOT` |
| LLM 密钥透传用 `-e NAME`（不进容器 argv） | ✅ |
| SSE 心跳 15s + 2h 连接上限 | ✅ |

**生产部署必配**（详见 `docs/WORKER_ONBOARDING.md` 安全清单）：
随机 `SESSION_COOKIE_SECRET`、`SECRET_STORE_KEK`、Redis 密码、数据库访问控制、
`WORKER_ENROLLMENT_ADMIN_USER_IDS`、`SUPERUSER_USER_IDS`，以及每个 Worker 的持久凭证。只有
认证角色为 `superuser`/`root` 或列在 `SUPERUSER_USER_IDS` 的用户能签发 full-trust Worker；
其他用户自动得到 general-trust，不能通过请求体或 worker.env 提升。PostgreSQL、Redis
不暴露公网；远程 Worker 还要配置 `WORKER_CONTROL_PLANE_URL`。

---

## 10. 环境变量

```env
# --- API 服务器 ---
DATABASE_URL=postgresql://postgres@localhost:5450/infinity_agents
REDIS_URL=redis://localhost:6379/0            # 带密码: redis://:pass@host:6379/0
SESSION_COOKIE_SECRET=<random-secret>          # acceptance/production 必须
SECRET_STORE_KEK=<random-key>                  # acceptance/production 必须
ARTIFACT_DOWNLOAD_ROOT=$(pwd)/workspace/task-outputs  # API 读控制面上传的产物
# PAPER_CHAT_RATE_LIMIT=3 / PAPER_CHAT_RATE_WINDOW=60 / SSE_MAX_CONNECTION_SECONDS=7200

# --- Worker（worker.env，见 worker.env.example）---
REDIS_URL / WORKER_DATABASE_URL / WORKER_ID / WORKER_CREDENTIAL
WORKER_ENROLLMENT_REQUIRED=1
WORKER_CONTROL_PLANE_URL=https://<central-api> # 远程输入/产物传输时需要
ANTHROPIC_API_KEY=<...>                        # 仅传给 Claude Code 子进程
ANTHROPIC_BASE_URL=<...>
ANTHROPIC_MODEL=<...>
ARTIFACT_STORAGE_ROOT=/workspace/task-outputs  # Worker 本地工作目录
# Local Compose Outbox/Reaper use separate OUTBOX_DATABASE_URL and
# REAPER_DATABASE_URL service logins; the API Worker gateway uses its own
# server-side WORKER_GATEWAY_DATABASE_URL.
```

**artifact 存储一致性**：每个 Worker 只使用自己的 scratch 目录；输入和结果统一
通过受凭证与租约保护的控制面传输，API 将归档绑定到当前租约后记录到中心数据库。
这样本机两个 Worker 也不会共享任务输入、输出或中间文件。

---

## 11. 本地运行

```bash
# 1. PostgreSQL（Docker 容器 prisma-postgres-1，端口 5450，trust 认证）
#    数据库名 infinity_agents，应用启动时 init_db() 自动建表

# 2. Redis + 两个 Direct Worker + Outbox（compose，配置来自 worker.env）
docker compose -f docker-compose.local.yml --env-file worker.env up -d --build

# 3. API 服务器
pyenv shell Agent
DATABASE_URL="postgresql://postgres@localhost:5450/infinity_agents" \
REDIS_URL="redis://localhost:6379/0" \
ARTIFACT_DOWNLOAD_ROOT="$PWD/workspace/task-outputs" \
uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload

# 4. 前端（:3000，rewrites 代理 /api/* → :8000）
cd frontend && npm install && npm run dev
```

远程 Worker 接入（只装 Docker + 填 worker.env）见 `docs/WORKER_ONBOARDING.md`。

---

## 12. 测试

```bash
# 后端全量（真实 Docker/外部服务测试仍按标记单独运行）
eval "$(pyenv init - zsh)"
pyenv shell Agent
DATABASE_URL="postgresql://postgres@localhost:5450/infinity_agents" \
REDIS_URL="redis://localhost:6379/0" pytest -q  # 279 passed, 44 skipped

# 前端
cd frontend && npm run lint                    # clean
npm run typecheck                              # clean
npm run test:unit -- --run                     # 25 passed（6 个文件）
npm run test:e2e                                # 8 passed
npm run build                                   # webpack production build passed

# 后端静态检查
ruff check backend                              # clean
# mypy backend 仍包含旧 PaperAgent/vendor 与第三方 stub 的类型债务，不能作为发布通过条件
```

### 关键测试文件

| 文件 | 覆盖 |
|------|------|
| `test_fault_injection.py` | 34 个韧性测试：Redis 宕机 Outbox、Worker 崩溃 Reaper、失败分类、CAS 竞争、错误脱敏、DB 断连、SSE 断流 |
| `test_rate_limit.py` | 11 个：窗口计数、用户/action 隔离、过期重置、fail-open、env 配置 |
| `test_concurrency_recovery.py` / `test_retry_and_recovery.py` | 并发 claim、租约恢复、退避重试 |
| `test_sse_reconnection.py` | SSE last_event_id 断点续传 |
| `test_db_rls.py` | API/Worker/Outbox 角色绑定、持久凭证注入、连接归还清理、无上下文拒绝 |
| `scripts/rls_roles.sql` + 隔离 PostgreSQL | 凭证绑定、账号范围 general/full 信任领取、终态提交、Reaper 回收、直接信任写入阻断 |
| `test_security.py` / `test_artifact_download.py` | 路径遍历、符号链接、白名单 |
| `test_regression.py` | case1/2/3 全链路（mock Docker；`@pytest.mark.integration` 为真实 Docker） |
| `frontend/app/image-judge/__tests__/page.test.tsx` | 下载直链、平台探测、推荐卡片 |

---

## 13. 关键设计决策

1. **Outbox 模式**：状态变更先写 DB outbox_events，OutboxPublisher 异步发布到 Redis
   Stream；Redis 宕机事件保持 pending，恢复后自动排空。**绝不**在未投递成功时标记
   published（503 显式失败优于静默丢事件）。
2. **CAS 租约**：认领/回写全部带 lease_token 条件的原子 UPDATE，杜绝双 Worker 竞争
   与僵尸 Worker 污染。
3. **Lease Reaper**：独立 `reaper` 服务每 10s 扫描过期租约，实现崩溃自动接管 + 退避重试；普通 Worker 不再重复扫描。
4. **Redis 与数据库分工**：Redis 承担队列/事件，PostgreSQL 保存任务真相；API 的 SSE
   可在 Redis 故障时回退数据库事件，Worker 不使用未认证的数据库轮询回退。
5. **持久 Worker 身份**：每个 Worker ID/Namespace 对应一个可撤销的持久凭证；同一
   Worker ID 重新签发会替换旧凭证，凭证不作为一次性任务 Token 使用。
   普通用户/学生签发 `general` Worker，只能处理该账号创建的任务；超级用户签发的 `full`
   Worker 才是跨账号的受控服务器执行层，Redis Namespace 必须与数据库 enrollment 一致。
6. **Worker 隔离与传输**：每个 Worker 使用独立 scratch 目录；通过认证控制面下载输入、
   上传结果归档，归档绑定到当前任务租约。
7. **幂等性**：`idempotency_keys` 表（24h 过期）+ ON CONFLICT DO NOTHING。

---

## 14. ImageJudge 发布流程

- 工作流 `.github/workflows/imagejudge-package.yml`：Windows PyInstaller EXE →
  `ImageJudge-windows-x64.zip`；Linux → 固定名 `ImageJudge-linux-amd64.deb`
- 打 tag `imagejudge-v*` 触发 release job，资产附到 GitHub Release
- 下载页（`/image-judge`）使用 `releases/latest/download/<固定名>` 直链，
  点击直接下载（不跳 GitHub 页面），自动探测平台并高亮"推荐"卡片
- **待办**：deb 改名后需发布新 tag（如 `imagejudge-v0.2.1`）才能让 Linux 直链生效

---

## 15. 已知问题与限制

1. **Analysis Agent（`analysis_agent.py`）保留为库**：`/ws/analysis` 端点已删除，
   `run_analysis_stream` 仅被单元测试使用；如需恢复对话式 TaskSpec 生成需重新接端点。
2. **真实 Docker 集成测试**：`test_regression.py` 的 3 个 case（`real_docker`）耗时长，
   常规运行用 `-k "not real_docker"` 排除，发布前建议手动跑一次。
3. **arxiv 网络测试**：依赖外部 API，偶发 HTTP 429，与本项目代码无关。
4. **数据库 RLS 是发布门禁**：`scripts/rls_roles.sql` 提供
   `infinity_api`/`infinity_worker`/`infinity_outbox` 三个数据面 `NOBYPASSRLS` 角色，
   以及仅用于服务器派生完全信任签发的 `infinity_trust_issuer` 和仅用于过期租约恢复的
   `infinity_reaper` 角色与策略；
   `backend/db_rls.py` 已把 HTTP 用户、Worker lease、Outbox publisher 的身份绑定到
   每次连接 checkout，并在归还前清除上下文。Worker 凭证摘要匹配后才产生有效
   `app.current_worker_id()`；`tasks_worker_update_guard` 在数据库层再校验 Worker 的
   claim/lease/state/attempt/artifact 变更；终态提交在租约窗口内完成，终态保留租约标记但不再开放数据面操作。
   隔离 PostgreSQL 上凭证绑定、general/full 信任和终态提交探针已通过。目标 acceptance/生产库仍必须由数据库管理员执行脚本并完成同样的负向探针，
   不能把现有开发库自动改角色；使用 `scripts/acceptance_prepare_db_logins.sh` 创建
   API、Worker gateway、Outbox、Worker-A/B、Reaper 的独立登录，再把对应
   `RLS_*_LOGIN_ROLE` 传给迁移脚本授予 `SET ROLE` membership，`scripts/acceptance_preflight.sh` 默认
   `ACCEPTANCE_REQUIRE_RLS=1`，会阻断缺少角色、membership、FORCE RLS 或策略的 acceptance 环境。
5. **Direct Worker 的权限边界**：Claude Code 在专用 Worker 容器内允许完整工具权限，
   因此 Worker 主机和凭证必须专用；如果把中心 Provider 密钥放进不受信的学生 Worker，
   Claude Code 在“全权限 + 可出网”边界内理论上可以读取并外传该密钥。当前实现不把它
   宣称为宿主机级安全沙箱；不受信 Worker 应改用 Attempt-scoped gateway 能力。
6. **未做 GB 级压力测试**：单文件/解压/产物有上限且采用流式写盘；Worker 产物上传已改为
   认证/租约预检后的原始 request body，避免 multipart 在鉴权前先 spool，但用户级总磁盘配额、
   长期产物清理和真实大文件链路仍需在部署环境验证。
7. **限流为固定窗口**：分钟边界处理论上限是 2×limit/分钟，满足基础用户场景；
   如需更严格可升级为滑动窗口。
8. **已有 13000/线上实例可能仍持有旧构建**：源码与隔离验收实例已通过，若浏览器
   仍看到旧的 PDF/English/旧导航，必须重新构建并重启对应服务；不能用旧进程的页面
   反推当前源码状态。
9. **Cloudflare 部署对象不在当前分支**：当前 `stepfun-agent-developing` 不包含
   `cloudflare-worker/`；相关实现只存在于 `origin/cloudflare-deploy`。在没有明确合并
   并重新验收前，不能把当前本地通过结果当作 Cloudflare 线上部署通过。
10. **布局验收基线**：Task Center 当前为“创建任务 → 任务管理 → Worker 设置”的纵向
    全宽结构；移动端抽屉分别保留 Analysis/Chat 会话操作、Task Center 任务列表和
    Image Judge 示例/下载入口。旧服务若仍显示左右两列或缺少抽屉内容，先确认构建版本。

---

## 16. 下一步行动（建议优先级）

1. **在目标 acceptance/生产库执行 RLS 迁移**：运行 `scripts/rls_roles.sql`，配置连接账号
   的 `SET ROLE` 权限，跑 preflight 和 Alice/Bob 负向探针
2. **整合 Cloudflare 分支**：确认 `cloudflare-worker` 的数据库/队列/对象存储协议后，
   在目标环境单独构建、部署和验收，不能直接沿用本分支状态
3. **发布 ImageJudge 新 tag**（`imagejudge-v0.2.1`）激活 Linux 下载直链
4. **生产部署**：按 `docs/WORKER_ONBOARDING.md` 安全清单配置会话/密钥、Redis 密码、
   数据库角色和管理员名单，验证远程 Worker 输入下载与产物上传
5. **端到端验证**：compose 起 worker → 真实任务 → 产物下载全链路
6. **性能验证**：10+ Worker 并发下 Lease Reaper / Outbox Publisher 表现
7. **监控**：outbox pending 堆积告警、worker 心跳丢失告警、限流触发统计

---

## 17. 最近变更历史

| 提交 | 说明 |
|------|------|
| `fe7fda9` | 生产加固五阶段：端点鉴权、限流、下载直链、artifact 统一、SSE 心跳 + 死代码清理 |
| `db0b84f` | 故障注入测试套件（34 个）+ Outbox SSE 事件丢失修复 |
| `038151a` | 代码审查修复：安全加固、jsonb 处理、状态机修正 |
| `9c2b817` | 任务链对齐设计：method sources、失败重试、Worker 接入 |
| `560ef4c` | StepFun 开发前的系统快照 |
