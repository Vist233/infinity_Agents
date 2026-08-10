# Cloudflare Worker 架构解析

## 1. 结论先行

当前 Infinity Agents 的 Cloudflare 版本是一个“Cloudflare 控制面 + 本地 Docker 执行面”的系统：

- Cloudflare Worker 是唯一公网入口，负责身份、任务事实、Worker 注册、租约和 Artifact 元数据。
- Cloudflare D1 是当前 Cloudflare 版本的任务事实库，R2 是输入和结果对象存储。
- Mac/Windows 上的 Docker Worker 才执行 Claude Code；它只拿自己的长期 Worker credential 和本机 Provider 配置。
- zhangbot 上的 Redis 保持现有服务，通过本地 SSH 隧道给本地 Worker 使用；Cloudflare Edge 不把 Redis 暴露成公网 binding。
- 一个 Namespace 可以对应多个不同 Worker ID；一个 Worker credential 同时只允许一个活动机器实例。
- 结果上传后先进入 quarantine；当前分支的结果发布服务完成 ZIP 完整性检查后才变成网页可下载的 published Artifact。
- 本轮“verify 部分不用”指不启动额外验收 Subagent；它不改变上述已部署的 Artifact 发布边界。

## 2. 总体拓扑

~~~mermaid
flowchart LR
  U[用户浏览器] -->|OIDC Cookie + CSRF| E[Cloudflare Edge Worker]
  E --> D[(Cloudflare D1)]
  E --> R[(Cloudflare R2)]
  E -->|SSE / JSON| U

  E -->|HTTPS Worker Control API| A[Mac Docker Worker A]
  E -->|HTTPS Worker Control API| B[Mac Docker Worker B]

  A --> C1[Claude Code CLI]
  B --> C2[Claude Code CLI]
  A -->|SSH 隧道 16379| Z[zhangbot Redis]
  B -->|SSH 隧道 16379| Z

  A -->|上传结果| R
  B -->|上传结果| R
  R --> Q[quarantine Artifact]
  Q --> V[结果发布服务]
  V -->|发布成功| D
  V -->|状态 published| R
  U -->|鉴权下载| E
  E -->|流式读取| R
~~~

### 2.1 为什么任务队列不画在 Redis 上

当前 Cloudflare Worker 版本的领取和租约使用 D1 控制 API；本地 Worker 对 zhangbot Redis 做连接检查并保留本机运行所需配置，但 Cloudflare Edge 不直接通过 Redis 分发任务。这样可以：

- 不把 Redis 地址、ACL 或命令能力暴露到公网；
- 不让 Cloudflare Worker 持有数据库/Redis 父凭证；
- 用 D1 的条件更新和 fencing epoch 保证同一 Attempt 不被旧 Worker 覆盖。

## 3. 组件职责

### 3.1 浏览器和前端

主要入口：

- Analysis：对话式任务意图和确认卡。
- Task Center：任务列表、任务详情、直接新建任务、折叠的 Add Worker 卡、Artifact 下载。
- Image Judge：独立的 /image-judge/* 命名空间和应用下载入口。

任务中心直接创建任务使用：

~~~text
POST /api/tasks/direct
agent_confirmation = false
submission_source = task_center
~~~

Analysis 对话创建任务仍可使用确认卡；两条入口最终都进入同一个 TaskSpec、Task、Attempt 和 Artifact 数据模型。

浏览器只保存会话 Cookie、页面状态和当前用户可见的 Worker 信息，不保存 D1、R2、Redis 或 Provider 主密钥。

### 3.2 Cloudflare Edge Worker

动态代码位于 cloudflare-worker/src/，负责：

- OIDC 登录、回调、会话和 CSRF；
- Analysis 对话和 SSE；
- TaskSpec、执行文档、数据集和任务 API；
- Worker 注册列表、创建、credential 查询、轮换和撤销；
- Worker connect、heartbeat、poll、offer、accept、Attempt heartbeat；
- Attempt 专属输入下载；
- 单请求 Artifact 上传和 R2 Multipart 上传；
- 用户鉴权的 Artifact 列表和流式下载；
- Image Judge 隔离命名空间。

Edge Worker 不负责执行 Claude Code、直接访问本地 Docker、直接连接 zhangbot Redis，或把数据库父凭证和 Provider Secret 下发到 Worker。

### 3.3 D1

D1 保存控制面事实：

- 用户和 OIDC 关联信息；
- task spec、method source、dataset snapshot；
- task、worker offer、worker attempt、task event；
- worker registration、session、credential hash/ciphertext；
- Artifact 的 object key、大小、checksum、status 和 manifest。

D1 不保存大文件本体。Artifact 二进制都在 R2。

### 3.4 R2

R2 保存 task-inputs 下的执行文档和数据集，以及 task-outputs/quarantine 下的执行结果。发布后的结果对象仍由服务端通过受保护的 Artifact API 读取。

R2 key 不直接暴露给浏览器。下载路径必须先根据当前用户查询 D1，再从 R2 流式返回。

### 3.5 本地 Docker Worker

本地 Worker 由 backend/code_agent/worker/cloudflare_worker.py 实现：

- 读取 CONTROL_BASE_URL、Worker ID、Namespace、长期 credential；
- 启动时检查本机到 zhangbot Redis 的连通性；
- 通过 HTTPS 反向握手；
- 轮询并接收 Offer；
- 下载 Attempt 输入；
- 在同一容器中直接运行 Claude Code；
- 打包、计算 SHA-256、上传 Artifact；
- 完成 Attempt 后清空任务目录；
- 默认将自身置为退出状态，Compose 按 restart: unless-stopped 开启下一轮生命周期。

本地容器只挂载两个 named volume：/worker-inputs 和 /worker-outputs。没有宿主 Docker socket，因此执行模型不是 Docker-in-Docker，也不是 Docker-outside-of-Docker。

### 3.6 结果发布服务

backend/code_agent/verifier_service.py 是当前分支中独立的结果发布服务：

- 没有 Worker credential；
- 没有 Provider key；
- 没有 Redis credential；
- 没有 Docker socket；
- 只读取待发布的 quarantine ZIP；
- 只在本地临时 volume 中做完整性检查；
- 通过独立控制接口将合法 Artifact 发布。

它不是 Agent，也不是 Subagent。它是当前版本“执行容器不能自我把结果标成网页成功”的权限边界。

## 4. 端到端时序

~~~mermaid
sequenceDiagram
  participant Browser as 浏览器
  participant Edge as Cloudflare Edge
  participant D1 as D1
  participant R2 as R2
  participant Worker as 本地 Worker
  participant Claude as Claude Code
  participant Publisher as 结果发布服务

  Browser->>Edge: 登录/创建任务/上传 method + dataset
  Edge->>R2: 写入输入对象
  Edge->>D1: 写入 TaskSpec、Task(queued)、幂等键
  Worker->>Edge: connect + heartbeat + poll
  Edge->>D1: 创建 offer
  Worker->>Edge: accept offer
  Edge->>D1: 原子 claim + fencing epoch
  Worker->>Edge: 下载 Attempt 专属资源
  Edge->>R2: 读取输入
  Worker->>Claude: 传入 Goal-Driven 执行上下文
  Claude-->>Worker: 写入输出目录
  Worker->>Worker: ZIP + SHA-256
  alt 结果 <= 20 MB
    Worker->>Edge: 单请求上传
  else 结果 > 20 MB
    Worker->>Edge: Multipart init/parts/complete
  end
  Edge->>R2: 写入 quarantine object
  Worker->>Edge: finalize(manifest, epoch)
  Edge->>D1: 记录 Attempt succeeded + Artifact quarantine
  Publisher->>Edge: 读取待发布队列
  Edge->>R2: 流式读取 quarantine ZIP
  Publisher->>Publisher: SHA/大小/ZIP/路径安全检查
  Publisher->>Edge: publish
  Edge->>D1: Task succeeded + Artifact published
  Browser->>Edge: 查询任务和 Artifact
  Edge->>R2: 流式返回结果 ZIP
~~~

## 5. 关键状态和 fencing

Task、Attempt、Artifact 的正常路径：

~~~text
Task:     queued -> claimed -> running -> succeeded
Attempt:  claimed -> running -> succeeded
Artifact: uploading -> quarantine -> published
~~~

每次认领都会生成新的 fencing_epoch。后续 heartbeat、资源下载、Artifact 上传、multipart 完成和 finalize 都带 epoch，并在 D1 中同时检查 Worker ID、Namespace、Attempt ID、Task ID、epoch、lease 未过期和当前状态。因此旧容器即使在网络恢复后继续运行，也不能覆盖新 Worker 已经接管的任务。

失败时 Attempt 可以是 failed、expired 或 cancelled；Task 根据 Attempt 次数和错误类型重新进入 queued 或进入终态；Artifact 只有 published 才能出现在用户下载 API。

## 6. 长期 Worker credential

新注册不是一次性签发：

~~~text
POST /api/worker-enrollments
{ "namespace": "infinity" }

=> worker_id
=> namespace
=> trust_level
=> worker_credential
=> credential_expires_at: null
=> persistent: true
=> one_time: false
~~~

服务端每次创建新的 Worker ID 和 credential；Namespace 是可复用执行范围。D1 只保存 credential hash 和加密副本。Worker API 只接受 HTTPS Bearer credential，connect 后再绑定短期 session lease。disconnect 或 lease 过期不会撤销长期 credential；轮换会立即使旧 credential 和旧 session 失效；revoke 会让后续认证失败。

信任等级来自已验证账号权限：

~~~text
superuser        -> owner_trusted
ordinary/student -> institution_trusted
~~~

不能通过浏览器 body 自己提交 trust level。

## 7. 结果大小和上传策略

当前本地 Worker 使用：

- 单请求阈值：20 MB；
- Multipart part：8 MB；
- Artifact 总上限：默认 2 GB，可由 Cloudflare 变量限制；
- 全量 ZIP SHA-256；
- Multipart 完成时检查 part 从 1 连续、总大小一致、R2 head 一致；
- finalize 时再做 Attempt、manifest、对象存在和 checksum 绑定检查。

Case 3 的线上结果约 30.7 MB，已经覆盖 Multipart 入口；Case 2 覆盖小结果单请求路径。

## 8. 本地 Mac 的实际运行链

~~~text
本机 zsh 环境
  ├─ ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
  ├─ ANTHROPIC_BASE_URL
  └─ ANTHROPIC_MODEL
        │
        └─ scripts/run_local_cloudflare_workers.sh
              ├─ SSH local forward: localhost:16379 -> zhangbot:6379
              ├─ 读取 Redis ACL（不打印）
              ├─ worker-a 容器
              │    ├─ /worker-inputs
              │    └─ /worker-outputs
              ├─ worker-b 容器
              │    ├─ /worker-inputs
              │    └─ /worker-outputs
              └─ verifier 容器（当前分支有本机 verifier env 时）
~~~

本地 Worker 配置中的 CONTROL_BASE_URL 是 Cloudflare Worker URL，不是 D1 SQL 地址。不要把 Cloudflare account token、D1 token、Redis password 或 Anthropic token 放入前端。

## 9. 安全边界和故障边界

凭证边界：

- 浏览器：OIDC session cookie。
- 本地执行 Worker：自己的长期 Worker credential。
- Provider：只在本机环境和执行容器中存在。
- Redis：只在本机/SSH 隧道一侧使用。
- 结果发布服务：独立 verifier token，仅用于发布接口。

恢复边界：

- 连接失败：Worker 重试 connect。
- session 过期：重新握手，不重新注册。
- offer 过期：任务继续留在队列。
- lease 过期：D1 回收 Attempt，按策略重试或 timeout。
- Claude Code 失败：Worker 报告失败，服务端保留错误码。
- R2 上传失败：不允许 finalize 成功。
- 发布服务停止：Artifact 保持 quarantine，恢复后再发布。
- 浏览器断线：任务继续执行；重新打开 Task Center 后从 D1/SSE 读取状态。

不做的事情：

- 不在 Edge Worker 中保存或执行本地 Provider。
- 不让 Edge 直接访问 zhangbot Redis。
- 不依赖宿主机 Docker socket。
- 不把大型结果转成一次性浏览器 Blob 再上传；Worker 直接到 R2。
- 不把本轮 Subagent 验收当作产品运行依赖。

## 10. 代码到职责映射

| 文件 | 职责 |
|---|---|
| cloudflare-worker/src/index.ts | Worker 路由组合、浏览器 API 和控制 API 入口 |
| cloudflare-worker/src/tasks.ts | Task、TaskSpec、Artifact、Worker 注册和用户权限 |
| cloudflare-worker/src/worker-control.ts | connect、heartbeat、poll、lease、Attempt、上传、finalize |
| cloudflare-worker/src/env.ts | D1/R2/认证/Provider 绑定声明 |
| backend/code_agent/worker/cloudflare_worker.py | 本地 Docker Worker 主循环 |
| backend/code_agent/worker/claude_runtime.py | 直接启动 Claude Code CLI |
| backend/code_agent/verifier_service.py | 当前分支的 quarantine ZIP 发布服务 |
| docker-compose.cloudflare-workers.yml | Worker A/B 和发布服务 |
| scripts/run_local_cloudflare_workers.sh | SSH 隧道、Redis ACL、容器启动 |
| cloudflare-worker/worker-client.mjs | Mac/Windows 的轻量连接、health、poll 客户端 |

## 11. 发布和回滚原则

发布顺序：

1. 在 cloudflare-deploy 分支准备前端静态输出。
2. 运行 Cloudflare Worker check/test。
3. 远程执行 D1 migrations。
4. 使用 Wrangler deploy。
5. 只读检查 health、页面 HTTP 状态和 D1 任务事实。
6. 需要时重启本地 Worker，让它们使用新的控制 API。

当前发布只覆盖 infinity-agents-edge。不创建新 Worker，不修改 main 的用户工作树，不把本地 Redis 迁移成 Cloudflare binding。

如果线上发布有问题，优先使用 Wrangler 的上一版本回滚/重部署能力；不要使用 git reset --hard 或直接删除 D1/R2 数据。先保留 task、Attempt、Artifact 和部署版本证据，再处理回滚。

## 12. 文档阅读顺序

1. 本文件：理解组件和边界。
2. HANDOFF.md：按照当前环境实际操作。
3. CLOUDFLARE_DEPLOYMENT_RUNBOOK.md：发布和线上检查。
4. WORKER_ONBOARDING.md：新机器加入。
5. LOCAL_DEVELOPMENT.md：只在回到旧 FastAPI/PostgreSQL 本地版本时阅读，不能拿它替代 Cloudflare 运行手册。
