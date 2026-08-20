# D1 + zhangbot Redis Worker 续作实施计划

> 最终 Cloudflare 运行时基线：`cloudflare-deploy@57f6fb9`（C7 发布与线上回归已通过）
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
- C7 已完成；下一执行入口是 C8 的 `main` 纯本地 PostgreSQL 计划。

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
  Relay `/v1/hints` 已恢复 200；受控 Redis 停止期间 D1 fallback 仍保持可用；
- 历史 Task `4350c45b-fd0c-4771-b654-c6df32e95f9c` 的 Attempt 只存在旧
  `worker_attempts`，不在 v2 `task_attempts`，不能复用；
- 导航只有 Analysis、Task Center、ImageJudge；Task Center 保留直接创建任务和 Worker 管理；
- 历史验收 Compose 的 Redis 密码已全部改为显式必填；
- 首次真实 Case 2 Task `424ff7da-6903-42e8-9a55-b09c20033ccf` 暴露了 R2 multipart
  分片稳定性问题；`e55aad5` 修复并部署后，新 Task
  `3666d0f1-4581-42e3-b81c-bf195288daa5` 通过；
- 成功 Attempt 为 `940b483b-a8e6-43ef-a5a5-0598c3872005`，Artifact 为
  `6cc37651-2bee-4803-a81c-04b6cfbd76fd`，1,234,445 bytes，SHA-256
  `1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`；
- 下载 ZIP、manifest、94 条序列统计、94-tip Newick、Worker 清理和继续在线均已验证；
- Case 3 由用户明确延期，状态为 `DEFERRED_BY_OWNER`，不是 PASS，也不再阻塞本轮继续 C5R/C6/C7。

### Cloudflare 收口结果

- C5R 已在授权后完成：Redis Relay ACL 最小修复、Redis 停止/恢复、D1 fallback、Outbox 重放、
  无重复 Attempt 与 Redis 内容边界扫描均已记录；
- Case 3 科学覆盖延期；必须作为 C7 残余风险记录，不能写成已通过；
- C6 已通过：真实登录 Chrome 完成 Analysis、Task Center、ImageJudge、Case 2 详情和 Artifact
  下载验收；旧超时由前一控制会话占用原标签页导致，不是产品或登录失败；
- C7 全量门禁、只读 Code Review、GHCR/Edge 发布和线上控制面回归已通过；
- 命名 Cloudflare Tunnel 已通过并完成切换：`relay.zhangyvjing.com`、Cloudflare healthy/4
  connections、Edge/Worker 均已使用命名地址，旧 Quick Tunnel 已停止；
- 正式镜像重启发现的 Session 外键缺陷最终由 `57f6fb9` + D1 `0016` 修复：过期重连创建新
  Session，历史 Attempt 仍引用不可变旧 Session；Worker connect 201、hints/poll/heartbeat
  持续 200。C7 已关闭，Case 3 仍是 `DEFERRED_BY_OWNER`。

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

### C5：Case 2 通过，Case 3 用户延期

Case 2 已满足真实 Task Center 创建、D1 Attempt、Claude Code、R2 multipart、下载哈希、科学
内容、工作区清理和 Worker 继续在线门禁，证据见
`evidence/IMPLEMENT-20260820-D1/C5/real-case2-retry1-20260820/checkpoint.md`。

Case 3 本轮不执行。它必须记录为用户接受的覆盖缺口，不能改写为 PASS，也不能删除原验收标准。
本轮从这里直接进入 C5R；若将来恢复 Case 3，仍须验证 QC、cluster、marker、UMAP、h5ad、
multipart、Artifact hash和清理。

### C5R：Redis Relay ACL与恢复

结果：已在授权后仅修复 zhangbot Redis `api` 用户对固定 `infinity-public:*` Relay 合同所需的
最小 ACL，并授予 Relay 所需 Lua 脚本权限。Relay hints恢复；Redis 停止时 D1 poll/heartbeat
仍可用；恢复后 10 条 pending Outbox 均一次发布且 Task Attempt 仍为 4；Redis 元数据扫描无
Method、Dataset、Artifact、用户内容或 Secret。证据见
`evidence/IMPLEMENT-20260820-D1/C5R/redis-acl-recovery-20260820/`。

### C6：前端和浏览器

工作：Task Center只调用同源D1 API；Worker卡仅“创建/复制/轮换/撤销/状态”，不让普通用户填写Namespace和基础设施；真实Task URL、侧栏、登录态和手机布局保持正确。

验收：frontend unit/typecheck/lint/build、Cloudflare Worker test/check、真实浏览器创建任务和下载Artifact；不得请求`preview`或旧Worker v1。

结果：**PASS**。真实登录 Chrome 已验证三项导航、直接任务创建界面、任务列表、Worker 管理、
真实 Case 2 详情与 Artifact 下载；下载 ZIP 的 SHA-256 与服务端记录一致且完整。线上移动 viewport
已显示工作区菜单入口；抽屉和未登录交互由本地 Playwright 11/11 覆盖。证据见
`evidence/IMPLEMENT-20260820-D1/C6/authenticated-browser-pass-20260821/`。

前两次调用超时的原因是旧 Infinity 标签页仍归属于已失效的浏览器控制会话。新控制器能发现但
不能 claim 该标签页；新建标签页后立即复用同一登录态成功。后续浏览器验收不得反复 claim 旧会话
标签页，应新建受当前会话管理的标签页。

### C7：最终审查、提交与发布门禁

主Agent先完成全量测试，再让一个只读子Agent检查多套代码、权限、状态机、Secret和浏览器。主Agent修复后重跑。每张卡写checkpoint并commit。

远程发布、GHCR、D1 迁移、Relay 部署和 `wrangler deploy` 必须保留可追溯的授权、版本和
checkpoint；当前分支的 GHCR、D1 迁移、Relay 和 Edge 部署已记录在对应证据中。

结果：**PASS**。最终 Edge 版本 `42b1ecaf-7a97-47d1-ae73-e6b4041fd900`；不可变 Worker
镜像 digest `sha256:c76aff2544dcbb93d641af5325ff694366b12d60585ec56c8037392668a89230`。
正式镜像首次重连揭示旧实现会删除被历史 Attempt 外键引用的 Session；最终 `57f6fb9` + `0016`
保留旧 Session 并为过期重连生成新身份，所有状态写入由 live Session CAS 约束。证据见
`evidence/IMPLEMENT-20260820-D1/C7/final-release-review-20260821/`。

### C6T：命名 Relay Tunnel

结果：**PASS**。zhangbot 用户级 cloudflared、远程管理 ingress、单层 DNS/TLS、Edge Secret、
Docker Worker hints/poll/heartbeat 均已验证。双层域名因真实 TLS 不通过而在切换前废弃；最终
唯一地址为 `https://relay.zhangyvjing.com`。证据见
`evidence/IMPLEMENT-20260820-D1/C6T/named-tunnel-pass-20260821/`。

### C8：Cloudflare收口后启动main纯本地版本

C7 已完成，最终线上版本、rollback commit、镜像 digest 与延期风险均已记录。C8 现在可以开始。
C8不在 `cloudflare-deploy` 内实现，而是严格按照
`POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md` 处理 `main`：以最终 Cloudflare
产品/UI/Worker合同为源，替换 D1/R2/Workers/Quick Tunnel 为 PostgreSQL、本地对象目录、
本地 API和本地 Redis，删除 Cloudflare活跃入口；不得把 D1和PostgreSQL做成双运行模式，
不得合并会恢复 Chat Agent 的旧 `origin/main` 内容。

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
