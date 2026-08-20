# main 纯本地组件迁移图

## 冻结来源

- 产品/前端/Worker 合同来源：`cloudflare-c7-final-20260821`（`be537fd`）。
- 旧远程 main：`pre-c8-origin-main-20260821`（`16396ed`），仅供恢复，不参与合并；其顶层提交恢复了 Chat Agent。
- 旧本地 main：`pre-c8-local-main-20260821`（`b5de906`），仅供恢复。
- 两条历史与最终 Cloudflare 历史没有共同祖先；禁止普通 merge、rebase 或 cherry-pick 整条旧 main。

## 组件归属

| 组件 | 处理 | 纯本地目标 |
|---|---|---|
| `frontend/` | keep + port config | 保留 Analysis、Task Center、ImageJudge；同源调用本地 FastAPI；无 Chat Agent |
| `agent/` | keep | Analysis 检索、论文阅读和执行文档整理 |
| `image-judge/apps/desktop/` | keep + port auth/config | 保留本地图像数据生产；删除 Cloudflare 专用登录依赖后使用本地服务配置 |
| `backend/app.py` | port | 唯一本地 HTTP API；保留 Analysis，新增等价 Worker v2 控制/数据面 |
| `backend/db.py` | replace task runtime | PostgreSQL 唯一事实源；新迁移不能直接信任旧 Task/Attempt 表 |
| `cloudflare-worker/src/worker-v2.ts` | reference then delete | 将最终 claim/lease/fencing/Session/Artifact 合同移植到 PostgreSQL 事务，不作为 main 活跃运行时 |
| `cloudflare-worker/migrations-infinity/` | reference then delete | 语义映射到 PostgreSQL migration；不保留 D1 双模式 |
| R2 数据面 | replace | 受控本地对象目录；防路径穿越、symlink、越权和部分发布 |
| `backend/code_agent/worker/control_plane.py` | keep | Worker 继续只调用 `/api/worker/v2/*`，不获得数据库或 Redis 凭证 |
| `consumer_v2.py` / `executor_v2.py` / `claude_runtime.py` | keep | 唯一长期 Docker Worker 和固定 Goal-Driven Claude Code Runtime |
| `backend/Dockerfile.worker` | keep | 唯一 Worker 镜像；无 DinD、Socket、Verifier 或任务子容器 |
| `backend/code_agent/outbox.py` | port | PostgreSQL Outbox 到本地 Redis；Redis 只存 hint/presence/realtime |
| `backend/redis_relay.py` / Tunnel | delete after replacement | 本地 API/Worker 不需要 zhangbot HTTPS Relay 或 Cloudflare Tunnel |
| `docker-compose.acceptance.yml` | reference then delete/replace | 旧 PostgreSQL v1/RLS 验收栈只作测试参考，不能成为生产 Compose |
| `docker-compose.local.yml` | replace | 唯一一键 Compose：PostgreSQL、Redis、API、frontend、任意数量 v2 Worker |
| `consumer.py` / `executor.py` / `reaper.py` / verifier | delete after v2 gates | 不得作为第二生产任务链复活 |
| `cloudflare-worker/`, Wrangler 和 CF deploy workflow | delete after local equivalents pass | 最终 main 无活跃 D1/R2/Workers/Cloudflare 部署入口 |

## 迁移不变量

1. PostgreSQL 是 Task、Attempt、Worker、Session、Event、Outbox、Artifact 元数据唯一事实源。
2. Redis 可清空、可停机，不得保存 Method、Dataset、Artifact、用户正文或 Secret。
3. 浏览器按 `created_by` 隔离；公共 Worker 跨用户领取，不按创建者过滤。
4. 一个持久 credential 对应最多一个 active instance；过期重连创建不可变新 Session。
5. 所有状态写入都用事务和精确 Session/Attempt/lease/fencing 条件再次校验。
6. Method 与 Dataset 各 25 MiB；大 Artifact 分片上传，最终校验整体大小、SHA-256、manifest 和 ZIP。
7. 任何本地替代能力通过前，不删除对应 Cloudflare 参考实现；通过后必须移出 main 活跃入口，不能保留运行时开关。

## 实施顺序

`L1 PostgreSQL schema/state machine → L2 FastAPI Worker v2 + local object store → L3 Redis Outbox → L4 frontend/auth → L5 one-command Compose → L6 Case 2/negative tests → L7 final review and main publish`。
