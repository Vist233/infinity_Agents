# D1 + zhangbot Redis Worker 续作实施计划

> 当前续作基线：`cloudflare-deploy@b6d82c4`（已只读核对 GitHub 远端）
> 权威架构：`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`
> 执行提示词：`D1_REDIS_WORKER_GOAL_DRIVEN_PROMPT_2026-08-20.md`
> 原则：复用已通过的单一 Docker/Claude Runtime；替换错误的 PostgreSQL控制面，不同时维护两套生产链路。

## 1. 当前真实进度

### 已完成并可复用

- 唯一 `backend/Dockerfile.worker`；
- 唯一 `backend/code_agent/worker/claude_runtime.py`；
- 固定 Goal-Driven Prompt和失败 marker；
- 无嵌套 Docker、Docker Socket或独立 Verifier；
- Worker protocol/runtime/image gate和单 active session思路；
- Method/Dataset冻结、25MB边界；
- Artifact streaming/multipart、checksum、manifest、ZIP和清理逻辑；
- Task详情真实 ID，禁止 `/api/tasks/preview`；
- 历史本地 PostgreSQL Case 2/3 只作为 Claude Runtime/Artifact 参考，不计入 D1 验收。

### 当前架构判定

- D1 是唯一事实源，使用 Cloudflare 原生 SQLite 语义；
- D1 的固定认证路由和条件更新是生产权限边界；
- Docker Worker 只通过 Worker v2 HTTPS API 读写 D1/R2；
- D1 Outbox 通过 zhangbot HTTPS Relay 发布可重建 Redis hint；
- 历史 PostgreSQL Case 2/3 不能替代 D1/R2/Relay 的真实验收；
- C7 最终只读审查尚未完成。

### C0–C4 已完成，不得重做

- D1 canonical Task/Attempt/Worker/Event/Outbox/Artifact schema；
- 单一 `public-default / infinity-public` Worker 策略；
- `/api/worker/v2/*` HTTPS 控制/数据协议和 D1 条件 claim、lease、fencing、幂等；
- 本地固定合同的 zhangbot HTTPS Redis Relay 与 D1 outbox relay；
- Docker Worker 的 Redis hint + HTTPS D1/R2 客户端；
- `backend/Dockerfile.worker` 镜像边界、非 root Claude 子进程、multipart 上传和任务目录清理；
- 最新复核为 frontend 44 tests、Cloudflare Edge 55 tests；此前 Python 328 passed / 45 skipped、
  镜像构建和边界检查证据继续有效。

### C5 已开始（线上 D1/R2 + 本机 Docker Worker）

- 线上 D1 已应用 `0014_d1_worker_runtime.sql`，并确认 canonical 表及公共池策略；
- Edge Worker 已部署到 `infinity.zhangyvjing.com`，v2 `/connect` 与 `/poll` 已用公共 Worker 3
  持久 credential 通过协议级验收；
- zhangbot Redis Relay 已以用户级 systemd 运行，Redis 仍为回环监听；临时 Quick Tunnel 的
  `/health` 已通过；
- 不同 instance 复用同一 credential 会被拒绝，使用相同 instance 可恢复会话；
- GHCR 已发布多架构镜像 `ghcr.io/vist233/infinity-agent-worker:v1`，生产模板已固定不可变
  digest；
- 本机 `infinity-agent-worker-b-v2` 已连接线上 v2 控制面；D1 `poll/heartbeat` 持续返回 200，
  Relay 503 不会使进程退出；
- 历史 Task `4350c45b-fd0c-4771-b654-c6df32e95f9c` 的 Attempt 只存在旧
  `worker_attempts`，不在 v2 `task_attempts`，不能复用；
- 导航只有 Analysis、Task Center、ImageJudge；Task Center 保留直接创建任务和 Worker 管理；
- 历史验收 Compose 的 Redis 密码已全部改为显式必填；
- Case 2/3 尚未标记通过，因为线上 D1 没有新的 queued Task。

### 尚未完成

- 取得共享服务修改授权后，修复 zhangbot Redis Relay ACL 并执行 Redis 停止/恢复和 Outbox 重放验收；
- D1/R2/Redis真实 Case 2/3；
- C6 浏览器、Task Center、Worker UI 和移动端真实验收；
- C7 只读 Code Review、最终同一候选版本回归；
- 命名 Cloudflare Tunnel（当前 Quick Tunnel 只能用于临时链路验收）；
- 真实 Docker/Claude Case 2/3、线上 C6 浏览器验收和 C7 最终审查；
- 命名 Tunnel。当前 Quick Tunnel 只能用于临时验收。

## 2. 顺序实施

> C0-C4 以下内容只用于说明已经通过的合同，不得重新执行或另写一套实现；当前执行入口是 C5。

### C0：冻结基线和迁移边界

工作：

1. 在干净 `cloudflare-deploy` worktree记录 `0ed4811`之后的真实HEAD；
2. 保留其他人的 untracked/dirty文件，不混入提交；
3. 列出所有 PostgreSQL生产入口、D1旧Task入口和Worker API；
4. 冻结唯一目标协议和D1 schema迁移图；
5. 建立 `evidence/IMPLEMENT-20260820-D1/` checkpoint。

验收：没有代码改动前就能回答每个入口“保留、迁移、删除”的唯一归属；不能出现两个active Task API或两个Worker Runtime。

### C1：D1 canonical schema和浏览器隔离

工作：

1. 将Task、Attempt、Worker enrollment/session、Event、Outbox、Artifact metadata收敛到一组D1 migration；
2. 把legacy trust/task class归一为public后删除或锁死；
3. Task创建使用D1 batch原子写Task、幂等、Event和Outbox；
4. 浏览器查询每条带`created_by/project_id`；
5. Worker数据查询不按Task owner过滤。

验收：migration从空库成功、旧fixture迁移成功、Alice/Bob不可见、Task+Outbox失败回滚、重复幂等不重复创建。

### C2：Worker v2 Control/Data API

工作：实现connect、heartbeat、poll、accept、renew、spec/input、artifact start/part/complete、fail/cancelled；所有路由只用D1/R2 binding和固定prepared query。

验收：

- credential hash认证；
- 同credential第二active instance拒绝；
- protocol/runtime/image不兼容拒绝；
- 任意数量Worker可创建；
- 普通用户请求不能带Namespace/Pool/Provider/trust；
- 两Worker并发accept只有一个`changes=1`；
- 旧lease/fencing不能续租、下载、上传或完成；
- Worker可领取其他用户Task，但不能列出任意用户数据。

### C3：zhangbot Redis Relay

工作：实现并测试最小非 Docker Relay；取得远程授权后再在 zhangbot 部署，接收签名的
opaque Outbox 事件并幂等 XADD；Docker Worker 使用窄 Relay hint 权限。

验收：

- Relay不接受raw command/key；
- 错签名、重放、越界namespace拒绝；
- Redis停止时D1 Task/Outbox不丢；
- Redis恢复后Outbox重放且不产生双Attempt；
- Redis清空后可从D1恢复；
- Redis中没有用户内容、Method、Dataset、Secret或Artifact。

### C4：Docker Worker切换到D1 HTTPS协议（已完成本地候选）

工作：保留唯一 Claude Runtime，把 consumer/executor 数据面从 PostgreSQL 切换为 Redis hint +
Worker v2 HTTPS API；生产镜像和 Cloudflare Worker surface 不再包含旧 PostgreSQL client、
RLS claim 或旧 trust 路由。历史测试/迁移依赖的文件先锁定，C5 后再按调用关系删除。

验收：生产镜像中无PostgreSQL连接要求；只有一个consumer、一个Runtime、一个Dockerfile和一个Worker协议；旧路由只允许明确410迁移响应，最终无调用者。

### C5：从当前阻塞点恢复真实 Case 2/3

前置条件：

1. 用户通过当前 Task Center 创建真实 Case 2 并提供 Task ID；
2. 本机 `infinity-agent-worker-b-v2` 仍在线；
3. 修复 Redis ACL 需要单独的明确授权，不得因为缺少授权停止 D1 fallback 的 Case 运行。

工作：使用线上 D1/R2、当前本机 Docker/Claude Code 执行；不能手工插入/修改 D1，不能复用
`4350...`，不能使用旧 P9 PostgreSQL Worker。先完成 Case 2 的 Task/Attempt/Artifact/哈希/清理
证据，再创建并完成 Case 3。Relay 仍为 503 时必须如实记录 fallback，不得宣称 Redis 门禁通过。

验收：Case 2 包含 94 序列统计和可解析 Newick；Case 3 包含 QC、cluster、marker、UMAP 和 h5ad；Artifact hash 一致；大结果走 multipart；Worker 目录清空并继续在线；无手工改库、Fixture Executor 或 mock 冒充。当前直接阻塞是新的真实 queued Task；Redis 完整门禁另受 ACL 授权阻塞。

### C6：前端和浏览器

工作：Task Center只调用同源D1 API；Worker卡仅“创建/复制/轮换/撤销/状态”，不让普通用户填写Namespace和基础设施；真实Task URL、侧栏、登录态和手机布局保持正确。

验收：frontend unit/typecheck/lint/build、Cloudflare Worker test/check、真实浏览器创建任务和下载Artifact；不得请求`preview`或旧Worker v1。

### C7：最终审查、提交与发布门禁

主Agent先完成全量测试，再让一个只读子Agent检查多套代码、权限、状态机、Secret和浏览器。主Agent修复后重跑。每张卡写checkpoint并commit。

远程发布、GHCR、D1 迁移、Relay 部署和 `wrangler deploy` 必须保留可追溯的授权、版本和
checkpoint；当前分支的 GHCR、D1 迁移、Relay 和 Edge 部署已记录在对应证据中。

## 3. 每卡固定检查

```text
正例 + 负例 + 集成测试
git diff --check
生产入口搜索
legacy/trust/PostgreSQL残留搜索
Secret扫描
checkpoint
git commit
```

任何测试skip不得算作通过；模型描述不得替代退出码；PostgreSQL旧验收不得替代D1目标验收。
