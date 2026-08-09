# Infinity Agents — Cloudflare 远程控制面与不可信学生 Worker 部署计划

> 版本：v1.0  
> 日期：2026-08-09  
> 状态：架构决策与实施计划，不表示当前代码已具备这些能力  
> 配套文档：`docs/ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md`、`docs/LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md`、`docs/MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`  
> 范围：本地 MVP 验收通过后的远程阶段；不替代本地阶段，也不把长时科研计算搬进 Cloudflare Worker。

## 0. 结论先行

这个部署约束下，正确结构不是“Cloudflare Worker 远程控制学生电脑里的 Docker”，更不是“学生 Worker 直连数据库/Redis”。正确结构是：

```text
Cloudflare = 唯一公网 HTTPS 控制入口 + 身份/授权 + 最小状态操作 + 能力签发

D1         = Cloudflare-native 控制事实库，保存租户、Session、Task、lease 与 Artifact 元数据
R2         = 私有对象存储，只通过单对象、短时能力或受信 Resource Processor 使用
D1 Outbox  = production v1 可靠通知源，提交后/定时经 HTTPS flush
Redis      = 2C2G 服务器上的 opaque task hint/事件加速器，只允许本机 Task Relay 访问
CF Queues  = 后续吞吐扩展选项；production v1 不与 Redis 强制双上

Analysis Session DO = Cloudflare Durable Object 按步编排 Paper/Analysis、hibernating WebSocket 与恢复
Resource Processor  = Tunnel 后受信处理器，承担 PDF/OCR、流式加密等重 CPU/大文件工作
Student Worker      = 不可信、可断线执行节点，只通过 Control API 领取允许的数据等级
```

### 0.1 10 ms 的准确含义

截至 2026-08-09，Cloudflare 官方限制是：

- **Workers Free**：每次 HTTP 请求最多 10 ms CPU；每天 100,000 次请求；
- **Workers Paid**：每次请求最高可配置到 5 分钟，默认 30 秒；
- 网络等待、数据库等待和 `fetch()` 等 I/O 等待不计入 CPU；解析 JSON、验签、模板渲染、压缩、哈希、PDF/ZIP 处理和模型输出处理计入 CPU；
- Free 请求持续超过 CPU 上限会出现 Error 1102。

依据：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)。

因此本文按更严格的 **Free 10 ms 可运行目标** 设计动态路由，并规定普通 Control API 的 p99 CPU 目标 `< 8 ms`。生产可以升级到 Workers Paid 获得容量和容错余量，但不能借升级把 PDF 解析、Agent 循环、文件加密、结果验证或长时任务塞回边缘请求。

### 0.2 五条不可妥协的边界

1. 浏览器、Resource Processor 和任何学生 Worker 都不能获得 D1、Redis、Cloudflare Queue、R2 parent token 或 Provider Key；公网 `web-edge`、`student-worker-gateway` 与 `worker-data-gateway` 也没有 D1/R2 binding，只有内部 `state-service` 持有 D1、内部 `resource-service` 持有私有 R2 binding；
2. 学生电脑不可信。Docker 只能隔离其本机 Job，不能证明学生宿主机诚实，也不能阻止宿主机复制分配给它的数据；
3. 因此私密、受监管或不能交给学生查看的数据，**不得** 分配给 `student_untrusted` Worker；信封加密无法在明文计算时消除这一事实；
4. D1 Task/Outbox 是远程事实；Redis 只保存 opaque hint。Cloudflare Queues 若以后启用也只是通知层；
5. Worker 返回的“完成”、checksum 和日志都不等于成功。结果先进入隔离区，只有受信 Verifier 接受后才形成正式 Artifact。

### 0.3 单一平台部署者与一次性生产切换

Cloudflare 是**平台管理员本人统一部署的一套中心服务**，不是让学校或学生各自部署的组件。只有平台管理员拥有 Cloudflare account、zone、Worker、D1、R2、DO、Tunnel 和 Secret 的管理权；学生、学校内部机器、Docker Job 均无 Cloudflare 账户、成员席位、Wrangler 配置或资源权限。

学生执行客户端的安装配置只有：

```text
WORKER_CONTROL_BASE_URL=https://worker-control.<platform-domain>
WORKER_GATEWAY_BASE_URL=https://worker-gateway.<platform-domain>
一次性 enrollment token（短期、单次使用）
```

客户端随后只使用每台唯一、可撤销的机器身份和 Attempt-scoped 能力。它不获得 Cloudflare API Token、Access Service Token、Queue token、D1/R2 binding、Redis/DB 凭据或真实 Provider credential。

管理员账户必须启用抗钓鱼 MFA/硬件密钥；CI/CD 使用按资源和动作最小化的 API Token，不使用 Global API Key；基础设施以受审查 IaC 管理并做 drift detection；生产 Secret 由 Secret Store/加密 CI 注入；Cloudflare Audit Logs、部署版本和配置变更进入不可篡改审计。Break-glass 材料（备用硬件密钥、恢复码、受限紧急部署 token）离线分开保管，每次使用必须告警、记录原因并立即轮换。单一管理员是可用性风险，因此恢复材料和 IaC 备份必须做季度恢复演练，但不因此给学生或学校授予管理员权限。

本文 R0–R7 只是**离线/预生产实施顺序，不是分批公网发布方案**。在全部组件完成且 G0–G9 于生产同构环境一次性通过之前，生产域名不路由真实流量；预生产域名只允许管理员 Access allowlist 和合成数据。最终只能在“完整安全生产切换”与“不部署”之间选择，不能先开放部分页面或学生入口再补安全控制。

### 0.4 10 ms 约束的作用域

10 ms 是 Cloudflare Free 普通 Worker invocation 的硬 CPU 约束，不是整个系统所有进程的 10 ms wall-time：`web-edge`、`student-worker-gateway`、`worker-data-gateway` 与被它们同步调用的 `state-service/resource-service` Service Binding 链必须合计纳入 10 ms；D1 查询等待不计 CPU，但查询发起、结果解析/序列化计入。

Durable Object 的官方 CPU 上限与普通 Free Worker 不同，但本项目仍主动把 Analysis DO 每个编排步骤的 p99 CPU 目标压到 `< 8 ms`，按用户给定的 10 ms Cloudflare 预算设计，不能借 DO 的较宽上限塞入 Agent 重循环或文件处理。2C2G Task Relay/Redis、Tunnel 后 Resource Processor、学生本地 Docker Job 和 Claude Code 长时 Task 不受这条 10 ms 项目预算限制，而受各自 CPU/内存/并发/wall-time 配额。

## 1. 本地阶段与远程阶段必须分开

### 1.1 本地阶段

本地阶段仍按 `docs/LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md` 完成：

```text
本地 OIDC Stub / Zhang Auth smoke
本地 PostgreSQL + Redis
受控 Worker A/B/C
真实 Docker Job
Analysis → 确认 → Task → Verifier → Artifact
Alice/Bob 隔离、幂等、失租恢复和过夜任务验收
```

本地阶段可以把所有节点放在开发者控制的机器和网络里，但仍要完成 ResourceBroker、Task 原子创建、RLS、短期能力、Worker fencing、Provider 隔离和 Secret 扫描。Cloudflare 不能用来掩盖本地状态机、安全或科学验收尚未完成。

### 1.2 远程 Cloudflare 阶段

远程阶段增加的是：

- 公网身份与 HTTPS 控制入口；
- Cloudflare D1 控制事实库；
- 私有 R2、Durable Objects 与 D1 Outbox → Redis Task Relay；
- 2C2G Redis Task Relay；
- Cloudflare Analysis Session Durable Object 与 Tunnel 后 Resource Processor；
- 不可信、可断线学生 Worker 的 enrollment、最小投影、租约和结果隔离。

远程阶段不改变以下产品合同：

```text
Analysis 是唯一主 Agent
→ Method + Dataset + TaskSpec 由用户确认
→ Task 异步执行
→ 任务执行中心显示状态与结果
→ 性状提取原图默认留在用户本机
```

### 1.3 远程部署的前置门槛

只有以下条件满足后才能让真实用户或学生节点加入：

- 本地 T0–T13 已通过；
- Task 创建、Outbox 和幂等是单事务；
- 本地 Project/RLS/ResourceBroker 已生效，并已把同样的授权合同翻译为 D1 的强制 Project 投影、复合键和负向测试；
- Job 不持有长期 Provider/DB/Redis/Worker Secret；
- 不可信 Worker 数据分级和结果验证策略已实现；
- 本文第 11 节远程安全门槛已通过。

## 2. 目标拓扑

```text
┌──────────────────────────── Cloudflare 公网边界 ────────────────────────────┐
│                                                                            │
│  Browser                                                                  │
│    │ Zhang Auth OIDC + 第一方 HttpOnly Cookie                             │
│    ▼                                                                       │
│  Static Assets / Pages                                                     │
│    │ /api/*                                                                │
│    ▼                                                                       │
│  web-edge（浏览器公网入口；无 D1 binding）                                  │
│    ├─ OIDC/opaque Cookie、CSRF、Origin、粗粒度速率限制                       │
│    └─ 固定 DTO/RPC ──────────────┐                                          │
│                                  │ Service Binding                          │
│  student-worker-gateway          │ （学生公网入口；独立 bundle；无 D1/R2）   │
│    ├─ 机器签名、nonce、body/route 限制                                      │
│    └─ 固定 Worker RPC ───────────┤                                          │
│  worker-data-gateway（第二个学生 base URL；无 D1/R2）                       │
│    ├─ Resource download / Artifact upload / Key Grant                       │
│    ├─ Anthropic Messages-compatible facade + Attempt token                  │
│    └─ 固定 State/Resource/Provider RPC ──┤                                  │
│                                  ▼                                          │
│  state-service（无公网 route；唯一 D1 binding）                             │
│    ├─ Session/Project/Resource/Task 授权与字段投影                           │
│    ├─ 用户确认、D1 batch/CAS/lease/finalize/Outbox                          │
│    ├─ 只暴露版本化固定 RPC；无 raw SQL/通用 filter                          │
│    ├─ 签发内部 exact-object capability                                      │
│    └─ Service Binding → Analysis Session Durable Object                    │
│                           ├─ 每 Session 单线程编排                          │
│                           ├─ 按步模型/工具状态机                            │
│                           ├─ alarm 重试与恢复                               │
│                           └─ hibernating WebSocket + event cursor           │
│                                  │ 固定 State RPC；DO 本身无 D1 binding      │
│                                  └──────────────────────────► state-service │
│                                                                            │
│  resource-service（无公网 route；唯一 private R2 binding；无 D1）           │
│    └─ 只接受 exact object/op capability；零缓冲流式 GET/PUT/HEAD             │
│                                                                            │
│  D1                                                                        │
│    └─ users/projects/members/sessions/messages/resources/tasks/attempts     │
│       outbox/grants/artifacts；无 RLS，全部由强制 project-scope 查询保护     │
│                                                                            │
│  private R2                                                               │
│    ├─ upload-quarantine                                                    │
│    ├─ canonical-resources（应用层密文）                                     │
│    ├─ attempt-input/output handles                                         │
│    └─ artifact-quarantine / canonical-artifacts                            │
│                                                                            │
│  state-service Scheduled/after-commit Outbox Flusher                       │
│    └─ HTTPS → Tunnel Task Relay；Cloudflare Queues 仅为后续可选             │
└────────────────────────────────────────────────────────────────────────────┘
               │ HTTPS + Access Service Auth / 请求签名
               ▼
┌──────────────────── 2C2G 公网服务器（origin 不公开） ───────────────────────┐
│ cloudflared：只建立出站 Tunnel                                              │
│ Private Task Relay：固定 HTTPS 操作，不接受 raw Redis command/key           │
│ Redis：只绑定 loopback/Unix socket；ACL；非事实源                           │
│ 可选临时 PDF Extractor：仅确定性抽取、并发 1、cgroup 硬限                    │
└────────────────────────────────────────────────────────────────────────────┘

┌──────────── 推荐的独立受信 Resource Processor 节点（origin 不公开） ────────┐
│ cloudflared 出站 Tunnel；流式 PDF/OCR/加密；限 CPU/内存/时间/输出；可扩容     │
│ 不运行 Paper/Analysis 模型循环，不持有 D1/Redis/Provider Key                 │
└────────────────────────────────────────────────────────────────────────────┘

                       ▲ 仅两个预配置 HTTPS base URL：Control / Worker Gateway
                       │
             ┌─────────┴────────────────────────────┐
             │ Student execution computers          │
             │ untrusted + intermittent             │
             │ local Worker → local Docker Job      │
             │ only public/sanitized tasks          │
             │ no D1/Redis/CF Queue/provider key    │
             └──────────────────────────────────────┘
```

Cloudflare Tunnel 由 origin 主动建立出站连接，允许服务器阻断所有公网入站端口；这是 2C2G Redis 服务器推荐的唯一应用入口。依据：[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)。

## 3. 信任域与数据等级

### 3.1 节点信任等级

```text
control_plane
  Cloudflare Control API + D1 + R2 + Durable Objects

trusted_service
  Analysis Session DO / Resource Processor / Worker Data Gateway / Verifier

owner_trusted
  数据所有者明确选择的本地 Worker

institution_trusted
  实验室管理的执行主机

student_untrusted
  学生个人电脑；可修改程序、读取内存、伪造输出、随时断线
```

“安装了官方 Worker”和“在 Docker 里执行”都不能把 `student_untrusted` 提升为可信。宿主机拥有 Docker、文件、内存和网络的最终控制权。

### 3.2 Task 数据等级

| `data_class` | 示例 | 可分配节点 |
|---|---|---|
| `public` | 公共论文、公开教学数据、公开 benchmark | 全部节点 |
| `sanitized` | 已去标识、经过人工审查、可交给学生的派生数据 | `student_untrusted` 及以上 |
| `private` | 未公开实验数据、内部论文/方案 | 仅 `owner_trusted` / `institution_trusted` |
| `regulated` | 人类遗传、临床、受合同/伦理限制数据 | 仅明确批准的隔离执行域或 `local_only` |
| `local_only` | 用户禁止出境/上传的资源 | 只在数据所有者本机执行 |

Task 创建时冻结：

```text
data_class
allowed_worker_trust
allowed_provider
allowed_geography（如需要）
raw_data_model_egress = deny | explicit_allow
retention_policy
```

`state-service` 的 claim RPC 在同一条 Project-scoped D1 条件写中强制比较 `Task.required_trust <= Worker.trust_level`。不能让 Worker 自报 `trust_level`，也不能让模型或前端覆盖。

### 3.3 无法用技术掩盖的事实

一旦把 Dataset 的明文交给学生电脑计算，学生宿主机就能复制它。短期 URL、信封加密、Docker、日志审计只能缩小其他风险，不能撤回已经交付的明文。因此：

- 机密 Task 不进入学生队列；
- 用户提交前必须看到“执行节点等级与数据去向”；
- 如需利用学生算力，只使用公共/已脱敏 Fixture；
- 高敏任务宁可排队到可信节点，也不能静默降级到学生节点。

## 4. 各组件职责

### 4.1 Static Web

前端尽量静态化：

- 静态 HTML/CSS/JS 由 Pages/Workers Static Assets 提供；
- 不做每请求 React SSR；
- 浏览器只调用同源 `/api/*`；
- Analysis 消息、Resource 状态、Task 卡和 Activity 通过分页 API 获取；
- 大文件不经过前端服务器内存，也不进入 Agent 消息 JSON。

Cloudflare 的静态资源请求不消耗动态 Worker CPU；动态控制请求才进入 10 ms 预算。生产构建不能把任何 D1/DB、Redis、R2 parent、Queue 或 Provider Secret 写入 `NEXT_PUBLIC_*`。

### 4.2 隔离的 Cloudflare 控制 API

远程开发至少逻辑拆分；生产必须物理拆成以下五个 Worker bundle：

| 组件 | 公网 | Cloudflare binding | 只允许的职责 |
|---|---|---|---|
| `web-edge` | 浏览器 API | `state-service/resource-service` Service Binding；无 D1/R2 | OIDC/Session、CSRF/Origin、固定 Web DTO、零缓冲分块上传 |
| `student-worker-gateway` | Worker API | `state-service` Service Binding；无 D1/R2/Queue | 机器签名、nonce、enrollment/poll/heartbeat/finalize 固定 DTO |
| `worker-data-gateway` | Worker 第二个 base URL | `state-service/resource-service`/Provider 固定 RPC；无 D1/R2/Queue | Resource GET、Artifact multipart PUT、Key Grant、Anthropic Messages facade |
| `state-service` | **无公网 route** | 唯一 D1 binding；Analysis DO | Project 授权、字段投影、D1 batch/CAS、能力签发、固定内部 RPC |
| `resource-service` | **无公网 route** | 唯一 private R2 binding；无 D1 | 只按 exact object/op capability 做零缓冲流式 GET/PUT/HEAD |

这不是为了把业务做成大量微服务，而是缩小最危险入口的能力：学生协议解析即使出现路由层漏洞，公网 bundle 也没有 raw D1/R2/Redis 能力。`student-worker-gateway` 不能与通用数据查询代码打进同一个 bundle，`worker-data-gateway` 也不能获得 R2 parent binding；它只能把 State 签发的 exact capability 交给内部 `resource-service`。Service Binding 在 Cloudflare 内部调用，不需要公开目标 URL；依据：[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)。

如果本地 MVP 为了开发速度暂时单 bundle，必须用独立模块和禁止导入规则维持相同边界；**接入真实学生电脑前必须完成物理拆分**。由于 Service Binding 默认可能在同一线程执行，10 ms 验收计算的是一次公网请求中 edge/gateway + `state-service` 的合计 CPU，不得把两个指标分别算后规避预算。

公网 Edge 只做：

1. 解析小型请求；
2. 解析第一方 session Cookie 或机器凭证；
3. CSRF/Origin、权限、配额和幂等检查；
4. 调用一个固定 `state-service` RPC，由它用一个 D1 batch/条件写完成状态变化；
5. 原子写一个不含业务正文的 D1 Outbox 事件；
6. 签发单用途、短 TTL 能力；
7. 返回小型 JSON 或 `202 Accepted`。

明确禁止：

- PDF/图片/ZIP 解压与解析；
- 大文件 hash、加解密、压缩或转码；
- 执行 Python/R/Shell；
- 运行 Agent 工具循环；
- 拼接整篇论文或整个 Dataset 的 Prompt；
- 等待几小时 Task；
- 在 Edge 内做 Artifact 科学验证；
- 通过 Worker 反向代理任意大文件正文。

### 4.3 D1：推荐的 Cloudflare-native 控制事实库

当前线上 PaperAgent 已由同一个 Cloudflare Worker 持有 Zhang Auth OIDC、opaque Cookie、D1 Session data 和上游模型 Key；`frontend/README.md` 也明确浏览器只调用同源 Session/Chat API。远程改造应沿用这条 Cloudflare-native 主线，而不是先把线上 D1 改回外置 PostgreSQL。

D1 保存：

```text
app_users / web_sessions
projects / project_members
analysis_sessions / messages / analysis_runs / analysis_steps
project_resources / session_resource_links
task_specs / method_sources / dataset_snapshots
tasks / task_attempts / task_events / outbox_events
worker_enrollments / workers / worker_sessions / worker_offers
capability_grants / artifact_records / audit_events
```

PDF、图片、Dataset、提取正文、大型模型输出、checkpoint 包和 Artifact 正文只放 R2；D1 只存小型状态、加密敏感字段、opaque object key、hash 和引用。Cloudflare 官方说明 D1 是使用 SQLite SQL 语义的托管 serverless 数据库，并由 Worker binding 访问：[D1 Overview](https://developers.cloudflare.com/d1/)、[D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/)。

用户配置的 Analysis/Coding `base_url/model` 可存普通配置字段；Provider credential 必须以 envelope ciphertext、`kek_version` 和 AAD（至少绑定 `project_id + provider_config_id`）保存，KEK 只在 `state-service` 的 Secret/KMS 域，不能与 D1/R2 备份同存。任何 DTO、错误、Trace、兼容性 probe 报告和管理员页面都不得回显完整 credential。

#### D1 没有 PostgreSQL RLS：必须写实补偿

D1/SQLite 没有 PostgreSQL Row-Level Security。不能把本地 `SET LOCAL + RLS` 原样复制，也不能声称 D1 会自动隔离租户。远程安全依赖 **内部 `state-service` 是唯一存储入口 + 每条 SQL 强制 Project 投影 + 复合键/外键 + 完整负向测试**。

硬规则：

1. D1 binding 只绑定内部、无公网 route 的 `state-service`；`web-edge`、`student-worker-gateway`、`worker-data-gateway`、`resource-service`、Analysis DO、浏览器、Resource Processor、Task Relay、学生 Worker 都不能访问 D1 REST API 或获得 Cloudflare API Token；Analysis DO 只调用固定 State RPC；
2. 从 opaque Cookie 解析出的 `principal.user_id` 是唯一用户来源；请求 body/query 中的 `user_id` 永不用于授权；
3. 每张租户表都有 `project_id TEXT NOT NULL`；Session、Resource、Task、Attempt、Event、Artifact 的主/唯一键至少包含 Project；
4. 所有父子关系使用复合外键，例如 `(project_id, resource_id)`、`(project_id, task_id)`；D1 支持并默认执行 foreign key constraints：[D1 Foreign Keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)；
5. 所有读写 SQL 都同时绑定 `project_id + object_id`，并在同一查询中 JOIN `project_members`；禁止先按全局 object ID 读取、再在 JavaScript 中补查 owner；
6. 不提供 `/d1/query`、raw SQL、任意表名/列名、通用 filter 或客户端控制的 Redis key；只使用代码中固定、参数化 prepared statements；
7. 返回 DTO 使用字段 allowlist，不把 `storage_key/wrapped_dek/session_hash/provider_config/internal_error` 放进通用序列化；
8. 每个 API 路由必须有 Alice/Bob、同用户跨 Project、membership 撤销和猜 ID 测试；没有对应负向测试不得合并。

推荐查询形态：

```sql
SELECT t.task_id, t.status, t.phase, t.updated_at
FROM tasks AS t
JOIN project_members AS pm
  ON pm.project_id = t.project_id
WHERE t.project_id = ?1
  AND t.task_id = ?2
  AND pm.user_id = ?3
  AND pm.status = 'active'
LIMIT 1;
```

禁止形态：

```sql
SELECT * FROM tasks WHERE task_id = ?1;
-- 然后在 JavaScript 中检查 project/owner
```

#### 原子性、幂等和 CAS

D1 的 `db.batch()` 会顺序执行一个事务；任一 statement 失败会回滚整个 batch。依据：[D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。因此远程 Task 创建使用一个 batch：

```text
insert frozen Method/Dataset/TaskSpec revision
+ insert user/project/action-scoped idempotency row
+ insert Task
+ insert initial TaskEvent
+ insert OutboxEvent
= all commit or all rollback
```

唯一键建议：

```text
UNIQUE(project_id, user_id, action, idempotency_key)
UNIQUE(project_id, task_id)
UNIQUE(project_id, task_id, attempt_index)
UNIQUE(project_id, task_id, fencing_epoch)
CREATE UNIQUE INDEX one_active_attempt_per_task
  ON task_attempts(project_id, task_id)
  WHERE status IN ('claimed', 'running', 'verifying', 'packaging');
```

同 idempotency key 同 request hash 返回原 Task；同 key 不同 hash 返回 409。

Claim/lease/finalize 只使用条件写和 `changes == 1`。需要多表原子改变时，预先生成 `attempt_id`，用 batch + SQLite trigger/约束让任何条件不满足都 `RAISE(ABORT)`；不能先 SELECT、在 Edge 思考后再无条件 UPDATE。D1 单库查询顺序执行，但这不替代条件 CAS、唯一约束和 fencing epoch。

#### D1 一致性、容量和 10 ms 风险

- 身份、membership、Task/lease/finalize 使用 primary；production v1 不为这些状态启用 read replica；
- 如果以后对只读历史启用 D1 Sessions/read replication，使用 bookmark 保证同一会话 sequential consistency，权限和写后读仍从 primary 开始；依据：[D1 Sessions / Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)；
- D1 query 执行和结果序列化计入 Workers CPU；所有热查询必须有 `(project_id, object_id/status/updated_at)` 索引，分页不得 full scan；
- 官方当前限制包括 Free 单库 500 MB、Paid 单库 10 GB、单行/BLOB 2 MB、每库单线程；因此 D1 绝不保存论文、图片、Dataset 或大 Agent transcript：[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)；
- `messages.content` 设应用上限，建议 64 KiB；更大内容写 R2 后只存 Resource reference；
- D1 `rows_read/rows_written` 与 Edge `cpuTime` 一起作为发布门槛，未索引扫描既增加成本也可能触发 10 ms CPU。

#### PostgreSQL/Hyperdrive 备选路线，不是推荐主线

只有出现以下情况时才保留 PostgreSQL：

- 远程数据/索引超过 D1 单库上限；
- 必须保留 PostgreSQL RLS、复杂事务/查询或现有本地 schema，迁移 D1 风险更高；
- D1 单库写吞吐在实测下成为瓶颈；
- 有合规要求指定托管 PostgreSQL。

备选拓扑是 `Managed PostgreSQL → TLS verify-full → cache-disabled Hyperdrive → internal state-service`；该环境由 Hyperdrive binding 替换 D1 binding，公网 gateways 仍无数据库 binding。Auth、membership、RLS、Task/lease 和所有写后读必须禁用 Hyperdrive 默认缓存；浏览器和学生 Worker仍不得直连。Hyperdrive 是现有数据库的连接层，不是数据库本身：[Hyperdrive](https://developers.cloudflare.com/hyperdrive/)、[Query Caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)。

D1 与 PostgreSQL 二选一作为某一环境的 Task 事实源，不能做无主从协议的“双事实库”。如未来迁移，使用 outbox/backfill/checksum/cutover，切换期间只有一边接受状态写入。

### 4.4 R2、内部 `resource-service` 与重处理器

R2 bucket 全部私有，至少拆分：

```text
infinity-upload-quarantine
infinity-resources-canonical
infinity-attempt-quarantine
infinity-artifacts-canonical
```

对象 key 使用完整随机 ID，不含用户 `sub`、文件名、论文标题或 Task 名。

#### 上传

```text
Browser
→ Control API 检查用户/Project/配额/MIME 声明
→ 签发同源、exact upload ID 的短期分块能力
→ 客户端密文经 web-edge → resource-service 零缓冲写 encrypted quarantine
  或明文经 web-edge 零缓冲直达 Tunnel 后 Processor，先流式加密再写 R2
→ finalize 只登记“待处理”
→ Tunnel 后受信 Resource Processor 流式检查大小、magic、ZIP/PDF 风险和 checksum
→ 加密并提升到 canonical
→ 删除 quarantine plaintext / multipart leftovers
→ Resource 才变为 ready
```

production v1 不把 R2 预签名 URL 下发浏览器或 Worker，避免第三 origin 与过期前不可撤销的 bearer；浏览器始终同源分块，公网 gateway 零缓冲转发。若未来评估直传，必须重新审查“URL 可重复使用到过期”的边界：[R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

生产私有数据的 canonical 对象使用应用层分块信封加密。两种允许路径：

1. 浏览器/桌面端先分块加密，再经同源 `web-edge` → `resource-service` 流式写 R2；
2. 浏览器把固定大小明文分块经同源 `web-edge` 零缓冲直达 Tunnel 后 Resource Processor；Processor 在任何 R2 落盘前流式加密，再通过 exact output capability 写 encrypted quarantine/canonical。

“明文先放 R2 quarantine、稍后加密”只允许 Access 隔离的预生产合成数据；真实私有数据上线门槛下，quarantine 也必须是客户端密文或通过受信流式加密入口。Edge Worker 不读取、缓存或加密大文件。

#### 下载到执行节点

推荐的可扩展路径：

```text
Worker 先持有当前 active Attempt
→ GET WORKER_GATEWAY_BASE_URL/v1/attempts/{attempt}/resources/{opaque_handle}
→ worker-data-gateway 调 State RPC 校验 Attempt，取得 exact-object 内部 capability
→ resource-service 通过 R2 binding 零缓冲流式返回 canonical ciphertext
→ 同一 WORKER_GATEWAY_BASE_URL 的 Key Grant 将对象 DEK 重包装给当前 Worker 公钥
→ Worker 只在当前 Attempt 目录解密
→ Attempt 结束清理
```

学生客户端绝不收到 R2 hostname、presigned URL、temporary credential 或 parent credential；R2 只由内部 `resource-service` binding 访问。R2 临时凭证的 scope/TTL 能力可供受信内部处理器设计参考，但不得下发学生：[R2 Temporary Credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)。

生产切换前必须完成“客户端分块解密”或“Tunnel 后受信 Resource Processor 流式解密，再经 Worker Gateway 返回”中的一条完整路径；重解密不能进入 10 ms gateway/`resource-service`。无论采用哪条路径，学生 Worker 最终能看到分配给它的明文，因此仍必须遵守第 3 节数据分级。

#### Artifact

学生 Worker 只能向 `WORKER_GATEWAY_BASE_URL` 的 Attempt-scoped multipart route 写：

```text
attempt-quarantine/{attempt_id}/{random_upload_id}
```

外部能力只允许当前随机 upload ID 的分块 PUT/complete，单块建议 8–32 MiB；`worker-data-gateway` 不缓冲 body，内部 `resource-service` 只按 exact-object capability 写 R2 quarantine，禁止 List、读取他人对象、覆盖 canonical 或 Delete。上传后由 `resource-service` 读取实际对象元数据，Tunnel 后 Resource Processor/Verifier 扫描 Secret/恶意内容并验证；通过后提升 canonical，由 `state-service` 条件写状态并签署 manifest。

### 4.5 production v1 通知：D1 Outbox → HTTPS Task Relay → Redis

production v1 不同时强制 Cloudflare Queues 和 Redis 两套队列。Task 与 Outbox 在一个 D1 `batch()` 中原子提交；随后以 at-least-once 方式把最小 hint 推到 Tunnel 后 Task Relay：

```text
D1 atomic Task + Outbox commit
→ response immediately returns task_id
→ ctx.waitUntil(best-effort HTTPS flush by event_id)
→ Scheduled Outbox Flusher 扫描仍 pending 的行
→ Cloudflare Access + signed HTTPS → Task Relay
→ Relay 以 event_id 幂等写 Redis opaque hint
→ D1 outbox 标记 delivered
```

`waitUntil()` 只是首轮低延迟优化，不是可靠性来源；断线后执行时间有限。可靠性来自 D1 pending outbox 和定时重放。每次 flusher 只取有索引的少量批次，避免超过 10 ms CPU。

Redis hint 只允许：

```json
{
  "event_id": "uuid",
  "event_type": "task_ready",
  "task_id": "uuid",
  "shard": "public-cpu",
  "not_before": "server timestamp",
  "version": 1
}
```

不得包含：

- Dataset/Method 正文；
- R2 URL/credential；
- 用户邮件、OIDC subject；
- Provider Key；
- D1/Redis信息；
- Worker lease token。

学生只轮询 custom Worker Control API。`student-worker-gateway` 调固定 State RPC；`state-service` 可通过私有 HTTPS Relay 取得候选 hint，但最终必须回 D1 检查 trust、quota、Task 状态并条件 CAS。Relay/Redis 不可用时，`state-service` 直接从有索引的 D1 queued Task 做低频 fallback。因此 Redis 全丢只影响唤醒效率，不丢 Task。

### 4.5.1 Cloudflare Queues 何时再加

只有出现以下观测结果时，才在 D1 Outbox 与 Relay 之间增加 Cloudflare Queues：

- Relay 短时不可用导致 D1 pending outbox 持续堆积；
- notification 吞吐明显超过 scheduled flusher/Relay 能力；
- 需要 Cloudflare 托管的重试、延迟和 DLQ；
- 已接受增加组件与费用的运维成本。

即便启用，Cloudflare Queue 仍只装上述最小 hint，D1 仍是事实源。受信 Queue consumer 的流程是：

```text
D1 Outbox → CF Queue
→ trusted consumer → HTTPS Task Relay
→ ACK Queue
→ D1 outbox/reconciler 仍可审计和重放
```

**任何时候都不允许学生 Worker 直接使用 Cloudflare HTTP Pull。** 官方 Pull Consumer 需要 Cloudflare Account Queue read + write API Token；放在不可信学生电脑会给出远超单 Task 的权限。若内部使用 Pull，通知落 D1/Relay 后立即 ACK；最大 12 小时 visibility 绝不能成为长 Job lease。依据：[Queues Pull Consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)、[Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)。

### 4.6 2C2G Redis 与 Private Task Relay

Redis 服务器即使有公网 IP，也不得公开 Redis 协议：

```text
公网 firewall: deny 6379, deny Task Relay origin port, deny其他数据端口
Redis: bind 127.0.0.1 / Unix socket, protected-mode yes, ACL
Task Relay: bind loopback, non-root, fixed API
cloudflared: outbound-only Tunnel → Cloudflare
Cloudflare Access: service-auth policy
```

`state-service` 的 after-commit/scheduled flusher 通过 HTTPS 调 Task Relay；浏览器和学生 Worker 没有 Access Service Token，也不能解析 Relay hostname。Cloudflare Access Service Token 可以按服务单独创建、续期和撤销：[Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。

Task Relay 只提供固定操作，例如：

```text
POST /internal/hints/publish
POST /internal/hints/ack
POST /internal/hints/retry
GET  /internal/hints/next?server_chosen_shard=...
GET  /internal/health/summary
```

它不提供：

```text
/redis?command=
/keys/{user_input}
/eval
/raw
任意 Pub/Sub channel
```

每个请求必须同时满足：

- Cloudflare Access service auth；
- 应用层 HMAC/签名；
- `timestamp + nonce + body_hash` 防重放；
- 固定 JSON schema 和 16 KB body 上限；
- 由服务端根据 Project/Event 计算 Redis key；
- 独立 ACL 用户和固定 namespace；
- 日志不记录正文/Secret。

Redis 只保存 opaque task hint、presence、事件游标或幂等缓存。不得保存唯一 Task、Method/Dataset引用、用户身份、唯一聊天历史、Artifact metadata 或解密密钥。Redis/AOF 丢失时，从 D1 outbox 重建；Redis 故障时系统进入“唤醒/实时提醒延迟”，Worker Control API 使用 D1 fallback，不能丢 Task。

2C2G 资源建议：

```text
Redis maxmemory: 512–768 MiB，明确 eviction policy
Task Relay: 128–256 MiB 上限
cloudflared: 独立服务和最小权限
OS/日志/缓冲: 保留至少 1 GiB
磁盘: AOF/日志有配额与轮转；不保存用户文件
```

精确值需由 soak 测试决定。生产推荐把 Resource Processor 放在**独立受信节点**，2C2G 只运行 Redis、Task Relay 和 `cloudflared`。

如果首个生产容量档确实只有这一台 2C2G，可共置一个**确定性 PDF 文本/图片抽取器**，但它仍须在生产切换前通过全部门槛：并发固定为 1；独立 Unix 用户/容器；cgroup 硬限制 CPU、内存、临时磁盘、进程数和 wall time；Redis 预留内存不可被处理器使用；输入/输出有字节上限；任务可幂等重放。OCR、模型调用、Paper/Analysis Agent 循环、Coding Docker Job、任意 Python/R/Shell 都不得共置。只要 Redis p99 延迟、eviction、系统内存水位或 24 小时压力测试有一项不过门槛，就必须在上线前拆到独立节点，不能带病切换生产。

### 4.7 Cloudflare-native Analysis：Session Durable Object 按步编排

Paper/Analysis 仍部署在 Cloudflare，但不能塞进 10 ms Edge route。推荐为每个 Analysis Session 建一个 Durable Object（DO），负责单线程协调、模型 I/O、工具状态机、实时连接和恢复；D1 保存业务事实，R2 保存文件，DO 不成为第二套永久会话事实库。

```text
Browser POST /api/analysis/sessions/{id}/messages
→ web-edge 校验 Cookie envelope/CSRF，调用固定 State RPC
→ state-service 校验 Project，并用 D1 batch 写 user message + analysis_run + first step
→ state-service 调 DO.kick(project_handle, run_id)；kick 只登记 alarm 后立即返回
→ Edge 返回 202 run_id（总体仍满足 10 ms route 预算）

AnalysisSessionDO alarm/RPC
→ 通过固定 State RPC 读取当前 project-scoped run/step（DO 无 D1 binding）
→ AGNO Analysis/Paper 步骤调用已验证的 OpenAI-compatible Provider（I/O 等待）
→ 得到 tool call 时通过 State RPC 写 D1 checkpoint
→ 轻工具在 DO 完成；重工具发给 Tunnel 后 Resource Processor
→ waiting_processor 时休眠，不 busy-wait
→ result callback 经专用 callback route + State RPC 写 D1，再重新 kick/alarm
→ evidence matrix / Method / assistant message 经 State/Resource RPC 写 D1/R2
→ DO 通过 hibernating WebSocket 只发“有新 event”提示
→ Browser 按 D1 event cursor 补取事实
```

建议状态机：

```text
queued
→ model_request_started
→ model_response_received
→ tool_dispatched
→ waiting_external_io
→ tool_result_persisted
→ model_resume_scheduled
→ completed | failed | cancelled
```

每一步必须：

- 有 `(project_id, run_id, step_id, revision)` 唯一键；
- 进入前通过固定 State RPC，以 D1 条件更新/CAS 检查前态；
- 外部调用使用独立 idempotency key；
- 调用前写 intent，调用后写 result/checksum；
- 失败按错误类型设置 `next_retry_at`，由 alarm 重启；
- 每次 invocation 只推进有限步骤，不用内存 `while` 跑完整 Agent；
- DO 被驱逐、部署或 alarm 重放后，通过 `state-service` 从 D1 checkpoint 恢复；
- 取消后旧 step/result 不能覆盖新 revision。

Cloudflare 官方把 Durable Objects定位为需要单实体状态协调的组件；每个 Object 单线程、可用 alarm 安排未来工作，并推荐 hibernating WebSocket 降低空闲成本。依据：[Durable Objects](https://developers.cloudflare.com/durable-objects/)、[Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)、[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。

#### DO 能做与不能做

DO 可做：

- 按 AGNO Analysis/Paper 合同调已验证的 OpenAI-compatible Provider，并流式转发小型 token/event；
- 调 PubMed/Europe PMC/arXiv 等固定 allowlist 的轻量 HTTP API；
- 编排 Resource ID、页码、证据项和 Method revision；
- 对小型 JSON 做 schema 校验；
- 管理每 Session 串行状态、alarm、backoff 和 WebSocket；
- 仅在当前受信 invocation 中通过固定 State RPC 解析 Project-scoped Analysis provider 配置；用户 credential 不作为静态部署模型假设，也不进入浏览器、学生 Worker、Resource Processor、DO 持久状态或日志。

DO 不做：

- PDF/OCR、图片解码/转码；
- 大 JSON/全文拼接；
- ZIP 解压、病毒扫描；
- 大文件 hash/加解密；
- Python/R/Shell 或 Goal-driven Coding；
- 长时间 CPU 循环。

Durable Object RPC/HTTP 在连接保持时没有硬 wall-time，alarm handler 最长 15 分钟；官方 CPU 上限较宽也不是把重 CPU 工作搬进去的许可。依据：[Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)。`DO.kick()` 的同步部分必须 `< 1 ms` CPU 并立即返回；alarm/RPC 每次只推进一个有限步骤，单步 p99 CPU 编排 SLO `< 8 ms`，绝不 busy-loop。模型/State RPC 等 I/O 等待不计 CPU；任何单步接近 8 ms、处理量随 PDF/模型输出增长或需要大 JSON 转换，必须进一步拆步或下沉 Resource Processor。

#### 重工具回调

Resource Processor 只接收：

```text
processor_job_id
project_id 的不可逆/opaque内部映射
exact R2 input capability
operation = pdf_extract | ocr | image_extract | encrypt_chunk | verify_blob
limits = cpu/memory/time/output_bytes
callback capability（只写当前 step result）
```

Processor 不持有 D1 binding、Redis credential、OIDC Cookie 或模型 Key。结果先写 R2 quarantine，再由专用 callback gateway 调固定 State RPC，以 `project_id + run_id + step_id + revision` 条件更新 D1；过期/取消 step 的回调只能进入隔离诊断，不能恢复 Agent。

### 4.8 两类模型合同与 Worker Data Gateway

产品运行模型必须明确分开，不能用开发团队自己的模型名称替代产品配置：

| 能力 | Agent/runtime | Provider 合同 | 可配置项 |
|---|---|---|---|
| Analysis/Paper | AGNO + Analysis Session DO 分步状态机 | OpenAI-compatible；按 AGNO 实际使用的 streaming/tool/vision surface 验证 | Project-scoped `base_url/key/model` |
| Coding/长时 Task | 学生或可信 Docker 内的 Claude Code | Anthropic Messages-compatible；按固定 Claude Code 版本实际调用面验证 | Project/Task-scoped `base_url/credential/model` |

文档和生产默认值都不得写死某个模型名或“Flash/Pro”等档位。每项配置启用前必须通过 compatibility probe；“端点返回 200”不算兼容。

Analysis probe 至少覆盖 AGNO 当前版本实际使用的非流式/流式回复、tool call/tool result、结构化错误，以及启用读图时的 vision input。Cloudflare 构建还必须证明 pinned AGNO 适配层能够在 DO 每步 `< 8 ms` p99 编排 SLO 内推进；不通过则阻塞生产，不能静默换成另一个 Agent runtime 或把完整 Agent 循环移到公网 Edge。

Coding 的真实调用路径是：

```text
Claude Code（Docker Job）
  ANTHROPIC_BASE_URL = WORKER_GATEWAY_BASE_URL
  credential = Attempt-scoped opaque token（不是 Provider credential）
→ Worker Data Gateway 的 Anthropic Messages facade
→ 已通过 Claude Code probe 的 Anthropic Messages-compatible provider
  base_url / real credential / model 只在受信端解析
```

Claude Code compatibility probe 至少覆盖 pinned Claude Code 版本所需的 Messages 非流式/streaming、`tool_use/tool_result`、stop/error/rate-limit 语义、模型名透传与一次最小真实 Coding smoke。Provider `base_url/credential/model` 可由有 Project 权限的用户配置，但 credential 仅加密保存在受信配置域；自定义 URL 必须限制 HTTPS、拒绝 metadata/loopback/私网地址、重新校验 DNS 与 redirect，防止 SSRF。

学生 Worker 和 Job 永远不获得 Analysis/Coding Provider Key。它们只获得 `WORKER_GATEWAY_BASE_URL` 与 Attempt-scoped opaque token。

Gateway 每次检查：

- 当前 `task_id + attempt_id + fencing_epoch`；
- token audience 只能是 `coding-model`；
- 模型 allowlist；
- 每 Attempt 请求次数、token、金额和并发预算；
- Resource `egress_policy`；
- 过期、取消或失租立即拒绝；
- 请求/响应体大小；
- 日志只保留脱敏元数据。

调用前，`worker-data-gateway` 通过固定 State RPC 按请求 `max_tokens`/价格上界原子预留预算；结束后按 Provider 可信 usage 元数据结算，异常中断按超时策略释放或人工对账。Gateway 只做流式透传和小型协议检查，不缓存、重写或逐 token 拼接整段响应；该公网链（含 State RPC）同样必须 p99 CPU `< 8 ms`。需要大响应转换的兼容适配器必须放到受信端并保持 Gateway 只流式转发。

恶意学生仍可能消耗授予该 Attempt 的预算，因此预算必须是硬上限，不能仅靠前端提示。Cloudflare Rate Limiting binding 适合粗粒度保护，但它按 Cloudflare location 最终一致，不能作为精确模型计费账本；精确预算以 D1 条件写和唯一 ledger row 为准。依据：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## 5. 不可信 Worker 协议

### 5.1 Enrollment

```text
管理员/课程系统创建一次性 enrollment token
  scope = student_worker
  expires <= 10 min
  max_uses = 1
  optional student/account binding

Worker 本地生成 Ed25519 keypair
→ POST /api/worker/enroll {token, public_key, version, capabilities}
→ student-worker-gateway 验签/限长后调用固定 State RPC
→ D1 条件写/`batch()` 原子消费 token
→ 返回 worker_id + 短期 enrollment session
→ 后续请求使用 server nonce + worker signature
```

规则：

- enrollment token 不等于永久 Worker Secret；
- token 只显示一次、短 TTL、单次使用，数据库只存 hash；
- Worker ID 由服务器生成；重复公钥/设备要可审计；
- `trust_level=student_untrusted` 由服务器固定；
- capabilities 是调度提示，不是可信证明；
- 每个学生/课程/Project 有最大 Worker 数和并发数；
- 管理员可 drain、revoke、rotate；
- 不做“远程可信执行”承诺，不依赖客户端自报 TPM/杀毒/Docker 状态。

学生电脑可提取自己的私钥，因此公钥绑定只防止网络上的其他机器冒充，不会让该电脑变可信。

### 5.2 Poll 与 Offer

空闲 Worker 调用：

```text
POST /api/worker/v1/poll
{
  "available_slots": 1,
  "capabilities": ["cpu", "python", "r"],
  "last_offer_cursor": "opaque"
}
```

Control API 不让 Worker列出队列，而是由服务器选择一项，先返回不含数据的 Offer：

```json
{
  "offer_id": "opaque",
  "task_class": "public-cpu",
  "estimated_cpu_minutes": 120,
  "estimated_disk_mb": 4096,
  "required_runtime": "claude-code-pinned-anthropic-messages-v1",
  "expires_in_seconds": 30
}
```

Worker 接受后，`state-service` 用 D1 条件写/`batch()` 原子执行：

```text
verify worker active/trust/quota
verify offer unused/not expired
verify Task still queued
insert Attempt
increment fencing_epoch
set lease_owner/lease_expiry
return attempt_id + task_projection
```

### 5.3 最小 Task 投影

学生 Worker 只得到：

```text
task_id / attempt_id / fencing_epoch
frozen Method resource handle + checksum
frozen Dataset resource handle + checksum
input contract
allowed commands/runtime image digest
expected output schema / Verifier contract
resource/model/artifact capability endpoints
deadline / heartbeat interval / hard budgets
```

不得得到：

- Analysis 完整聊天；
- 其他论文、Session 文件或用户目录；
- 用户真实身份、邮件、Project 成员；
- 数据库主键列表或可枚举 storage prefix；
- R2 parent credential；
- Cloudflare Queue/Redis credential；
- Analysis/Coding Provider Key；
- 其他 Task/Attempt URL；
- 控制面内部错误栈。

### 5.4 能力拆分

不能发一个“万能 Worker JWT”。每种能力独立 audience：

| audience | 能力 | 建议 TTL |
|---|---|---:|
| `worker-control` | heartbeat、状态、失败报告 | 5–15 分钟，可续 |
| `resource-read` | 当前 Attempt 的精确对象 | 2–10 分钟 |
| `key-grant` | 当前对象 DEK 的一次重包装 | 1–5 分钟 |
| `coding-model` | 指定模型与固定预算 | 1–5 分钟，可续 |
| `artifact-write` | 当前随机 quarantine key | 5–30 分钟 |
| `checkpoint-write` | 当前 Attempt checkpoint | 5–15 分钟 |

能力必须绑定 `worker_id + task_id + attempt_id + fencing_epoch + resource_id + action + expiry + nonce`。服务端保存 grant hash/状态；取消、失租、Worker revoke 后不再续签，finalize 总是重新查数据库，不只验 token 签名。

### 5.5 Heartbeat、断线与 fencing

推荐初始参数：

```text
heartbeat interval: 30 s
lease duration: 120 s
disconnect grace shown in UI: 2–5 min
poll idle backoff: 5 s → 30 s → 60–120 s + jitter
max active Attempt per student Worker: 1（production v1）
```

实际值由网络 soak 调整。

断线规则：

1. Worker 可在本机继续计算，但 lease 到期后不再拥有发布权；
2. `state-service` 以 D1 表达式 `unixepoch('now')` 的服务端时间标记 lease expired；
3. Task 可由其他 Worker 建新 Attempt，`fencing_epoch + 1`；
4. 旧 Worker 恢复后可上传到 quarantine 供诊断，但 finalize 必须 409/410；
5. 如果尚无新 Attempt，服务器可按策略恢复原 Attempt，但必须生成新 lease/grant；
6. checkpoint 只作为优化，不能改变唯一事实；
7. 浏览器、Redis、Queue 和 Worker 本地时钟都不能决定 lease。

### 5.6 完成与结果发布

```text
Worker upload quarantine
→ POST finalize(attempt_id, epoch, manifest, claimed hashes)
→ student-worker-gateway 调固定 State RPC，D1 检查 active lease/epoch/task state
→ resource-service 获取实际对象元数据，Resource Processor/Verifier 重新计算/验证
→ malware/secret/path/input-copy scan
→ deterministic Verifier
→ 可选第二 Worker 或可信节点交叉验证
→ canonical encrypt + manifest system signature
→ D1 条件写 Task succeeded + Artifact + Outbox
→ Outbox/TaskEvent 通知
```

对于学生结果：

- checksum 只证明字节未变，不证明科学正确；
- Worker 自签名只证明是该已登记 key 提交，不证明宿主机未篡改；
- 高价值结果至少要有受信 Verifier；
- 高风险科研结果需要可信节点重跑或两个独立节点的一致性策略；
- UI 展示执行节点等级、Attempt、Verifier 和复现状态，不能把学生自报 `done` 显示为成功。

## 6. Edge 10 ms CPU 与请求预算

### 6.1 路由 CPU 预算

以下是设计目标，不是 Cloudflare 保证值；必须用真实部署 Trace 测量：

| 路由类型 | 允许工作 | p99 CPU 目标 | State/D1/外部调用上限 |
|---|---|---:|---:|
| 静态资源 | CDN/Assets | 0 动态 CPU | 0 |
| `GET /health` | 常量 + 版本 | `< 1 ms` | 0 |
| Session 读取 | Cookie MAC/opaque lookup | `< 3 ms` | 1 State RPC / 1 statement |
| 列表/详情 | 授权 + 分页结果 | `< 5 ms` | 1 State RPC / 1–2 statements |
| Task confirm | 小 schema + 固定 State RPC | `< 7 ms` | 1 D1 batch |
| Worker poll/heartbeat | 验签 + 固定 State RPC | `< 6 ms` | 1 D1 条件写/batch |
| capability issue | 授权 + 小型签名 | `< 7 ms` | 1 State RPC + 1 capability binding |
| OIDC callback | state/nonce/PKCE + session | `< 8 ms` | 2 fetch + 1 D1 batch |
| Worker Gateway 模型 route | Attempt/预算预留 + 原样流式转发 | `< 8 ms` | 1 State RPC + 1 provider fetch |
| Analysis DO step/alarm | 单步 checkpoint + 1 次模型/工具推进 | `< 8 ms`（项目按 10 ms 预算设定的 SLO） | 1–2 State RPC + 1 external fetch |

OIDC callback 如果在真实 Provider/库组合下无法稳定低于预算，就拆成独立 `auth-edge`、减少同步 CPU 并重新验收；若仍不能 p99 `< 8 ms`，生产切换被阻塞。升级 Workers Paid 不能把本文的 10 ms 目标视为已通过。

### 6.2 控制请求硬限制

```text
control JSON body       <= 64 KiB
D1 Outbox hint           <= 2 KiB
list page size           <= 50
event page size          <= 100
response JSON            <= 256 KiB
subrequests              <= 4 typical / <= 8 hard
single D1 batch          <= 5 条固定 prepared statements
```

大文件走同源 stream route → 内部 `resource-service`/Tunnel 后 Resource Processor；日志、Artifact、Paper 正文和模型流不能塞进 Control JSON。

### 6.3 代码约束

- 不使用重量级 SSR 和通用 ORM 热路径；
- 不在 global scope 解析大型 schema、加载模型或生成密钥；
- 只解析一次 JSON；先校验 `Content-Length` 再读 body；
- 不对大字符串 `JSON.stringify`、Base64、gzip；
- 使用 WebCrypto/小型签名；每请求最多一次机器签名验证；
- 状态逻辑下沉到版本化 State RPC、固定 prepared statements、约束/trigger 和 D1 batch，不在公网 Edge 多轮读改写；
- `waitUntil()` 只做短日志/通知，绝不承担 Agent 或 Task；请求结束/断线后它最多延长约 30 秒，依据 [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)；
- 配置 `cpu_ms` 防 denial-of-wallet；Paid 也建议从 20 ms 小上限开始，不直接设 5 分钟；
- 记录每个 route 的端到端 `cpuTime`、wall time、State RPC/D1 statement count、response bytes 和 outcome。

### 6.4 请求量预算

Free 的 100,000 requests/day 很容易被空闲学生 Worker 轮询耗尽：

```text
daily_requests ≈ web_requests
               + idle_workers × 86400 / poll_interval_seconds
               + active_workers × 86400 / heartbeat_seconds
               + state_transitions
```

示例：

- 20 个空闲 Worker 每 60 秒 poll：28,800 请求/天；
- 5 个 active Worker 每 30 秒 heartbeat：14,400 请求/天；
- 合计 43,200，再加 Web 和状态操作可作为封闭预生产容量样本；
- 100 个 Worker 每 60 秒 poll 已是 144,000/天，必然超出 Free。

因此：

- 无任务时指数退避到 60–120 秒并加 jitter；
- 服务端返回 `retry_after`；
- 每 Worker 最多一个 outstanding poll；
- revoked/drained Worker 不再轮询；
- 浏览器只在 Task active 时 5–10 秒轮询，空闲 30–60 秒；
- 达到 70,000 动态请求/天或预计节点数超过 40–60 台时，先升级 Paid/优化连接策略，不等到 100,000 硬失败。

## 7. 安全攻击面与控制

### 7.1 浏览器/API 攻击

| 攻击 | 控制 |
|---|---|
| IDOR/猜 UUID | `state-service` 唯一 D1 binding；每条 SQL 同时约束 project/object/member；复合键/外键；404；Alice/Bob 负向测试 |
| CSRF | SameSite Cookie + Origin/Referer + CSRF token |
| OIDC callback 重放 | state/nonce/PKCE、一次性 code、session rotation |
| Bot/批量注册 | WAF、Turnstile、用户/设备配额；Turnstile Free 可用于生产：[Turnstile Plans](https://developers.cloudflare.com/turnstile/plans/) |
| JSON/CPU bomb | 64 KiB body、深度/字段上限、先限长、CPU route limit |
| SSRF | 用户 URL/provider URL 分类；解析 DNS、拒绝 metadata/私网，受信 admin allowlist 例外 |
| ZIP/PDF bomb | Edge/`resource-service` 不解析；Tunnel 后 Resource Processor 隔离、限解压量/时间/内存 |
| Presigned URL 泄漏 | exact object、随机 key、短 TTL、CORS、日志不记 URL |
| Denial of wallet | route/user/project/worker/model 四层配额，精确预算入 D1 ledger |

### 7.2 恶意学生 Worker

| 攻击 | 控制与剩余风险 |
|---|---|
| 枚举所有 Task | server-selected offer；无 list queue API |
| 领取私密数据 | `data_class × trust_level` 在 D1 claim 条件写中强制 |
| 伪造能力/硬件 | capabilities 只用于调度；结果仍验证 |
| 复制已分配 Dataset | 对不可信主机无法阻止；只分配 public/sanitized |
| 窃取 Worker token | 短 TTL、key-bound 签名、撤销；宿主本身仍可使用自己的身份 |
| 重放 heartbeat/finalize | server nonce、单调计数、attempt epoch、D1 条件写/CAS |
| 抢占大量 Task | 每节点/学生/Project 并发和速率；offer 超时 |
| 失租后覆盖结果 | fencing epoch；旧结果只能进 quarantine，不能发布 |
| 伪造 Artifact/hash | 服务端读取实际对象、Verifier、系统签名 |
| 消耗模型余额 | per-attempt model token、硬 token/金额/请求预算 |
| 把 Secret/输入塞进结果 | quarantine 扫描、合同 allowlist、超量拒绝 |
| 修改官方 Worker | 不能阻止；协议始终按恶意客户端设计 |

### 7.3 Redis/2C2G 服务器

| 攻击 | 控制 |
|---|---|
| 公网扫描 6379 | firewall deny + bind loopback/Unix socket；外网扫描必须 timeout/refused |
| Redis ACL 泄漏 | credential 只在 Task Relay；定期轮换；不进 Cloudflare前端/学生端 |
| raw command/EVAL | Task Relay 无通用接口；Redis ACL 禁止危险命令 |
| Task Relay 被伪造调用 | Tunnel + Access service auth + 应用请求签名/nonce |
| Redis 数据丢失 | D1 Outbox 重建；Redis 不是真相 |
| 2C2G 内存耗尽 | maxmemory、key TTL、value/body 上限、namespace 配额 |
| origin 绕过 Cloudflare | 无公网入站；cloudflared outbound only；origin port 本机绑定 |

### 7.4 Cloudflare/数据库/R2

| 攻击 | 控制 |
|---|---|
| D1 无 RLS / 查询漏 project | D1 只绑定无公网 `state-service`；固定 RPC/SQL；强制 Project 投影；复合键/外键；负向授权测试 |
| 学生入口代码漏洞 | `student-worker-gateway` 独立 bundle 且无 D1/R2/Queue binding；不能导入通用查询代码 |
| R2 parent token 泄漏 | 不进客户端；限制 bucket；独立 staging/canonical parent；轮换 |
| 临时能力越权 | exact object/prefix/action/audience/TTL；finalize 经 State RPC 重新查 D1 |
| Redis/可选 Queue 被当事实源 | D1 Outbox/reconciler；消息只含 opaque ID |
| 日志泄漏 | 不记录 Cookie/token/URL query/正文；采样和字段 allowlist |
| Edge CPU/请求耗尽 | WAF、Rate Limit、route CPU limit、请求量告警和熔断 |

## 8. 状态机与失败恢复

### 8.1 Task 状态

```text
draft
→ awaiting_confirmation
→ queued
→ offered
→ claimed
→ running
→ verifying
→ packaging
→ succeeded | failed | cancelled
```

`offered` 必须短暂且可超时返回 `queued`。只有 `state-service` 通过 D1 条件写能改变状态；Redis、可选 Queue 和 Worker 消息只触发一次固定 State RPC。

### 8.2 Redis 故障

```text
Redis/Task Relay down
→ Task 创建仍提交 D1 Task + Outbox
→ Control API 返回 Task 已创建，但 realtime_degraded=true
→ Scheduled Outbox Flusher/reconciler 继续重试
→ Worker poll 可直接走有索引的 D1 fallback claim 路径
→ Redis 恢复后从 cursor 重建短期索引
```

不得因 Redis PING 失败回滚已成功的 Task 事务，也不得在 Redis 恢复后重复创建 Task。

### 8.3 可选 Cloudflare Queue 故障/到期

```text
Queue publish fail
→ outbox remains pending
→ retry with backoff
→ periodic reconciler scans queued/expired lease rows
→ re-emits idempotent notification
```

Worker claim 基于 `Task.status` 和 D1 条件写/CAS，所以重复通知不会形成两个有效 Attempt owner。

### 8.4 学生电脑断线

断线不立即判科学失败；先失租、再创建新 Attempt。旧本地 Job 可以保留供学生查看，但不能发布到新 epoch。用户在任务执行中心看到：

```text
Attempt 1 — Worker student-17 — connection lost / fenced
Attempt 2 — Worker student-08 — running
```

### 8.5 Analysis Session DO 被驱逐或处理器断线

Analysis Run 以每步 D1 checkpoint 恢复。DO 被驱逐、版本发布或 alarm 重放后，通过固定 State RPC 读取 `run_id + step_id + revision` 并继续；Resource Processor 断线则停在 `waiting_external_io`，按 idempotency key 重派。用户消息、Resource reference、evidence matrix 和 Method revision 已持久化到 D1/R2；DO 内存和模型内存上下文都不是恢复事实源。

## 9. 离线/预生产实施阶段与一次性切换

R0–R7 全部是管理员控制下的实施顺序。除受 Cloudflare Access 限制的管理员预生产环境外，任何公网 hostname、真实用户、学校或学生节点都不得提前接入；不存在“先轻量上线再补安全”的阶段。

### Phase R0：冻结合同与远程威胁模型

交付：

- Worker/Task/Resource/Artifact API schema；
- `data_class × trust_level` 矩阵；
- 能力 audience、TTL、quota；
- D1 schema、复合键/外键、固定 State RPC 与无 RLS 隔离补偿；
- Edge route CPU/request budget；
- Task Relay 固定接口；
- 单一管理员的 IaC、MFA、Break-glass、审计和恢复合同；
- 恶意 Worker 测试程序。

门槛：没有任何客户端需要 DB/Redis/CF Queue/R2 parent/Provider Key。

### Phase R1：Cloudflare 静态站 + 10 ms 控制面

部署：

- 静态前端；
- Zhang Auth OIDC、HttpOnly session；
- `web-edge`、`student-worker-gateway`、`worker-data-gateway`、内部 `state-service/resource-service` 五个独立 bundle；
- D1 + D1 migrations + D1 Outbox；
- private R2；
- WAF/Rate Limit/Turnstile；
- CPU/请求/错误观测。

门槛：在生产同构但 Access allowlist 的域名完成 T1/T2；所有动态 route（含 Service Binding 下游合计）p99 `< 8 ms` CPU；Error 1102 = 0；仍不切生产流量。

### Phase R2：Resource 上传与受信处理

部署：

- quarantine/canonical buckets；
- exact-object capability；
- 内部轻量 `resource-service` + Tunnel 后重 CPU Resource Processor；
- 应用层分块加密；
- PDF/image 安全抽取；
- 删除/retention/GC。

门槛：浏览器看不到 R2 parent；私有对象在 canonical 和备份中无已知明文；URL过期/越权失败。

### Phase R3：2C2G Redis Task Relay

部署：

- Redis loopback/Unix socket + ACL；
- Private Task Relay；
- cloudflared Tunnel；
- Access Service Auth + app signature；
- memory/TTL/log limits；
- D1 Outbox 重建/重放脚本。

门槛：从公网扫描 6379/Task Relay origin 不可达；停止 Redis 不丢 Task；恢复后无重复事实。

### Phase R4：Cloudflare Analysis Session DO

部署：

- Analysis Run/step/checkpoint State RPC；
- 每 Session Durable Object、alarm、hibernating WebSocket；
- AGNO + 用户可配置 OpenAI-compatible Analysis provider compatibility probe；
- 独立受信 Resource Processor 与 callback capability；
- evidence matrix/Method 产物与恢复演练。

门槛：Edge request 快速返回 202；关闭浏览器/驱逐 DO 后 Run 从 D1 step 恢复；每次 DO invocation p99 `< 8 ms` 编排 CPU；Edge/DO CPU 不随论文页数增加。

### Phase R5：可信执行节点远程闭环

先用 `owner_trusted/institution_trusted` Worker 验证：

- enrollment；
- offer/claim；
- short capability；
- heartbeat/lease/fencing；
- quarantine/Verifier/canonical Artifact；
- Claude Code + Anthropic Messages-compatible Gateway probe 与硬预算。

门槛：远程真实 Case 成功；旧 lease 无法发布；无长期 Secret。

### Phase R6：不可信 Worker 对抗性预生产验证

只用管理员控制的恶意测试客户端和 `public` Fixture，不邀请真实学生：

- 模拟 5–10 台学生电脑；
- 每节点并发 1；
- 模型预算和 Artifact 大小硬限；
- 人为修改客户端、Token 重放、伪造完成、断网和恶意输出测试；
- 每个结果由可信 Verifier，部分任务可信重跑。

门槛：恶意客户端不能越过单 Attempt 权限；任何学生结果都不能仅凭自报进入 succeeded。

### Phase R7：全栈生产同构验收与一次切换

在合成负载和故障注入指标上完成容量决策：

- Workers Free → Paid；
- Poll → WebSocket/更长退避；
- Redis 单机 → replica/托管；
- Resource Processor → 独立受信池；
- 单 Verifier → 多队列；
- D1 容量/读写热点与恢复策略；
- R2 生命周期与成本等级。

随后在生产同构环境一次性执行 G0–G9、管理员账户/Break-glass 恢复和 IaC rollback。只有所有 Gate 同时通过，才把生产 DNS/route 一次切到完整系统并允许真实用户/学生 enrollment；任一 Gate 失败就保持不部署。升级 Paid 只能增加容量余量，不能豁免 10 ms 目标或安全门槛。

## 10. 成本与容量预算

### 10.1 Cloudflare 官方计价基线（2026-08-09）

| 组件 | Free/包含量 | 主要超额/付费信息 | 官方依据 |
|---|---|---|---|
| Workers Free | 100,000 请求/天；10 ms CPU/次 | 硬限制 | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers Paid | 最低 $5/月；含 1,000 万请求/月、3,000 万 CPU ms/月 | +$0.30/百万请求；+$0.02/百万 CPU ms | [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 Free | 500 万 rows read/天、10 万 rows written/天、5 GB 总存储 | 达限后对应操作失败 | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 Paid | 每月含 250 亿 rows read、5,000 万 rows written、5 GB | 超额 read $0.001/百万行、write $1/百万行、storage $0.75/GB-month | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Durable Objects Free | 100,000 requests/天、13,000 GB-s/天 | 任一 Free 额度耗尽后对应操作失败 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Durable Objects Paid | 每月含 100 万 requests、400,000 GB-s | +$0.15/百万请求、+$12.50/百万 GB-s | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| R2 Standard | 10 GB-month、100 万 Class A、1,000 万 Class B 免费/月 | $0.015/GB-month；A $4.50/百万；B $0.36/百万；egress 免费 | [R2 Pricing](https://developers.cloudflare.com/r2/pricing/) |
| Queues（后续可选） | Free 10,000 operations/天；Paid 含 100 万/月 | Paid 超额 $0.40/百万 operations；production v1 不计入必需组件 | [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/#queues) |
| Turnstile | Free 方案可用于多数生产场景 | Enterprise 另议 | [Plans](https://developers.cloudflare.com/turnstile/plans/) |

Cloudflare 价格会变化；每次发布候选必须重新核对官方页面，不把本文数字永久写进产品代码。

### 10.2 非 Cloudflare 成本

必须单独预算：

- 2C2G 服务器固定月租、磁盘、备份和运维；
- D1 主线超出限制后才启用的 PostgreSQL/Hyperdrive 备选费用；
- Analysis/Paper 模型 token；
- Coding 模型 token；
- 受信 Analysis/Resource/Verifier 主机；
- 学生网络、电力和本机磁盘不是“平台免费资源”，需明确使用政策；
- 数据跨境、伦理和机构合规成本。

通常模型调用和受信计算会早于 Edge CPU 成为主成本，但不应因此忽略恶意轮询、模型 token 滥用和 R2 垃圾上传带来的 denial-of-wallet。

### 10.3 成本硬闸

```text
per user/day: Analysis run、Task、upload bytes、model budget
per project/month: R2 bytes、Artifact retention、model spend
per worker/day: offers、claims、failed attempts、model budget、upload bytes
per task: attempts、wall time、token、Artifact bytes
global: Worker requests/CPU ms、D1 rows read/written/storage、DO requests/GB-s、R2 ops/bytes、可选 Queue ops
```

超过预算时返回明确 `quota_exceeded`，Task 留在 D1；不能静默继续产生模型或存储费用。

## 11. 远程发布验收门槛

以下 G0–G9 必须在同一个 production-candidate 版本和生产同构环境连续通过；不能用不同版本的零散结果拼成验收，也不能对失败项做“上线后再修”的豁免。

### G0：网络暴露

- 公网扫描 Redis 6379、Task Relay origin、Resource/Verifier origin 全部不可直达；D1 REST/API 不向客户端发 token；
- 只有 Cloudflare 域名 HTTPS 可用；
- Tunnel 停止时明确失败，不绕过到 origin IP；
- 学生安装只配置两个 HTTPS base URL 与一次性 enrollment；无 Cloudflare account/member/API/Access/Queue/D1/R2 权限；
- 浏览器和学生安装包中不存在 D1/DB/Redis/CF Queue/R2 parent/Provider Secret。

### G1：Edge 10 ms

- 在 Workers Free 等效 `cpu_ms=10` 下压测所有普通公网 route 及其同步 Service Binding 链；合计 p99 `< 8 ms`，Error 1102 = 0；
- Analysis DO step/alarm 虽按官方 DO CPU 模型计量，项目仍要求 p99 `< 8 ms`、无 busy-loop/大对象处理；
- 64 KiB 超限、深 JSON、超长字符串和签名洪水在昂贵操作前被拒；
- Edge CPU 与上传文件大小、论文页数、Task 执行时长无相关增长；
- 预计日 Worker/DO requests、D1 rows read/written 各保留至少 30% 余量。

### G2：用户与 Project 隔离

- Alice/Bob 对 Session、Resource、Task、Event、Artifact、R2 capability 全部互不可见；
- 每条租户 SQL 强制 `project_id + object_id + membership`；Alice/Bob、跨 Project、撤权和猜 ID 负向测试全过；
- `web-edge`、`student-worker-gateway`、`worker-data-gateway`、`resource-service` 和 Analysis DO 均无 D1 binding；学生 gateway bundle 无通用查询代码；
- membership 撤销后新 API/能力失败；已签 bearer URL只在 TTL 后失效的限制已披露；
- Worker role 不能读取用户消息和私有 Paper Resource。

### G3：恶意学生 Worker

测试客户端主动执行：

```text
伪造 trust/capabilities
枚举 task/resource IDs
重复使用 offer
并发 claim 多个 Task
重放 heartbeat/finalize
失租后上传/发布
修改 task_id/attempt_id/epoch/audience
请求他人 R2 object/list prefix
请求 DB/Redis/Queue/Provider Key
超预算模型调用
上传包含 Secret/输入副本/恶意 HTML/SVG/路径的 Artifact
```

预期：所有越权失败；只有当前 Attempt 的 quarantine 写入可能成功；Verifier 前 Task 不能 succeeded。

### G4：数据分级

- `student_untrusted` 对 `private/regulated/local_only` claim 永远为 0；
- 修改客户端声明不能提升 trust；
- 用户确认卡显示数据等级和执行域；
- public/sanitized Fixture 的脱敏过程和审核记录可追溯；
- 没有“加密后发给学生运行所以仍保密”的错误声明。

### G5：断线与并发

- 5 个学生节点随机断网、休眠、改时钟、重启；
- lease 由 D1 `unixepoch('now')` 服务端时间管理；
- 同 Task 同时有效 owner 最大为 1；
- 旧 epoch 发布成功数为 0；
- 可解释 Attempt 时间线完整；
- Worker 全部长期离线、Redis hint 全过期后，Task 仍在 D1，恢复节点仍能领取。

### G6：Redis/Outbox/D1 故障

- Redis 停止 1 小时：Task 不丢、API核心读写可用、实时提醒允许降级；
- D1 Outbox 重复/延迟：reconciler 幂等重放；
- D1 短断/限额：不伪造成功、不产生双 lease，返回明确可重试错误；
- Redis 恢复：重建短期索引，无重复业务事实；
- 2C2G 内存达到 maxmemory：行为符合 eviction 合同，不影响 D1 Task；
- 若共置确定性 PDF Extractor，24 小时压力下 Redis latency/eviction/内存门槛全过，否则上线前拆机。

### G7：Resource 与 Artifact

- Worker Gateway capability 只能访问当前 Attempt 的 exact object/action；学生不接收 R2 URL/credential；
- parent credential 不在客户端；
- canonical 私有对象是应用层密文；
- wrong DEK/AAD/tenant 解密失败；
- quarantine 生命周期清除半文件、过期 multipart 和失租 Attempt 输出；
- Worker 声明 hash 与实际不符时失败；
- Verifier 未通过但 Task 显示 succeeded 的数量为 0。
- AGNO Analysis/Paper 的 OpenAI-compatible probe 与 pinned Claude Code 的 Anthropic Messages-compatible probe 均通过；配置中无硬编码部署模型名。
- 自定义 Provider URL 指向 loopback、私网、metadata、DNS rebinding 或恶意 redirect 时全部被拒；credential 不出现在 probe 报告/日志。

### G8：OIDC、注销与日志

- Zhang Auth 一次登录覆盖整个 Web；
- logout 后 Cookie/BFF 权限立即失效；短时 R2 bearer 到 TTL 才失效的边界明确；
- 日志/Trace/Analytics/错误页不含 Cookie、OIDC code、Worker token、R2 URL、Provider Key、DB/Redis Secret 或正文；
- Secret 轮换和单 Worker revoke 演练通过；
- 唯一管理员 MFA/硬件密钥、最小 CI Token、Audit Log、IaC drift、Break-glass 恢复/轮换演练通过。

### G9：成本

- 恶意轮询和批量空 poll 不越过 route/worker/global quota；
- 模型预算在并发下仍是原子硬限；
- R2 垃圾上传达到配额后无法继续签发；
- Dashboard 能按 user/project/worker/task 解释成本；
- Free 预计用量超过 70% 时有升级/降载告警。

## 12. 运行与运维

### 12.1 最小观测指标

```text
Edge: request count, cpuTime p50/p95/p99, 1102, body/response bytes
Auth: login/callback/logout failures, session revoke
D1/State: rows_read/written, duration, batch/CAS conflicts, project-scope auth denies, outbox age
DO: request/alarm count, cpuTime, active duration, hibernation, step retry/replay
Task: queued age, offers, claims, active leases, expired leases, attempts
Worker: online, trust, version, poll interval, heartbeat, revoke
Notification: D1 outbox pending/delivered/retry/age；可选 Queue publish/backlog
Redis Task Relay: latency, auth failure, replay deny, memory, evictions
R2: quarantine age/bytes, canonical bytes, failed finalize, orphan multipart
Model: requests/tokens/cost/429/5xx by task and worker
Artifact: quarantine, scan failure, verifier failure, publish latency
```

### 12.2 告警

- Edge 1102 > 0；
- CPU p99 > 8 ms 连续 5 分钟；
- Worker/DO requests 或 D1 rows read/written 超过额度 70/85/95%；
- Redis 端口公网可达；
- D1 Outbox/可选 Queue oldest age 超阈值；
- 同 Task active lease > 1；
- revoked/expired Worker 请求成功；
- quarantine 对象超过 TTL；
- Secret scan 命中；
- Model spend 超预算或单 Worker异常增长；
- Project-scope auth deny/ID guessing异常增长；
- 管理员/MFA/CI Token/IaC 发生未计划变更或 Break-glass 被使用。

### 12.3 备份与恢复

- D1 使用 Time Travel（Free 7 天、Paid 30 天）并做定期恢复演练；长期保留需要受控导出到独立备份位置：[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)；
- R2 canonical manifest/checksum 与删除策略版本化；
- KEK 在 KMS/Secret Store，独立备份与轮换，不与 D1 同备份；
- Redis 不作为备份对象，最多备份配置；
- Worker credential 和 enrollment token 可全部撤销重发；
- Cloudflare配置使用 IaC，Secret 不进入 state 明文或仓库；
- 每季度从“D1 Time Travel/导出 + R2 + KEK + IaC”恢复一个完整 Analysis/Task/Artifact 链。

## 13. 明确不采用的方案

1. **学生 Worker 直连 Redis**：会暴露队列、心跳和内部 key，无法按 Task 最小授权；
2. **学生 Worker 直连 D1 REST、PostgreSQL/Hyperdrive 或任何数据库**：凭据泄漏、批量查询和授权遗漏风险不可接受；
3. **学生 Worker 直接 Cloudflare Queue Pull**：需要账户 Queue read/write token，权限面过大；
4. **一次 Cloudflare invocation 跑完整 PaperAgent/CodingAgent 循环**：普通 Edge 10 ms、DO 协调职责、文件处理和长时状态均不匹配；Analysis 只能由 DO 按步 checkpoint，Coding 在本地 Docker/Claude Code 长时执行；
5. **把 Redis 当 Task 真相**：2C2G 单机和短期队列不能承担事实一致性；
6. **把 Docker 当远程可信执行**：学生宿主机始终能控制 Docker；
7. **向学生节点发送私密数据后宣称仍保密**：计算时明文可见，技术上不成立；
8. **Worker 自报 done 即成功**：必须 quarantine + Verifier + D1 条件写/CAS；
9. **大文件经 Edge Worker Base64/代理**：浪费 CPU、内存和请求体额度；
10. **把 D1 binding 放进公网学生 gateway**：路由层漏洞会直接扩大成数据库能力；唯一 D1 binding 必须留在内部 `state-service`；
11. **Redis 与 Agent/模型服务混跑在 2C2G**：资源争用和攻击半径过大；
12. **一个万能 JWT 覆盖所有能力**：Resource/Model/Artifact/Control audience 必须拆分。
13. **让学生/学校部署或加入 Cloudflare account**：执行节点只应是两个 HTTPS base URL 的客户端，不能获得平台基础设施权限。

## 14. 实施顺序摘要

```text
本地 T0–T13
→ R0 合同/威胁模型
→ R1 静态站 + web/student gateways + state-service/D1
→ R2 R2/Resource 加密链
→ R3 2C2G Redis Task Relay + Tunnel
→ R4 Analysis Session DO + AGNO/OpenAI-compatible probe
→ R5 可信远程 Worker
→ R6 恶意 Worker 预生产验证 + Claude Code/Anthropic-compatible probe
→ R7 G0–G9 全量验收 → 一次生产切换或不部署
```

最先实现的**内部纵向集成测试**可以是以下最小链，但它不是可公开的半成品：

```text
用户登录
→ 创建一条 public Fixture Task
→ 管理员控制的模拟学生 Worker enrollment
→ Control API server-selected offer
→ D1 条件写/CAS claim
→ exact-object input grant
→ Job 执行
→ quarantine upload
→ trusted Verifier
→ Task succeeded + 下载
→ 断线/失租旧 Worker 无法发布
```

随后必须接通真实 Analysis Method、AGNO/Claude Code 两类 provider probe、Resource/DO 恢复、全部恶意测试和 G0–G9。只有整套系统全部通过才允许真实学生 enrollment；纵向集成测试通过本身不构成上线许可。

## 15. 官方依据

- Workers Free 为 10 ms CPU/HTTP request、100,000 requests/day；Paid 可配置更高 CPU；I/O 等待不计 CPU：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- Workers Paid 最低月费、请求和 CPU 计价；Queues 包含量与 operation 计价：[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- D1 是 Cloudflare-native serverless SQL；binding、batch、限制、价格和 Time Travel：[D1 Overview](https://developers.cloudflare.com/d1/)、[Workers Binding API](https://developers.cloudflare.com/d1/worker-api/)、[D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- Durable Objects 的单实体协调、alarm/WebSocket、限制和价格：[Durable Objects](https://developers.cloudflare.com/durable-objects/)、[DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Service Binding 可在不公开目标 URL 的情况下调用内部 Worker：[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- Cloudflare Audit Logs 记录账户与配置变更；仍需定期导出到独立审计存储并保留应用层管理员事件：[Audit Logs v2](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/)
- 只有采用备选 PG 路线时才适用 Hyperdrive、cache-disabled 和 TLS `verify-full`：[Hyperdrive](https://developers.cloudflare.com/hyperdrive/)、[Query Caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)、[Supported Databases](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
- R2 价格、免费额度和 egress 免费：[R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- R2 预签名 URL 是可复用到过期的单操作 bearer capability：[Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- R2 临时凭证可限制 bucket、action、object/prefix 和 TTL：[Temporary Credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
- Queues HTTP Pull 面向外部基础设施，但需要 Queue read/write Cloudflare API Token：[Pull Consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
- Queue message、retention、consumer 和 12h visibility 限制：[Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)
- Cloudflare Tunnel 使用 origin 主动出站连接，可阻断公网入站：[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- 自动化服务可使用可撤销 Access Service Token：[Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- Workers Rate Limiting binding 是快速但最终一致的粗粒度限制，不能作为精确账本：[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- Turnstile Free 可用于多数生产场景：[Turnstile Plans](https://developers.cloudflare.com/turnstile/plans/)

## 16. 远程完成定义

远程部署只有同时满足以下条件才可称为完成：

1. 普通 Cloudflare route、同步 Service Binding 链和 Analysis DO 单步都按项目 10 ms 预算验收，p99 `< 8 ms`、Error 1102 为 0；
2. 浏览器和所有外部 Runtime 只通过 HTTPS Control/Resource/Model API；学生客户端只配置两个 base URL 与一次性 enrollment；
3. Redis/Task Relay/Resource origin 无公网可绕过入口；学生和学校没有任何 Cloudflare account/resource 权限；
4. D1 是唯一 Task 事实源，Redis/可选 Queue 全丢仍可恢复；
5. 学生 Worker 只接收 public/sanitized Task，永远不能提升 trust；
6. 每个 Attempt 只有最小 Task 投影和拆分的短期能力；
7. 学生 Worker 不持有任何长期平台/Provider凭据；Coding 仅用 Attempt token 调 Anthropic Messages-compatible Gateway；
8. 断线、休眠、重启和恶意旧 Worker 都不能越过 fencing 发布；
9. 结果先隔离，Verifier 接受后才成为唯一 canonical Artifact；
10. R2 私有对象、应用层加密、短期能力和删除生命周期通过；
11. AGNO Analysis/Paper 由 Analysis Session DO 按步 checkpoint，重文件工作下沉受信 Processor；论文数量和 Coding 时长不增加单次 Cloudflare CPU；
12. Zhang Auth 一次登录、跨用户/Project 零泄漏；
13. 2C2G Redis 故障只造成可见的实时降级，不丢 Task；
14. 日志、Worker、Artifact 和浏览器中没有长期 Secret；
15. Cloudflare、D1、Redis、模型和存储成本有硬额度、告警和可解释账单；
16. Analysis 的 OpenAI-compatible 与 Claude Code 的 Anthropic Messages-compatible probe 均通过，产品不硬编码模型名；
17. 唯一管理员的 MFA、最小 CI Token、IaC、Audit Log、Break-glass 和恢复演练通过；R0–R7 与 G0–G9 全部完成后才一次切生产流量。
