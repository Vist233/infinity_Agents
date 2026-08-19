# Infinity Agents Worker 架构、故障与整改详细报告

> 日期：2026-08-19
> 性质：现状审计与整改设计，不代表代码已经修复
> 范围：Task 后端、Docker Worker、Redis、PostgreSQL、Cloudflare、Goal-Driven Runtime、Artifact 回传
> 本报告不包含任何 Worker credential、Redis 密码或模型密钥。

## 1. 结论

当前系统不是“一套实现存在几个小 Bug”，而是三代互不完全兼容的 Worker 架构同时留在仓库、镜像、部署和文档中：

1. 旧本地架构：PostgreSQL 是事实源、Redis Streams 是通知队列，Worker 再启动子 Docker Job，并由 Verifier 决定成功；
2. 当前本地分支架构：Worker 容器直接连接 PostgreSQL/Redis，并在同一个容器里启动 Claude Code 子进程，但仍保留 Verifier、Attempt Gateway 和旧执行器兼容层；
3. 当前 Cloudflare 架构：Worker 只通过 HTTPS 调 Cloudflare Worker，D1 保存任务事实、R2 保存文件；Redis 只做连通性检查，不参与领取，Worker 不连接 PostgreSQL。

线上 Case 2 同时暴露了两个独立问题：

- 任务详情页把静态导出的 `preview` 当成真实 Task ID，因此页面显示 `Task not found`；
- 公共 Worker 调度不检查运行协议，旧 Windows Worker 抢走任务并报告 `WORKER_FAILURE`，真正要测试的 Mac Worker 3 没有执行该任务。

按照项目负责人最新要求，平台服务器、管理员电脑和学生电脑上的 Worker 必须统一进入
同一个 PostgreSQL/Redis 集群，目标架构应重新冻结为：

```text
Cloudflare 网页/入口
        |
        v
中央 Task API / 文件 API
        |------------------------------|
        v                              v
PostgreSQL（唯一任务事实源）       Artifact/Object Storage
        |
        +---- Outbox ----> Redis Streams（任务通知与实时事件）
                              |
                              v
                  长期运行的 Docker Worker
                  - 每容器一个 Worker 身份
                  - 直接连接 PostgreSQL + Redis
                  - 容器内直接启动 Claude Code
                  - 固定 Goal-Driven 平台提示词
                  - 只处理 Method + Dataset 两项输入
                  - 结果流式/分片上传到服务器
                  - 上传完成后清空任务目录
                  - 容器继续等待下一任务
```

不再区分可信 Worker 和不可信学生 Worker，也不保留另一套 HTTPS-only 调度协议。
超级管理员统一提供数据库、Redis、API、Provider、Namespace 和公共地址，并控制服务器
端 credential 签发；普通用户只能触发服务器签发 Worker credential，并查看该
credential 当前绑定 Worker 的状态。

这套权限模型只限制产品和控制面的配置权。学生如果控制 Docker 主机，就能读取容器内
Secret；因此“同一集群”必须实现为每个 Worker 一组最小权限、可撤销的 PostgreSQL、
Redis ACL 和 Provider 机器凭证，不能向学生机器复制全局管理员 Secret。

## 2. 本次审计依据

### 2.1 原始设计与执行文档

本次重新找到并核对了以下文档：

- `docs/MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`：单一开发模型的顺序实施、测试、checkpoint 和停止条件；
- `docs/LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md`：本地 PostgreSQL/Redis/Docker、Case 1/2/3、故障恢复和验收门槛；
- `docs/ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md`：Analysis、Task、Worker、Method + Dataset 两项输入和数据安全不变量；
- `docs/CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`：原始不可信学生 Worker 的 HTTPS-only 远程方案；
- `docs/PUBLIC_WORKER_IMPLEMENTATION_PLAN.md`：公共 Pool、共享 Namespace、独立 Worker ID/credential；
- 当前目标文件 `goal-objective.md`：25MB、取消 Verifier、长期 Cloudflare Worker、Case 2/3 等后续决定；
- `HANDOFF.md`：当前本地代码所宣称的实现状态。

### 2.2 当前代码与运行状态

审查了：

- `backend/Dockerfile.worker`；
- `backend/Dockerfile.direct-worker`；
- `backend/code_agent/worker/consumer.py`；
- `backend/code_agent/worker/direct_runtime.py`；
- `backend/code_agent/worker/executor.py`；
- Cloudflare 部署线中的 `backend/code_agent/worker/cloudflare_worker.py`；
- Cloudflare 部署线中的 `backend/code_agent/worker/claude_runtime.py`；
- `docker-compose.local.yml`；
- `docker-compose.acceptance.yml`；
- Cloudflare Worker 的任务路由、Worker Control API 和测试；
- 本机正在运行的 `infinity-agent-worker-b` 容器；
- 线上 D1 中 Case 2 的 Task、Event 和 Worker Session。

## 3. 已确认并需要记录的后端问题

### 3.1 P0：任务详情页使用了错误的 Task ID

受影响任务：

```text
Task ID: 4350c45b-fd0c-4771-b654-c6df32e95f9c
Title: case2_method
真实数据库状态: failed
```

Task 实际存在于 D1，创建者也与当前登录用户一致。`Task not found` 不是数据库记录丢失，也不是登录权限错误。

当前 Cloudflare 静态导出只生成一个动态路由壳：

```text
/task-center/tasks/preview/
```

当浏览器请求真实路径时，Cloudflare Worker 内部把静态资源请求改写到 `preview`。浏览器地址栏虽然仍是真实 Task ID，但 Next.js 内嵌的路由状态是：

```text
task_id = preview
```

前端 `TaskDetailClient` 直接使用 `useParams().task_id`，于是请求：

```text
GET /api/tasks/preview
```

API 正确返回 404，但页面把它表现为真实任务不存在。

现有测试只断言 Cloudflare Worker 确实请求了 `/preview/` 静态壳，没有在浏览器水合后断言 API 使用真实 Task ID，因此测试覆盖了错误实现，却没有覆盖用户链路。

整改：

1. 详情页在客户端从 `window.location.pathname` 提取真实 Task ID；
2. 当静态参数为 `preview` 时，在真实 ID 解析完成前不得请求任务 API；
3. 同时支持 `/task-center/tasks/<id>` 和兼容路径 `/code-agent/tasks/<id>`；
4. 新增真实静态导出浏览器测试，断言永远不请求 `/api/tasks/preview`；
5. 已失败的原 Task 修复后应显示 `failed` 和真实事件，而不是 `Task not found`。

### 3.2 P0：公共 Worker 没有运行协议准入检查

Case 2 的数据库事件为：

```text
task_queued
task_claimed by public-worker-96de75ed-340f-43d5-af26-16b81008c2fa
task_failed / WORKER_FAILURE
```

抢走任务的是旧实例：

```text
instance_id: external-windows-worker-1
capabilities: claude-code, python, zip
```

预期执行的 Mac Worker 3 为：

```text
worker_id: public-worker-75f39f88-f921-4929-9c8d-a9f0c1b57145
instance_id: local-mac-public-worker-3
capabilities: cloudflare-claude-worker-v1, posix, claude-code, ...
```

服务端虽然在 Offer 中返回 `required_runtime`，但它只是提示字段。`poll` 查询没有读取或过滤 `worker_sessions.capabilities_json`，旧客户端可以忽略该字段并领取任务。

整改：

1. 冻结 `worker_protocol_version` 和 `runtime_capability`；
2. connect 时保存并校验协议版本；
3. poll 前按活动 Session 强制校验兼容能力；
4. 不兼容 Worker 返回空 Offer 和明确的兼容状态，不能领取；
5. claim/accept 时再次校验，避免 poll 后协议变化；
6. 公共池调度还必须校验 pool、task class、protocol、namespace 和 active lease；
7. 增加“旧 Worker 在线但永远领不到新协议任务”的集成测试。

### 3.3 P1：Worker 失败信息退化为默认文本

当前任务只保存：

```text
Worker reported a failure
```

事件只保存 `WORKER_FAILURE` 和 Attempt ID。旧 Worker 没有上传具体 `error_message/error_code`，服务端也没有记录失败发生在哪个阶段。

整改：

- 失败协议固定字段：`stage`、`error_code`、`safe_message`、`retryable`、`runtime_version`；
- 日志和数据库信息必须脱敏，但不能全部退化为同一个默认句子；
- 至少区分 connect、download、checksum、Claude start、Claude exit、timeout、packaging、upload、finalize；
- Task 页面显示用户可理解的失败原因，详细诊断只对管理员可见。

### 3.4 P0：线上部署与 GitHub `cloudflare-deploy` 不可复现

本地 `cloudflare-deploy` 位于 `c2ad6e9`，比 `origin/cloudflare-deploy` 多 35 个提交。线上最后部署时间是 2026-08-14，线上页面包含本地新版本的 `preview` 静态壳行为，但 GitHub 同名远程分支仍停留在更早版本。

这意味着：

- 当前线上不是由 GitHub 同名分支可重复构建出来的版本；
- 直接从 GitHub 远程分支部署可能大规模回退；
- CI 无法对线上真实代码做持续验证；
- “本地通过、线上失败、远程源码又不同”会持续发生。

整改：先修复并完整验证，再把同一个 commit 推送到 `cloudflare-deploy`，以 commit SHA 和镜像 digest 部署；部署记录必须同时保存 Git SHA、Cloudflare version、Worker image digest 和 migration revision。

## 4. 当前 Docker 到底如何运行

### 4.1 本机实际容器

当前本机只有一个 Infinity Worker：

```text
container: infinity-agent-worker-b
image: infinity-agent-worker:cloudflare
image created: 2026-08-14
restart policy: unless-stopped
command: python -m backend.code_agent.worker.cloudflare_worker
volumes: /worker-inputs, /worker-outputs
Claude Code: 2.1.232
```

容器内没有遗留任务文件，当前输入和输出卷为空。

### 4.2 它现在真实执行的链路

```text
启动容器
→ 读取 Worker ID / Namespace / persistent credential / Claude 配置
→ 尝试 PING Redis
→ HTTPS connect 到 infinity.zhangyvjing.com
→ HTTPS heartbeat / poll
→ HTTPS accept Offer
→ 从 Cloudflare/R2 下载 Method 和 Dataset
→ 在同一容器内以非 root 用户启动 Claude Code
→ ZIP + SHA-256
→ 小文件单请求上传，大文件 multipart 上传
→ HTTPS finalize
→ 删除 input/output/archive
→ 继续 heartbeat/poll
```

它不连接 PostgreSQL；它也不使用 Redis 领取任务。Redis 仅被 `_redis_ping()` 检查。

当前日志还证明 Redis 隧道不可达：

```text
host.docker.internal:16379 connection refused
```

容器仍继续运行，说明实际环境把 Redis 设为可选。这与“每一步都不能错、Worker 必须直连中央 Redis”的目标不一致。

### 4.3 当前 Cloudflare Worker 中已经做对的部分

- 容器内没有 Docker CLI，不挂 Docker Socket，不使用 Docker-in-Docker；
- Claude Code 直接作为容器内子进程执行；
- Claude 子进程使用非 root 用户；
- Method 与 Dataset 分开下载并校验 size/hash；
- 平台拥有固定 Goal-Driven Prompt；
- Task 的 goal/research question 被写入冻结的 `task_spec.json`；
- 只打包 output 目录，拒绝 symlink，计算整个 ZIP 的 SHA-256；
- 超过 20MB 的结果使用 multipart；
- finalize 后清理 task root、output 和临时 ZIP；
- 容器默认不退出，继续等待下一任务；
- Worker credential 和 Provider credential 没有写进镜像。

### 4.4 当前 Cloudflare Worker 中没有做到的部分

- 没有直连 PostgreSQL；
- Redis 不参与任务通知/领取，而且当前 Redis 连接失败仍继续；
- 任务事实源是 D1，不是 PostgreSQL；
- capability 只上报、不强制；
- Goal-Driven Prompt 的行为测试很弱，主要是源码字符串断言；
- 没有用真实 Case 2/3 证明 Prompt、输入、Claude、上传、清理完整闭环；
- GHCR 镜像只写在文档里，没有构建并推送 Worker 镜像的 GitHub Actions；
- 镜像名仍是本地 `infinity-agent-worker:cloudflare`，不是可复现的 `ghcr.io/.../infinity-agent-worker:v1`；
- 当前镜像约 851MB，且没有 SBOM、签名、digest pinning 或发布门禁；
- 旧 Worker 可以和新 Worker 混在同一公共池竞争任务。

## 5. 当前本地 PostgreSQL/Redis Worker 实现

`stepfun-agent-developing` 中的 `backend/Dockerfile.direct-worker` 和 `consumer.py` 更接近项目负责人现在提出的统一直连模式：

```text
Worker 启动
→ asyncpg 连接 PostgreSQL
→ Redis Client 连接 Redis Streams
→ Redis 消费 task hint
→ PostgreSQL CAS try_claim_task
→ 获取 TaskSpec / Dataset / Method 元数据
→ 本地或控制面下载两个输入
→ 同一 Worker 容器内启动 Claude Code
→ 产物上传/登记
→ 更新 Attempt/Task
→ ACK Redis
```

但这套实现也不能直接作为最终版本，差距如下。

### 5.1 Prompt 不是要求的 Goal-Driven Prompt

`direct_runtime.py` 目前只生成一段简短提示：说明 Task ID、目录、把输入视为不可信数据，然后要求完成任务并写入 output。

它缺少 Cloudflare 版本已具备的完整协议：

- 固定 System Role；
- immutable inputs；
- plan → validate → dependency → scripts → execute → required outputs → report → completion 的阶段；
- 最大工具调用和每命令重试；
- BLOCKED_INPUT / DEPENDENCY_FAILURE；
- 不得静默改变科学参数；
- completion 不等于系统成功。

因此本地直连版和 Cloudflare 版虽然都叫 Claude Code Worker，实际 Agent 行为不同。

### 5.2 仍保留已经废弃的 Verifier

`executor.py` 仍执行：

```text
Claude done
→ verifying
→ _verify_outputs / FiveLevelVerifier
→ packaging
→ Artifact
```

这与项目负责人后来明确的“放弃 Verifier，上传结果后直接完成”冲突。相关状态、代码、测试、文档仍大量存在。

目标不是取消所有确定性检查，而是取消独立 Verifier 产品层。仍应保留：

- 当前 lease/fencing；
- Artifact object 存在；
- 上传大小；
- SHA-256；
- ZIP 基础完整性；
- manifest 与 task/attempt/worker 绑定；
- 只有当前 Attempt 可以 finalize。

### 5.3 Provider 方式与最新要求不一致

本地直连版要求 control plane 为每个 Attempt 签发 `ATTEMPT_GATEWAY_URL/TOKEN/MODEL`，不允许直接把机器管理员自己的 Anthropic 配置交给 Claude。

项目负责人后来要求所有 Worker 使用超级管理员提供的统一 Provider 配置，并在本机
`worker.env` 填写：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_MODEL
ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
```

普通用户不能自行修改 Provider。当前代码仍把本地 Attempt Gateway 和 Cloudflare 本机
Provider 两种方式混在一起；最终只能保留超级管理员配置的统一 Provider 注入方式。

### 5.4 Compose 不是“只加一个 Worker”的一键模板

`docker-compose.local.yml` 同时定义：

- 本地 Redis；
- worker-a；
- worker-b；
- outbox-publisher；
- reaper。

即使给 Worker 配远程 Redis，它仍依赖 Compose 中的本地 Redis 服务。它还固定 A/B 两个槽位，不符合“想创建几个就创建几个”。

目标应是一个参数化 `worker` 服务：一份 env 对应一个 Worker ID，用户可以用不同 project name/env 文件启动任意数量实例，而不是在 Compose 里复制 A/B/C。

### 5.5 多套 Dockerfile 和兼容执行器容易选错

当前至少存在：

- `Dockerfile.worker`：旧版会安装 Docker CLI；
- `Dockerfile.direct-worker`：本地 PostgreSQL/Redis Direct Worker；
- Cloudflare 线的 `Dockerfile.worker`：HTTPS/D1/R2 Worker；
- `Dockerfile.fixture-worker`：验收 Fixture；
- `docker_runtime.py`：旧嵌套 Docker 兼容路径；
- `direct_runtime.py`：本地简化 Prompt；
- `claude_runtime.py`：Cloudflare 完整 Goal-Driven Prompt。

同名文件在不同开发线上含义不同，是此前重复构建错镜像、启动错模块和测试错协议的重要原因。

## 6. 原始设计、后续决定与当前实现差距

| 项目 | 原始本地设计 | 原始远程设计 | 当前最新目标 | 当前实现 |
|---|---|---|---|---|
| 任务事实源 | PostgreSQL | D1 | 全部 Worker 统一 PostgreSQL | 本地 PG；线上 D1 |
| Redis | 队列/事件 | 私有 opaque hint | Worker 直接连接中央 Redis | 本地参与队列；线上只 PING |
| Worker 数据库访问 | 受限 PG role | 学生节点禁止直连 | 全部 Worker 使用窄权限 PG 身份 | 线上不连接 PG |
| 执行边界 | Worker 启动每 Attempt Job Container | 本地 Docker Job | 长期 Worker 容器内直接启动 Claude Code | Cloudflare 版符合；旧代码仍保留嵌套 Docker |
| 业务输入 | Method + Dataset | Method + Dataset | Method + Dataset | 两条实现都基本具备 |
| Prompt | Goal-driven | Goal-driven | 固定平台 Goal-Driven Prompt | Cloudflare 版较完整；本地版过简 |
| Provider | Attempt Gateway | Attempt Gateway | 超级管理员统一提供 Provider 配置 | Cloudflare 版本机配置；本地版强制 Gateway |
| Verifier | 必须 | 必须 | 已明确放弃 | Cloudflare 版已放弃；本地版仍保留 |
| Artifact | 验证后发布 | quarantine 后验证 | checksum/manifest/fencing 后直接发布 | Cloudflare 版基本符合 |
| 清理 | Attempt 后清理 | Attempt 后清理 | 上传后完全清理并继续循环 | Cloudflare 版符合 |
| Worker 数量 | A/B/C 示例 | 可扩展 | 任意数量、无两个上限 | Compose 仍固定槽位；控制面可多建 |
| Worker 身份 | 每机唯一凭证 | enrollment token 后机器身份 | 每个 ID 独立持久 credential | 线上已具备，但调度协议门禁缺失 |
| 公共 Pool | 后补设计 | trust/task class | 单一公共 Pool，无 Worker 信任分级 | 已有 pool，但旧 Worker 会抢任务 |
| Task Center 创建 | 原始设计只从 Analysis | 后来增加直接创建 | 直接创建 `agent_confirmation=false` | 不同开发线行为不一致 |
| 输入上限 | 需冻结 | 需冻结 | 每个 Method/Dataset 25MB | Cloudflare 变量为 25MB |
| GHCR | 未规定 | 可分发镜像 | `ghcr.io/<org-or-user>/infinity-agent-worker:v1` | 未发布、无构建工作流 |
| Case 2/3 | 真实 Docker Gate | 远程 Gate | 必须作为实际闭环测试 | 旧测试可跳过/走旧 runtime；线上 Case 2 失败 |

## 7. 为什么之前一直出现问题

### 7.1 没有先冻结唯一运行合同

数据库到底是 PostgreSQL 还是 D1、Redis到底是队列还是健康检查、Provider 是本地 Key 还是 Attempt Gateway、是否有 Verifier，这些属于架构合同，不应在实现中同时存在多个答案。

此前不断在现有代码上补“能连接”“能在线”“能上传”的局部能力，但没有先删除或隔离旧协议，因此每次测试可能命中不同链路。

### 7.2 镜像、服务端和 Worker 没有协议版本锁

服务端只给出 `required_runtime` 文本，Worker 可以忽略。没有：

- 强制 protocol version；
- 最低镜像 digest；
- capability gate；
- 旧协议 drain；
- 不兼容错误码。

结果就是旧 Windows Worker 和新 Mac Worker 能同时进入公共池，旧 Worker 先抢任务。

### 7.3 测试证明的是局部函数，不是产品闭环

典型问题：

- 静态路由测试只证明请求了 preview 壳；
- Prompt 测试主要检查源码中存在某个字符串；
- Worker 输入/Artifact 测试大量使用 MockTransport 和 Fixture Executor；
- Case 2/3 的 real Docker 测试通常被 skip；
- 旧 Case 测试调用的是 `docker_runtime.py`，不是线上 `cloudflare_worker.py + claude_runtime.py`；
- 没有测试“旧 Worker 在线、新 Worker 在线时任务只能发给兼容 Worker”；
- 没有从网页创建任务、真实 Worker 领取、Claude 运行、上传、页面下载的一次完整测试。

### 7.4 部署发生在推送之前，线上无法从仓库重建

线上从本地未推送 commit 部署，GitHub 同名分支落后 35 个提交。此后任何人根据 GitHub 检查、构建或回滚，面对的都不是线上代码。

### 7.5 文档没有随最新产品决定统一

原始权威文档仍把 Verifier 作为唯一成功闸门、把 Task Center 定义为只读历史，并禁止远程 Worker 直连数据库；后续目标又要求取消 Verifier、Task Center 直接创建、统一 Worker 使用超级管理员提供的 Provider。代码分别实现了其中一部分。

没有一个“当前架构决议”覆盖旧文档，导致开发者每次都可能引用正确但已经过期的章节。

### 7.6 Redis 故障被降级为可选，掩盖了链路未完成

当前容器 Redis 连不上 `host.docker.internal:16379`，仍可 connect 到 Cloudflare 并显示在线。在线只证明 HTTPS 心跳存在，不证明中央 Redis、任务领取和执行链路正确。

如果目标要求 Redis 是任务通知层，启动时 Redis 不可达必须显示 `degraded/not-ready`，并且不得被 Task Center 标成可接受任务的健康 Worker。

## 8. 建议冻结的目标架构

### 8.1 适用边界

平台自有服务器、项目负责人电脑和学生电脑上的 Worker 全部使用同一架构、同一集群和
同一运行能力。安全性依靠每个 Worker 独立 credential、窄权限数据库身份、Redis ACL、
lease/fencing 和 Artifact finalize，不依靠学生/管理员信任标签。

超级管理员统一维护并提供 PostgreSQL、Redis、Server API、Provider、Namespace、Pool 和
公网地址。普通用户只能请求服务端生成 Worker ID/credential，并查看其绑定 Worker 的
状态；不能通过创建接口更改任何集群配置。`created_by` 只做审计和状态可见性，不形成
用户私有 Worker Pool。

### 8.2 中央服务

PostgreSQL 是唯一事实源，保存：

- TaskSpec；
- Method/Dataset 元数据和 hash；
- Task；
- Attempt；
- Worker registration/session；
- lease/fencing；
- Task Event；
- Artifact metadata；
- idempotency/outbox。

Redis 只保存：

- task hint；
- consumer group pending 状态；
-实时事件；
- Worker presence；
- 短期缓存。

Redis 丢失后从 PostgreSQL Outbox 重建，不能丢 Task。

Cloudflare 负责：

- 静态网页；
- OIDC/Cookie；
- 同源 API 入口或到中央 API 的受控代理；
- 可选的 R2 Artifact/Object Storage。

运行服务也应容器化并拆开职责：Task API、Outbox Publisher、Lease Reaper 和每个
Worker 分别运行在自己的容器中。PostgreSQL/Redis 可以是受保护的中心服务，但不能
在每台 Worker 电脑上重复启动一套。所有 Worker 使用同一协议连接中心服务。

Cloudflare D1 不再保存第二套 Task/Attempt/Artifact 状态。可以保留不与任务状态冲突的边缘会话数据，但 Task 真相必须只有 PostgreSQL 一份。

### 8.3 Worker 容器

每个容器：

- 一个服务端生成的 Worker ID；
- 一个共享或用户 Namespace；
- 一个独立持久 credential；
- 一个稳定 instance ID；
- 一个受限 PostgreSQL Worker login；
- 一个受限 Redis ACL user；
- 本机 Anthropic Base URL/model/key；
- 一个固定的协议版本和镜像 digest。

容器不包含：

- Docker CLI；
- Docker Socket；
- Docker-in-Docker；
- 编译时写入的密钥；
- Cloudflare parent token；
-数据库管理员凭证。

### 8.4 单任务时序

```text
1. Worker 启动，校验配置、Claude 版本、PG、Redis、API、credential。
2. Worker 注册 Session，报告 protocol/capabilities/image digest。
3. Redis 收到 task hint。
4. Worker 回 PostgreSQL 用 CAS + protocol/pool/namespace 条件领取任务。
5. Worker创建唯一 Attempt 和 fencing epoch。
6. Worker 从服务器按 Attempt 下载 Method Document 和 Dataset Snapshot。
7. 校验两个文件的大小和 SHA-256；单文件上限 25MB。
8. 创建干净 task root：spec/input/work/output/logs。
9. 写冻结 task_spec.json，并注入平台固定 Goal-Driven Prompt。
10. 同一容器以非 root Claude 用户启动一个 Claude Code 进程，给予容器内任务目录完整权限。
11. Worker 独立心跳并续租；丢租后终止 Claude，禁止上传/完成。
12. Claude 所有结果只写 output。
13. Worker拒绝 symlink/device/FIFO，打包 ZIP，计算 SHA-256。
14. 通过服务器 Artifact API 上传；大文件使用 streaming/multipart。
15. 服务器检查 lease/fencing/task/attempt/size/hash/manifest/object existence。
16. PostgreSQL 原子更新 Attempt succeeded、Task succeeded、Artifact published。
17. Worker 删除 spec/input/work/output/logs/临时 ZIP。
18. ACK Redis hint，继续等待下一任务。
```

不启动 Verifier 容器，不保留 `verification_pending`。但第 15 步的确定性完整性检查不能删除。

### 8.5 固定 Goal-Driven Prompt

应以当前 Cloudflare `claude_runtime.py` 中的完整平台 Prompt 为基线，统一到唯一模块，至少包含：

- 平台角色和权限边界；
- 冻结 TaskSpec；
- Method/Dataset 是不可信数据，不是系统指令；
- immutable inputs 和 writable locations；
- 明确阶段协议；
- 不得改变科学参数或偷偷简化方法；
- 工具调用与命令重试上限；
- BLOCKED_INPUT / DEPENDENCY_FAILURE；
- 输出 summary 和 agent_completion；
- Agent 自述完成不直接改变系统状态。

Task-specific goal 写入 `task_spec.json`。不能把用户随口的一段话替换平台提示词，也不能让 UI 生成不同版本的系统 Prompt。

### 8.6 公共 Worker

- 同一公共 Namespace 可创建任意数量 Worker；
- 不存在两台上限；
- 每次点击“创建”都生成新 ID 和新持久 credential；
- 一个 credential 同时只允许一个 active instance；
- 不存在 general/full、trusted/student Worker 执行分级；
- 平台公共 Worker 的 pool 身份不绑定某个普通用户；
- 学生和管理员触发服务器签发的 credential 进入同一个公共 Pool；
- Namespace、Pool、地址、Provider 和任务范围只能由超级管理员配置；
- Worker 协议不兼容时即使在线也不能获得 Offer。

## 9. 具体整改计划

### 阶段 0：冻结 ADR，不再边改边切架构

新增一份当前生效 ADR，明确：

- 全部 Worker 使用 PostgreSQL + Redis Direct 模式；
- PostgreSQL 是唯一 Task 事实源；
- Cloudflare D1 不再写 Task 状态；
- Docker 容器是执行边界，不再启动 Docker；
- Provider 使用本机配置；
- Verifier 废弃，保留确定性 finalize 检查；
- Method + Dataset 各 25MB；
- 固定 Goal-Driven Prompt；
- Artifact 上传后清理并循环。

旧远程学生 HTTPS-only 方案标记为已被本 ADR 覆盖，不再作为未来并行 Profile。

### 阶段 1：统一 Worker 代码和镜像

1. 选择 `Dockerfile.direct-worker` 为全体 Worker 的唯一生产 Dockerfile；
2. 移除 Docker CLI 和 Docker socket 相关生产路径；
3. 将完整 `_goal_driven_prompt` 移入唯一的 runtime 模块；
4. 删除或隔离 `docker_runtime.py` 生产入口；
5. 删除本地执行器中的 Verifier 调用和状态；
6. 保留 Artifact 安全收集、hash、manifest、fencing；
7. 增加 protocol version、image digest、capability；
8. Worker 启动 preflight 必须检查 PG/Redis/API/Claude/provider；
9. 任何必需连接失败时 Worker 为 not-ready，不参与领取。

### 阶段 2：统一 PostgreSQL/Redis 控制面

1. 完成 Worker 专用 RLS/存储过程或窄权限 SQL；
2. Redis ACL 按 Namespace 和 Worker 身份限制；
3. Outbox 原子提交 Task + task hint；
4. CAS claim、lease renew、reaper、fencing 全部落 PG；
5. 任务分发同时检查 Worker protocol/capability/public pool/readiness；
6. 旧 Worker 进入 incompatible/draining，不再领取；
7. Artifact finalize 使用一个数据库事务更新三类状态。

### 阶段 3：统一文件传输

1. Method/Dataset 仍通过受认证服务器接口下载，不从数据库读取大文件；
2. 每个文件 25MB 上限、size/hash 双校验；
3. Artifact 小文件 streaming、大文件 multipart；
4. 服务端不把完整结果缓冲进内存；
5. 上传完成后服务器 head/checksum/manifest 校验；
6. 网页端使用 Task owner 鉴权下载；
7. Worker 本地始终最终清空。

### 阶段 4：修复页面和错误可见性

1. 修复 `preview` Task ID；
2. Task Center 显示真实 Task、Attempt、Worker、事件和错误阶段；
3. Task Center 直接创建使用 `agent_confirmation=false`；
4. 默认任务名为执行文档文件名；
5. 左侧任务列表在详情页保持；
6. Chat Agent 不恢复；
7. 不兼容 Worker 显示“在线但协议不兼容”，不能显示为可用执行节点。

### 阶段 5：发布 GHCR 镜像

增加 GitHub Actions：

- 构建 `linux/amd64` 和 `linux/arm64`；
- 运行 Worker 单元和容器 smoke；
- 生成 SBOM；
- 推送 `ghcr.io/<owner>/infinity-agent-worker:v1`；
- 同时推送不可变 Git SHA tag；
- Compose 生产模板必须 pin digest；
- 镜像中 secret scan 为零；
- 文档中的 `<owner>` 替换为真实仓库 owner 后才可交付一键命令。

### 阶段 6：Case 2 / Case 3 真闭环

Case 2 和 Case 3 必须经过完全相同的线上代码路径：

```text
网页直接创建
→ PostgreSQL Task + Outbox
→ Redis hint
→ 新 Docker Worker claim
→ 两文件下载
→ 固定 Goal-Driven Prompt
→ 真实 Claude Code
→ Artifact 上传
→ PG finalize
→ 网页下载
→ checksum
→ 本地清理
→ Worker 继续在线
```

Case 2 验收 94 条序列、统计、Newick、图片、脚本、依赖、日志和报告。Case 3 验收 matrix/barcode/gene 对齐、QC、cluster、marker、UMAP、h5ad、日志和报告。

测试时只允许新协议 Worker 领取；旧远程 Worker 保持不动但必须因协议门禁拿不到任务。

### 阶段 7：推送、部署和线上回归

1. 所有修改先在同一 commit 完成本地测试；
2. 推送 `cloudflare-deploy`，确认远程 SHA；
3. 发布 GHCR image，记录 digest；
4. 执行 PostgreSQL migration/Redis ACL；
5. 用该 SHA 构建并部署 Cloudflare；
6. 部署后跑 Task detail、Worker connect、Case 2、Case 3；
7. 保存 Cloudflare version、Git SHA、image digest、schema revision；
8. 未通过不得宣称完成。

## 10. 必须新增的测试

### 10.1 后端

- Task 真实存在时详情 API 不会被前端替换为 preview；
- 非 owner 查询返回统一不可见；
- incompatible Worker poll/accept 均被拒绝；
- 同一 credential 第二实例被拒绝；
- 任意数量 Worker 创建；
- Redis hint 重投不会双 Attempt；
- PG CAS 同时只有一个 lease；
- Worker 失租后不能上传/finalize；
- 25MB 边界；
- multipart Artifact 连续 part、大小、hash；
- finalize 后唯一 Task/Attempt/Artifact 状态；
- Redis 丢失后 Outbox 重建。

### 10.2 Worker 镜像

- `claude --version`；
- 镜像内无 Docker CLI/socket；
- 没有构建期 Secret；
- 必需连接失败时 not-ready；
- Goal-Driven Prompt snapshot 和行为测试；
- Method/Dataset hash 不匹配拒绝；
- symlink/FIFO/device 拒绝；
- Claude exit 非零上报具体阶段；
- 大 Artifact multipart；
- 成功/失败/取消后目录均清空；
- 完成后进程继续 poll。

### 10.3 浏览器

- 静态导出真实 Task URL；
- API 请求使用 URL 中真实 ID；
- 不出现 `/api/tasks/preview`；
- failed Task 展示错误而非 Not Found；
- Artifact 下载和 checksum；
- Task 列表在详情页保持；
- 新建任务和 Worker 折叠卡行为。

## 11. 删除和保留建议

在新架构通过 Case 2/3 前，只标记废弃，不立即批量删除。通过后再做有目标的清理：

建议删除或移出生产路径：

- 安装 Docker CLI 的旧 Worker Dockerfile；
- 生产 `docker_runtime.py` 嵌套 Docker 路径；
- 独立 Verifier 服务和 `verification_pending`；
- 固定 worker-a/worker-b 的生产 Compose 槽位；
- 只适用于旧协议的 Windows 部署说明；
- Mock/Fixture 冒充发布门禁的测试入口。

必须保留：

- PostgreSQL CAS/lease/fencing；
- Redis Outbox/Streams；
- Worker 持久 credential；
- Method/Dataset hash；
- Artifact 安全收集、streaming/multipart、checksum；
- Task/Attempt/Event 审计；
- Case 2/3 Fixture 和真实验收断言。

## 12. 完成定义

只有下面全部成立，Worker 任务才算真正完成：

```text
唯一架构 ADR 已生效
GitHub 源码 = 部署源码
GHCR 镜像可拉取且 digest 固定
Worker 必需 PG/Redis/API/provider 全部 ready
旧协议 Worker 无法领取
固定 Goal-Driven Prompt 实际运行
Method + Dataset hash 正确
Case 2 succeeded 并可下载
Case 3 succeeded 并可下载
Artifact checksum 一致
Worker 本地目录清空
Worker 完成后继续在线
Task URL 不再出现 preview/Not Found
没有 Verifier 依赖
没有 Docker-in-Docker/Docker Socket
没有 Secret 进入镜像、日志或 Artifact
```

在这之前，“Worker 在线”“容器在跑”“单元测试通过”都不能单独作为系统完成证据。
