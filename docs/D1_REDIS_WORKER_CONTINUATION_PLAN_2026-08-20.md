# D1 + zhangbot Redis Worker 续作实施计划

> 基线：`cloudflare-deploy@a89954d`
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

### 不能继续当作目标完成项

- PostgreSQL是唯一事实源；
- PostgreSQL RLS是生产权限边界；
- Docker Worker直连 PostgreSQL；
- PostgreSQL Outbox是目标队列源；
- P9 PostgreSQL Case 2/3等于目标架构通过；
- P10最终审查完成。

### C0–C4 已完成

- D1 canonical Task/Attempt/Worker/Event/Outbox/Artifact schema；
- 单一 `public-default / infinity-public` Worker 策略；
- `/api/worker/v2/*` HTTPS 控制/数据协议和 D1 条件 claim、lease、fencing、幂等；
- 本地固定合同的 zhangbot HTTPS Redis Relay 与 D1 outbox relay；
- Docker Worker 的 Redis hint + HTTPS D1/R2 客户端；
- `backend/Dockerfile.worker` 镜像边界、非 root Claude 子进程、multipart 上传和任务目录清理；
- Cloudflare Edge 53 tests、Python 328 passed / 45 skipped、镜像构建和边界检查。

### C5 已开始（远程预生产）

- 线上 D1 已应用 `0014_d1_worker_runtime.sql`，并确认 canonical 表及公共池策略；
- Edge Worker 已部署到 `infinity.zhangyvjing.com`，v2 `/connect` 与 `/poll` 已用公共 Worker 3
  持久 credential 通过协议级验收；
- zhangbot Redis Relay 已以用户级 systemd 运行，Redis 仍为回环监听；临时 Quick Tunnel 的
  `/health` 已通过；
- 不同 instance 复用同一 credential 会被拒绝，使用相同 instance 可恢复会话；
- 还没有把真实 Docker/Claude Worker 放到可达的远程主机，也没有把 Case 2/3 标记为通过。

### 尚未完成

- zhangbot Redis Relay 的远程部署和真实故障恢复；
- D1/R2/Redis真实 Case 2/3；
- C6 浏览器、Task Center、Worker UI 和移动端真实验收；
- C7 只读 Code Review、最终同一候选版本回归；
- 命名 Cloudflare Tunnel、GHCR 发布、GitHub 发布、真实 Docker/Claude Case 2/3、C6 浏览器
  验收和 C7 最终审查。

## 2. 顺序实施

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

### C5：D1/R2/Redis真实Case 2/3

工作：从网页/真实Task API上传Method+Dataset，使用线上 D1/R2、zhangbot Redis Relay 和
可达远程 Docker/Claude Code 执行；不能用手工 D1 插入或旧 PostgreSQL Worker。

验收：Case 2包含94序列统计和可解析Newick；Case 3包含QC、cluster、marker、UMAP和h5ad；Artifact hash一致；大结果走multipart；Worker目录清空并继续在线；无手工改库、Fixture Executor或mock冒充。当前阻塞仅是可达的远程 Worker 主机和真实输入/登录任务创建。

### C6：前端和浏览器

工作：Task Center只调用同源D1 API；Worker卡仅“创建/复制/轮换/撤销/状态”，不让普通用户填写Namespace和基础设施；真实Task URL、侧栏、登录态和手机布局保持正确。

验收：frontend unit/typecheck/lint/build、Cloudflare Worker test/check、真实浏览器创建任务和下载Artifact；不得请求`preview`或旧Worker v1。

### C7：最终审查、提交与发布门禁

主Agent先完成全量测试，再让一个只读子Agent检查多套代码、权限、状态机、Secret和浏览器。主Agent修复后重跑。每张卡写checkpoint并commit。

只有获得明确授权后才允许push、发布GHCR、迁移remote D1、部署Relay或`wrangler deploy`。

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
