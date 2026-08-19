# Infinity Agents — 本地 MVP 实施与实时验收计划

> 版本：v1.1  
> 日期：2026-08-09  
> 配套产品设计：[`ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md`](./ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md)  
> 开发模型执行规则：[`MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`](./MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md)  
> 范围：只定义本地产品、实现顺序、实时测试和发布门槛；不包含 Cloudflare 部署步骤。

> **2026-08-20 当前架构覆盖说明**：Worker、任务事实源、Verifier、Task Center 创建入口和
> Case 2/3 的现行合同见
> [`ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md`](./ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md)。
> 所有 Worker 使用同一 PostgreSQL/Redis 集群和同一镜像；超级管理员提供公共配置；普通
> 用户只能触发服务器签发 credential 和查看对应 Worker 状态；独立 Verifier 已废弃。本文原有
> Verifier、可信等级、固定 A/B/C 和子 Docker 描述不得覆盖该 ADR。

## 0. 交付目标与不可混淆的运行边界

本地 MVP 的产品主线只有一条：

```text
Analysis（PaperAgent 2.0）
→ 搜索/阅读论文、PDF、网页与论文图片
→ 在用户隔离的 Resource 空间中关联数据集
→ 跨论文整理方法并生成执行文档与 TaskSpec
→ 用户检查并明确确认
→ submit_goal_driven_task 异步提交冻结的 Method + Dataset
→ API 快速返回 task_id，Analysis 立即恢复服务其他对话
→ 独立 Docker Goal-driven Runtime 可执行数小时或整夜
→ 服务端租约、完整性和 Artifact finalize 检查后发布结果
→ 用户在任务执行中心查看状态、记录与下载结果
```

Analysis 是唯一主 Agent，也是 PaperAgent 2.0；它不在 Web/API 进程中安装依赖、运行 R/Python/Shell 或等待长时 Coding。Coding 不是前端主 Agent，而是确认后的异步 function call 和独立执行 Runtime。性状提取是本地批量图片到结构化表型数据的上游生产能力，原图默认不进入 Web。

Task 的两项用户业务材料严格固定为：

```text
1. 冻结的 Method Document
2. 冻结的 Dataset Snapshot
```

TaskSpec、确认记录、幂等键、校验和、权限、lease 和 finalize 规则属于系统控制元数据，不是第三份业务材料。Coding Runtime 不读取 Analysis 的完整聊天记录。

运行时间长、模型受控试错和单 Task 成本偏高不阻塞 MVP；下列问题必须阻塞发布：

- 用户隔离或密钥边界失效；
- 未确认即创建 Task；
- Analysis 被长时 Coding 占住；
- 同一 Task 出现多个有效执行者或多个有效结果；
- Worker/Redis/API 故障后无法恢复；
- 模型自述完成但必需输出、租约或完整性 finalize 检查未通过；
- Artifact 不可验证、不可下载或不可复现；
- Web 自动上传性状提取原图。

## 1. 实施边界

### 1.1 Analysis 不是长时 Coding 进程

Analysis 是 PaperAgent 2.0，只做研究、资源阅读、方法编译和 Task 提交。用户确认后：

```text
submit_goal_driven_task(...) → task_id
```

调用应快速返回。之后的 R/Python/Shell、安装依赖、排错和数小时执行都在独立 Docker Job 中完成。关闭浏览器、API 重启或 Analysis Provider 暂停，都不能终止已入队 Task。

### 1.2 性状提取是上游数据生产

性状提取的目标是处理数百张本地田间图片，生成 CSV/Excel/QC/失败清单。Web 默认不接收原图目录；用户主动导入结构化输出后，才进入 Analysis → Task 链。

当前 ImageJudge 还不是通用性状提取器。它实现的是“一张参考图 + 一张目标图 → `CLASSIFIED/UNKNOWN/REVIEW`”的参考图分类合同，当前 CSV 主要记录分类、状态和理由。把页面改名为“性状提取”不等于产品能力已经成立；本地 MVP 必须完成性状定义、逐图结构化观测、单位/标定、准确性、质控和吞吐验收。没有比例尺、相机标定或可靠参照时，不得伪造株高、长度、面积等绝对物理量，只能输出明确支持的定性/相对性状或标记为待复核。

### 1.3 PostgreSQL 与 Redis 的职责

- PostgreSQL 是 Session、Resource、Task、Attempt、Event 和 Artifact 的唯一事实源；
- Redis 只负责通知、Consumer Group、实时事件、心跳和短期缓存；
- Redis 丢失后必须能从 PostgreSQL 重建，不得丢失 Task 事实；
- 模型不决定权限、状态迁移、重试次数、租约或成功条件。

### 1.4 一次登录、桌面端与 Provider 出境边界

“全局 OIDC 一次登录”表示用户在 Infinity Web 的 Analysis、任务执行中心和性状提取入口之间只进行一次身份认证。HttpOnly Cookie 不能直接交给桌面程序：

- 本地 MVP 若由用户在 Web 文件选择器中导入性状表，桌面端无需获得 Web Cookie；
- 若桌面端提供“用于 Analysis”直接同步，则必须使用系统浏览器复用 Zhang Auth 的 SSO 会话，再通过 loopback PKCE 交换桌面短期凭证；这是同一次身份认证体验，但不是共享浏览器 Cookie；
- 桌面短期凭证与 Worker 机器凭证、Provider Key 相互独立。

文件隔离不等于文件不会离开设备。论文片段、图片、Coding 工具输出或性状图片可能发送给外部模型端点。每个 Resource/Run 必须记录并执行 `egress_policy`（至少 `local_only` 或 `provider_allowed`）、实际 Provider、发送内容类别和用户披露；只有真实本地模型在断网下完成相同任务时，才能宣称 local-only。

## 2. 当前基线与真实缺口

### 2.1 已有能力

- Next.js 前端与三个现有页面；
- FastAPI、PostgreSQL schema 与 PaperAgent WebSocket；
- OIDC Bearer Token 验证器；
- 论文检索、PDF 读取、图片提取/视觉工具；
- 会话目录、上传论文和共享论文缓存；
- TaskSpec、MethodSource、DatasetSnapshot、Task、Attempt、Event、Outbox、Artifact；
- Redis Stream、Worker CAS 认领、租约恢复；
- Docker Job Container、Verifier 与 ZIP Artifact；
- 任务列表/详情与 ImageJudge 桌面端。

### 2.2 2026-08-09 本地运行基线

- PostgreSQL：`localhost:5450`；
- Redis：`localhost:6379`；
- 当前 `infinity-redis` 无认证即可 PING，且 Docker 将 6379 发布到全部主机接口；这是待修 P0，不是安全配置；
- 检查用后端：`127.0.0.1:8008`；
- 前端：`localhost:3000`；
- 旧 `:8000` 后端已关闭；
- Worker 当前暂停，避免误消费数据库里的历史 queued Task；
- `claude-code-env:v2` Job 镜像存在。

这只是“服务能启动”的基线，不是新版产品完成证明。

### 2.3 P0 阻塞

1. 浏览器预期 Cookie，但 FastAPI 当前主要只认 Bearer Token，缺完整 `/auth/login/callback/logout`；
2. Task API 使用共享 `TASK_API_TOKEN`，未配置时开放，未复用 OIDC Principal；
3. 默认 Project 全局共享，Task/Method/Dataset/Artifact 没有完整 owner/Project 授权；
4. PaperAgent 工具直接允许整个共享 `papers/cache`，可绕过 HTTP 的 Session 授权；
5. 当前图片引用解析代码存在跨 Session 递归/同名文件风险，不能用于新版图片显示；
6. 直接 PDF URL 缺少完整 SSRF、重定向和流式大小防护，并可能把私有内容放进全局缓存；
7. 前端 PDF 上传 API 被 stub，统一 Project Resource 尚不存在；
8. Analysis 产品入口与异步 Task 闭环尚未实现；
9. Worker Runtime 虽已使用 Claude Code/Anthropic 环境，但尚未形成可由用户配置、经真实 Claude Code 探针验证的 Anthropic Messages-compatible Provider Profile；
10. 现有数据库里有历史 queued Task，当前 Worker 启动会消费错误任务；
11. Task、idempotency 和 Outbox 当前分开写入并吞异常；幂等冲突目标与数据库复合主键不匹配，Endpoint 还会额外创建第二个 Outbox；
12. 旧任务页没有真正验证 Dataset，却直接登记 `validation_passed=true`；
13. Worker 容器当前挂载宿主机 `/var/run/docker.sock`；Worker 被攻破后可获得接近宿主机管理员级的 Docker 控制能力，Job Container 的参数隔离不能消除这项风险；
14. Job Container 默认允许外网，并把 Worker 环境中的长期 `ANTHROPIC_*`/`STEPFUN_API_KEY` 直接注入 Job。模型生成的 Shell 可以读取环境变量并外传密钥或数据；
15. Worker A/B 当前可共享同一 `worker.env`、数据库凭证和 Redis 密码，不能逐机撤销，也不能称为最小权限自动加入；
16. 当前 Redis 无认证即可访问，且 6379 发布到全部主机接口；可达端口的客户端可篡改队列、事件或心跳；
17. 现有 ImageJudge 是参考图分类器，不具备通用多性状数值提取、物理量标定或相应准确度证明；
18. Artifact 收集器会跟随 output 中的 symlink，再由宿主 ZIP/`read_bytes()` 读取；恶意 Job 可能把 output 根外的宿主文件塞进结果包；
19. 当前 Claude Code Prompt 要求直接 follow 外部 Method 文档，尚未把 PDF/HTML/Method 中的指令视为不可信数据；提示词注入可能诱导 Job 泄密、越权联网或改变目标。

### 2.4 当前测试不能证明什么

现有单元测试应保留，但不能替代真实验收：

- `tests/test_auth_and_streaming.py` 只覆盖 Bearer 与部分会话隔离，没有覆盖一次 OIDC 登录、全站 Cookie；
- CodeAgent Playwright 主要 mock API，没有经过真实 PostgreSQL、Redis、Worker 和 Docker；
- `tests/test_regression.py` 的真实 Docker Case 使用旧 iCloud 绝对路径；
- 这三个真实 Case 断言 `done` 或 `error` 都算通过，执行失败也可能绿；
- 一些安全测试允许 `404` 替代真正命中大小限制；
- Analysis 测试主要走无 Key 的确定性 mock，不能证明真实 Pro Provider 与论文工具闭环；
- ImageJudge 已覆盖 SQLite/CSV/恢复，但没有证明网络实际发送的是预处理图还是原图；
- 当前 DashScope BYOK 发送预处理 data URL，而平台 `WorkerGateway` 直接上传原始文件字节，两者隐私合同不同；
- ImageJudge 现有测试只证明分类工作流可运行，不能证明输出是可信的表型数据，也没有准确率和吞吐基线；
- 现有 Docker 测试没有证明恶意 Job 无法读取长期 Provider Key、访问私网/metadata、控制 Docker Socket 或把 Dataset 外传；
- 现有 Artifact 测试没有提交 symlink、hardlink、FIFO、device、超量小文件等恶意 output，不能证明宿主打包器只读取 output root 内的普通文件；
- 现有 Coding 测试没有在 Method/PDF/HTML 中植入“打印 env、上传 Dataset、忽略 TaskSpec”等注入 canary；
- 现有长时测试没有覆盖一次排入 5 个 Task、用户离开一夜、Worker 有限并发执行与恢复；
- Analysis 测试没有用已标注的 golden papers 检查逐条方法参数的证据位置和无依据参数。

因此需要下面独立的本地实时验收体系。

## 3. 本地实施阶段

### Phase L0：可重复且隔离的验收环境

目标：每次验收都从干净 namespace 开始，不碰用户现有任务。

改造：

- 提供 `.env.local.example` 与不含真实 Secret 的 `worker.env.example`；
- 新增独立 acceptance compose，包含 PostgreSQL、带密码 Redis、API、Worker A/B、Outbox；
- 每次使用唯一 `RUN_ID`、数据库、Redis 或 key prefix、上传根、Artifact 根；
- Task/Outbox/Stream/Consumer Group 支持 environment namespace；
- 上传与 Artifact 统一放在仓库 `workspace/<run_id>/`；
- 禁止 Worker 默认连接旧测试数据库；
- 通过 `GOAL_DRIVEN_FIXTURE_ROOT` 指定三组科研 Fixture 根目录，当前机器路径只作为默认示例，不写死在测试代码；
- 固定版本、镜像 digest、Fixture manifest 和 checksum；
- 启动前显示目标 host/namespace，不显示凭证。

验收：

```text
一条命令启动 PG/Redis/API/Frontend
一条命令启动 Worker A/B
空数据库、空队列、空 Artifact 目录
历史 Task 数 = 0
Worker 不消费其他 namespace
```

### Phase L1：全局 Zhang Auth 与用户/Project 安全基础

目标：一次登录覆盖所有产品，数据库本身能够阻止跨用户资源拼接。

改造：

- 实现 Authorization Code + PKCE 的 login/callback/logout；
- 建立 host-only、HttpOnly、SameSite 第一方会话 Cookie；HTTPS/生产强制 `Secure`，本地若使用纯 HTTP 则不得假装已验证 Secure，发布候选需在本地 TLS 或生产域名复测；
- 本地浏览器只访问一个配置化 canonical origin（例如 `http://127.0.0.1:3000`）；由同源 BFF/反向代理把 `/api`、SSE 和 WebSocket 转到内部 `:8008`，不得混用 `localhost` 与 `127.0.0.1` 或让浏览器直接跨 origin 调后端；
- REST/SSE/WebSocket 统一解析 `Principal`；
- 删除前端 `NEXT_PUBLIC_TASK_API_TOKEN` 依赖；
- 创建 internal user `(issuer, sub)` 映射；
- Project owner/membership、Session、Resource、Task 全部关联同一用户链；
- 父子表增加 Project 复合外键；
- 启用并强制 PostgreSQL RLS；
- API、scheduler、worker、migration 分角色；
- Worker 身份与用户 OIDC 完全分离；
- CSRF、open redirect、state/nonce、Cookie rotation 和 logout 一并完成。

桌面端不读取 Web Cookie。若 MVP 启用桌面直传，增加系统浏览器 SSO + loopback PKCE + 短期桌面凭证；否则“用于 Analysis”只负责生成/定位结果，由用户回到已登录 Web 选择结构化文件。

验收：见 T1、T2。Alice/Bob 互猜所有 ID 必须统一不可见，Worker 角色不能读取消息和私有论文。

### Phase L2：统一 Resource 与安全文件代理

目标：实现 PaperAgent 虚拟文件系统的真正用途——文件不进上下文，但每次读取都授权。

改造：

- 新增 `project_resources`、`session_resource_links`、访问审计和删除状态；
- 物理存储使用完整随机 UUID/opaque key，不暴露绝对路径；
- 实现 `ResourceBroker`；
- Paper/File/Image 工具只接受逻辑 Resource ID；
- 删除 `allowed_dirs=整个共享 cache` 和 basename 全盘搜索；
- 公共论文目录与用户私有资源完全分离；
- 私有 URL、签名 URL 和上传内容永不进入公共缓存；
- 直接 URL 增加 SSRF、防重定向、流式限长和 HTTPS 策略；
- PDF 抽取移到低权限、无网络、限时/限内存的小容器；
- Resource 图片通过同源授权 API 返回，不塞进 SSE Base64；
- Resource 增加 `egress_policy`、允许的 Provider/用途和披露版本；`ResourceBroker` 在把文本片段、图片或表头交给模型前再次检查；
- 生产关闭 PaperAgent debug，工具审计只存 ID/状态/耗时/脱敏摘要；
- Session 删除先撤销 Session→Resource links并清理内存 Agent/临时文件；新增 `resource_references/retention_lease`，冻结 Task/Attempt/Artifact/复现保留期仍引用的 immutable Resource 保留到安全 GC；立即删除请求必须先以 CAS 取消/废止依赖 Task、拒绝续租/发布并记录 `input_revoked`，不能删除运行中任务的输入；
- 目录 `0700`、文件 `0600`、服务使用非 root 用户。

本地安全优先级：授权/RLS/ResourceBroker 先完成，信封加密随后加入。Base64、改名和哈希不能代替授权。

大文件路由必须确定：普通论文和小/中型表格可拖入对话；超过配置阈值的 Dataset 使用分块上传或本地 staging，不经过模型上下文；图片目录一律转到性状提取桌面端。前端必须在传输前显示大小、目的地和处理方式，不能先上传完整文件再提示超限。

### Phase L3：Analysis/Paper Provider 抽象

目标：PaperAgent 2.0 使用任意配置的高质量 OpenAI-compatible Provider，不假设模型名。

改造：

- 新增 Project-scoped、版本化的 `ProviderProfile` 与 capability probe/fallback；`purpose=analysis` 固定 `protocol=openai_compatible`；
- 用户可填写公开 HTTPS base URL、opaque model ID 和 credential；credential 立即进入 Secret Store/信封加密字段，读取接口只回传指纹，不能进入 D1/普通日志/TaskSpec/Artifact 的明文字段；
- `Analysis/Paper` 统一使用 `analysis-primary`；
- 移除 Moonshot/Kimi 的硬编码默认，保留迁移别名但不给产品假设；
- `/models` 失败不阻塞已配置模型；
- stream、tool call、vision、JSON Schema 分别声明；
- 429/5xx/401/能力不足分类；
- Provider base URL 做 SSRF 和重定向检查；
- 仅在 `APP_ENV=development|acceptance` 时允许运维配置精确的本地 `scheme + host + port` allowlist 供 `analysis-spy/coding-spy` 使用；不能由用户输入，生产若启用 private/loopback 例外则启动失败；
- Key 只来自 Server Secret；日志只记 provider/model/request ID；
- Provider 请求只包含完成当前工具步骤所需的最小授权片段，不把整个 Resource、签名 URL 或服务器路径永久放进消息；
- `local_only` Resource 不得到达 `analysis-primary`，Provider 变更时重新披露并重新检查能力和出境策略。
- Profile 探针只发送平台内置合成 Fixture；Alice/Bob、同一用户跨 Project、成员撤销与 Profile revoke 都必须重新授权。

验收：见 T4、T6。必须使用一个任意模型名并让 `/models` 返回 404，仍完成论文工具链。

### Phase L4：Analysis Workspace 外壳与 Activity

目标：让页面表达真实产品层级，不再并排展示三个 Agent。

改造：

```text
左侧：Analysis / 任务执行中心 / 性状提取
      + 新建分析
      Activity：待确认/运行/失败/完成未读
      最近对话：Analysis Session 按最近消息排序

中间：Analysis 对话、折叠处理过程、确认卡、Task 卡

右侧：窄的只读文件状态栏
      只显示当前 Analysis 的论文/Method/Dataset/性状表输入状态
      上传通过对话拖放 + 回形针 fallback
```

- `/` 标题从 PaperAgent 改为 Analysis；
- 最近对话不是按钮，直接列出；
- Activity 与最近对话是两个兄弟区块：前者只放需关注的暂态事项，后者只放持久会话入口；
- 论文搜索/阅读/图片工具明细只在当前对话折叠；
- 右栏不编辑文件、不放大型虚线上传卡，也不重复展示或下载 Task Artifact；
- 任务执行中心在 MVP 只展示过往 Task、状态、Attempt 与结果；不提供独立 Agent 或绕过 Analysis 的直接创建入口；
- 小屏幕使用左右 Drawer；
- 暂时保留现有 URL，先改用户可见 IA。

验收：见 T3。

### Phase L5：拖放资源与 Analysis 研究链

目标：Analysis 在隔离资源空间完成论文到执行文档。

改造：

- 通用拖放上传 PDF、HTML/Markdown、Dataset；
- 附件状态 uploading → processing → validating → ready/failed；
- 文件断连、失败和取消不留半文件；
- 文献搜索结果可固定为公共 Paper Resource；
- PDF 文本与图片按需读取，不把整篇塞进上下文；
- Method Compiler 先为每篇论文生成 evidence matrix，再生成统一执行文档；
- 执行文档保留来源、页码/段落、版本、hash 和未知参数；
- 每个进入 Method 的步骤、参数、软件版本和输入要求必须引用 `resource_id + page/section/figure/table`；无证据项标记为 unknown/待确认，多篇论文冲突不能静默合并；
- Dataset 只做结构/Schema/小样本检查，重分析不在 Analysis 执行；
- 外部文档提示词注入只作为内容，不具备权限。

验收：见 T3、T4。

### Phase L6：Analysis → 异步 Goal-driven Task

目标：用户确认后快速提交，Analysis 不等待 Coding。

改造：

- `draft_task_spec`、`generate_method_document`、`validate_task_spec`；
- 结构化用户确认卡；
- `submit_goal_driven_task` 快速返回 `task_id`；
- Method/TaskSpec/Dataset 冻结与 Task/Outbox/幂等在一个事务；
- idempotency key 绑定 `user_id + action + request_hash`；
- 修正数据库唯一键和 SQL `ON CONFLICT` 完全一致；
- 每个 Task 创建只产生一个规范 `task_queued` Outbox，失败不得吞掉；
- 双击、多标签、网络重试始终返回同一 Task；
- Analysis 消息流嵌入 Task 卡并订阅状态；
- Task 成功后结果卡引用同一 Artifact；
- Task 只获得冻结输入，不读取聊天历史或其他会话资源。

MVP 的正式 Task 只能从 Analysis 确认卡创建。Method 可以来自用户在 Analysis 上传的执行文档，也可以来自 Analysis 搜论文后生成的执行文档；两者只是 Method 来源不同，不是两个 Task 创建入口。任务执行中心只负责查看历史、状态、取消、允许的重试和结果下载。

创建硬条件：

```text
用户已认证
+ Project membership
+ Method ready/frozen
+ Dataset ready/frozen
+ TaskSpec valid/frozen
+ 数据确定性验证通过
+ 科学确认完成
+ 用户明确点击确认
= 一个 queued Task
```

验收：见 T5、T10、T12。还要证明提交后即使 Analysis Provider 停止或浏览器关闭，Task 仍继续。

### Phase L7：Claude Code + Anthropic-compatible Goal-driven Coding Runtime

目标：Docker Worker 保持 Claude Code 的目标驱动执行能力，同时允许用户配置任意通过验收的 Anthropic Messages-compatible Provider 和模型，不固定厂商、模型名或 `/models`。

改造：

- 以 `ClaudeCodeRuntime` 作为唯一 MVP Coding Runtime，不另写一套 OpenAI 工具循环；
- 新增独立、Project-scoped 的 Coding Provider Profile：`purpose=coding + protocol=anthropic_messages + base_url + encrypted credential reference + opaque model_id + capability/probe revision`；
- Provider Profile 保存前，在与生产完全相同版本的 Claude Code Job 镜像中完成真实兼容性探针，而不是只请求 `/models`；
- 兼容端点至少实现 Anthropic Messages `/v1/messages`、`/v1/messages/count_tokens`、流式响应、tool-use/tool-result、取消与错误语义，并正确保留 `anthropic-version` 和所需 `anthropic-beta`；
- Worker 把 Attempt-scoped Gateway URL/token/model 映射成 Claude Code 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`；
- 由 Claude Code 使用其原生工具循环；平台仍以确定性权限层限制 list/read/write/edit/execute/inspect 可触及的目录与资源；
- 只读 input、可写 output、干净 Attempt 目录；
- 限制命令时间、磁盘、内存、进程、输出和总循环；
- Job Container 不获得 OIDC、数据库、Redis、Worker 控制凭证或任何长期 Provider Key；
- Coding 模型请求通过 Worker 侧 Model Gateway/sidecar 转发，Job 只获得绑定 Attempt、可撤销、短时的调用能力；
- Model Gateway 执行 Task/Resource 的 `egress_policy`，记录发送给模型的内容类别和大小；Dataset 挂载到 Job 不代表允许把原始文件自动上传给模型；
- 默认拒绝任意公网、私网、loopback 和 metadata 出站；模型端点及经审核依赖源通过域名/协议白名单或依赖镜像/缓存代理访问；
- 模型工具不能访问 Docker Socket、宿主进程、其他 Attempt 或 Worker 文件系统；
- Artifact 发布前扫描 Secret、绝对路径、意外输入副本和超出合同的文件；
- Artifact 收集必须逐项 `lstat`，只接受普通文件；拒绝 symlink、device、FIFO/socket，规范化路径并确认 resolve 后仍位于 output root，同时限制文件数、单文件和总大小；宿主打包阶段不得再次跟随链接；
- Method、PDF、HTML、Dataset 文本和仓库内注释全部按不可信数据处理：只提取科研事实，任何要求打印 Secret、改变权限/目标、部署、访问额外网络或读取合同外路径的指令都无权限；
- 记录 Provider/model、镜像 digest、脚本、依赖和 token/cost 摘要；
- 错误分类、退避、超时、取消和 Verifier 外部验收；
- 使用独立 `coding-primary`；可选择 DeepSeek、Qwen 或其他模型，但只有通过 Claude Code + Anthropic Messages 兼容探针后才能启用，不设置产品级默认模型假设；
- Coding Key 与 Analysis Key 不串用。

验收：见 T6、T8、T9、T13。当前“长期 Key 进入 Job 环境 + 默认开放网络”的路径必须删除后才可通过。

### Phase L8：Worker 自动加入与最小权限

目标：增加 Worker 不修改中央代码，同一 Task 最终只发布一个有效结果。

本地 MVP：

- Worker A/B/C 使用唯一 ID；
- 每台 Worker 使用同一配置模板，但由本地 enrollment/bootstrap 生成不同的、可轮换和可撤销凭证；不得复制同一永久 `worker.env` Secret；
- Redis 启用 ACL：scheduler/outbox、worker、API 使用不同用户，只允许所需 Stream、Consumer Group、heartbeat 和 namespace；远程连接启用 TLS；
- Worker 使用专用数据库角色，不用 `postgres` 超级用户；
- Worker 只消费 acceptance namespace；
- health 显示版本、镜像、心跳、drain 和当前 Task；
- lease/CAS、失租 fencing token、Attempt 隔离与 Artifact 原子发布；
- 新 Worker 只需同一模板、中央地址和一次性 enrollment token 即可加入，中央业务代码不变；
- 本地 Docker Socket 仅可用于改造前的专用开发机 smoke，并显著标记高权限；T0–T13 发布验收必须改为专用执行主机、受控 Executor API 或其他不向联网 Worker 暴露宿主 Docker Socket 的方案；
- 重复 Worker ID 明确拒绝或告警，不静默覆盖。

验收：见 T7、T8。

### Phase L9：性状提取产品化

目标：从大批本地田间图片生成可继续分析的结构化性状数据。

改造：

- Web 页面更名 `性状提取`；
- 在迁移说明中明确：当前实现是参考图分类器，不能因更名直接宣称已支持通用表型数值提取；
- 桌面端目录扫描、去重、断点恢复、SQLite、CSV/Excel/QC/失败清单；
- 新增版本化 `TraitDefinition`：`trait_id/name/type(count|continuous|ordinal|category)/unit/allowed_values/protocol/calibration_required/qc_rules`；
- 新增逐图 `TraitObservation`：`run_id/image_id/specimen_id/trait_id/value/unit/calibrated_confidence_or_null/quality_flags/model_or_rule_version/review_status`；未经独立校准不得伪造数值置信度；
- 同一图片可产生多个性状；不满足清晰度、标定或协议要求时输出 `REVIEW/UNSUPPORTED`，不得用模型猜测数值；
- 对株高、长度、面积等物理量要求比例尺、相机几何或经过验证的标定方法；没有标定只允许输出类别、相对值或待复核；
- 明确区分 BYOK、平台和 Local-only 三种网络合同；
- 平台 `WorkerGateway` 改为上传预处理后的 bytes，或在改造前明确提示原图上传；
- 只有断网可运行的 LocalModelGateway 才能显示“图片不离开设备”；
- “用于 Analysis”只同步用户选中的表/QC/摘要，原图默认不上传；
- Local Companion 如实现，只走 loopback + origin 校验 + 短期 nonce，不接收任意文件路径；
- 建立带人工真值的准确性基准，并记录测试硬件、首条结果延迟、images/min、峰值 RAM/磁盘与恢复耗时。

验收：见 T11。

### Phase L10：本地发布候选

目标：T0–T13 全部通过，三组真实科研 Case 各成功一次，5 个长任务完成过夜 soak，证据包无 Secret。

## 4. 本地实时验收实验室

### 4.1 验收身份、namespace 与观察端点

每次生成唯一标识，例如：

```text
accept_20260809_153000
```

必须使用：

- 独立验收 PostgreSQL database/schema；
- 独立 Redis 实例或严格 namespace；
- 独立上传、Job 与 Artifact 目录；
- Alice、Bob 两个 OIDC 身份和两个浏览器上下文；
- Worker A/B，自动加入测试再启动 C；
- A/B/C 分别使用不同的 Worker credential 与 Redis ACL 用户；
- OpenAI-compatible `analysis-spy` 与 Anthropic Messages-compatible `coding-spy` 两个本地观察端点；
- 固定的 Biopython、DESeq2、Scanpy Fixture。

观察器应实时显示：

```text
OIDC session / user / project
Resource 状态与 owner
Task status / phase / lease owner
Task Attempt / Worker / image digest
Outbox pending/published
Redis Stream / PEL
Worker heartbeat
Job Container
Artifact / checksum
Resource egress decision / actual Provider
Job network denial / Model Gateway grant
Trait throughput / accuracy / QC
```

### 4.2 证据包

每次验收保存：

```text
local-acceptance/<run_id>/
├── manifest.json
├── versions-redacted.txt
├── screenshots/
├── browser-traces/
├── api-logs-redacted/
├── worker-logs-redacted/
├── provider-spy-redacted/
├── db-snapshots/
├── redis-snapshots/
├── docker-snapshots/
├── downloaded-artifacts/
├── trait-extraction/
└── checksums.sha256
```

证据中禁止出现 OIDC code/token、Cookie 原值、Provider Key、数据库/Redis 密码、用户绝对路径和 Docker 注入密钥。

### 4.3 T0：环境与 Fixture 预检

Fixture 根目录通过环境变量配置：

```text
GOAL_DRIVEN_FIXTURE_ROOT=/Users/zhangyvjing/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case
$GOAL_DRIVEN_FIXTURE_ROOT/1
$GOAL_DRIVEN_FIXTURE_ROOT/2
$GOAL_DRIVEN_FIXTURE_ROOT/3
```

先修正 `tests/test_regression.py` 的旧 iCloud 路径和“error 也算通过”断言。测试代码只读取 `GOAL_DRIVEN_FIXTURE_ROOT`，不保存某台机器的绝对路径。每组 Fixture 的方法、数据和预期文件写入版本化 manifest 并记录 SHA-256，不在验收时依赖会变化的远程下载。

基础检查：

```bash
pyenv shell Agent
pytest -q -m "not integration"

cd frontend
npm run lint
npm run typecheck
npm run test:unit
npm run build

cd ../image-judge
pyenv shell Agent
python -m pytest tests -q
python -m compileall -q apps/desktop/imagejudge
```

随后检查 Docker、PostgreSQL、Redis、Job 镜像和端口；此时不启动会消费旧 namespace 的 Worker。

通过标准：自动测试全部通过，三个 Fixture 路径存在、hash 固定，测试库/队列为空。

### 4.4 T1：全局 OIDC 单次登录

自动化使用本地 OIDC Stub；发布候选再用真实 Zhang Auth 人工 smoke 一次。

步骤：

1. 未登录打开 `/`；
2. 跳转 `/auth/login`；
3. 验证 PKCE `state/nonce/code_challenge`；
4. callback 建立 HttpOnly 第一方 Cookie；
5. 返回原 Analysis 页面；
6. 依次打开 Analysis、任务执行中心、性状提取；
7. 全程不再次登录；
8. REST、SSE、WebSocket 都复用 Cookie；
9. logout 后所有 Cookie 鉴权入口与 BFF 下载立即失效；
10. 再登录仍看到自己的历史。

浏览器网络记录必须只出现一个 canonical origin；`:8008` 仅由同源代理在服务端访问。混用 `localhost/127.0.0.1`、跨 origin Cookie、宽泛 CORS 或把 Token 放进 WS query 都判失败。

负面用例：错误 state/nonce/issuer/audience、过期 Token、JWKS 换 Key、OIDC 暂停、session fixation、跨站请求、站外 `return_to`。

桌面边界：若桌面直传启用，点击后由系统浏览器复用已登录的 Zhang Auth SSO，会经过独立 loopback PKCE 并得到桌面短期凭证；桌面程序从不读取 HttpOnly Cookie。若桌面直传未启用，则只验证用户能在已登录 Web 中选择并导入桌面生成的性状表。

通过：一次身份认证体验覆盖全站；Local Storage、URL、DOM 和前端构建中没有长期 Token 或 Task shared secret。已经签发的对象存储预签名 URL不承诺随 logout 立即撤销，只能使用极短 TTL 并在到期后失效；若业务要求立即撤销，下载必须始终经 BFF Cookie 代理。

### 4.5 T2：Alice/Bob 全链路隔离

Alice 创建 Session、上传 PDF/Dataset、固定公共论文、生成 Method、创建 Task 和 Artifact。Bob 对以下对象逐个猜 ID 和直接请求：

```text
Session / Message
Resource / uploaded paper / extracted image
Method Source / Dataset Snapshot / TaskSpec
Task / Event / SSE / cancel
Artifact metadata / download
```

预期：

- Bob 列表不可见，直接 ID 返回 404；
- Bob 不能订阅 Alice 的 WS/SSE、不能取消 Task；
- Bob 不能把 Alice Method 和自己的 Dataset 组合；
- Bob 指示 Agent 调 `list_files/read_file/read_image/analyze_image` 仍不可读；
- 同名文件、basename、`img://` 和 Markdown 图片不能碰撞；
- 公共论文可物理复用，但当前 Project 必须有授权 link；
- Alice 上传与私有 URL 永不进入公共缓存；
- 同一 Alice 在 Project A 的 Method 不能与 Project B 的 Dataset 组成 Task，除非通过显式、可审计的复制/授权流程；
- Project membership 撤销后，旧 Resource、Task、SSE 与下载票据按合同失效；
- `local_only` Resource 的文本、图片、hash 和文件名都不能到达 `analysis-spy`、`coding-spy` 或性状 Provider。

攻击矩阵：`../`、绝对路径、双重 URL 编码、Unicode 名、symlink、hardlink、TOCTOU、ZIP Slip、压缩炸弹、超大/超多文件、伪 MIME、HTML/SVG 主动内容、任意 `stored_path`、IPv4/IPv6 SSRF、DNS rebinding、重定向到私网/metadata。

RLS 直接测试：Alice context 只读有权 Project；Bob context 读不到；同一用户跨 Project 不能错配；未设置 context 默认拒绝；Worker role 无权读 Session/Message；API role 无 `BYPASSRLS`。

如启用信封加密，再验证：磁盘找不到已知明文、错误 tenant/DEK/AAD 失败、篡改密文失败、KEK 轮换后旧对象可读、主密钥不在 DB。

### 4.6 T3：Analysis Workspace 交互

1. 首页默认 Analysis；
2. 左栏只有 Analysis、任务执行中心、性状提取；
3. Activity 只显示待确认、运行、失败和完成未读；
4. “最近对话”是 Activity 下方的独立区块，按最近消息排序，直接列出 Analysis Session；
5. 点击 Activity 打开对应确认卡/Task/失败资源；查看完成结果后只清除未读提醒，不删除任务执行中心的永久记录；
6. 任务执行中心只列过往 Task 和结果，不显示独立 Coding Agent，也没有绕过 Analysis 的任务创建表单；
7. 不出现独立 Paper/Coding Agent 入口；
8. 中间是对话与折叠处理过程；
9. 右边是 260–300px 只读输入资源状态栏，只列论文、Method、Dataset 和已导入性状表；
10. 右栏不出现 Artifact 下载或与 Task 详情重复的成果文件；
11. 无大型上传区；
12. 文件可拖入整个对话区；
13. Composer 保留回形针；
14. PDF、单 Dataset、PDF+Dataset、同名、不支持、超限、断网、刷新分别测试；
15. 状态统一为 uploading → processing → validating → ready，失败为 failed；
16. 超过阈值的 Dataset 在传输前被路由到分块上传/本地 staging，图片目录被路由到性状提取，不能先整份上传后报错；
17. 刷新后资源和会话恢复；小屏幕用 Drawer。

右栏只读不等于没有下载：结果下载放在 Task 卡或 Task 详情，不放进右栏文件操作面板。

### 4.7 T4：Analysis 研究链与论文证据

给 `analysis-spy` 配一个任意模型名，且令 `/models` 返回 404。在同一 Session：

1. 提出研究目标；
2. 搜论文；
3. 阅读搜索结果；
4. 阅读用户 PDF；
5. 读取论文提取图片；
6. 追问前一篇论文方法；
7. 从多篇论文生成带证据位置的执行文档；
8. 识别数据要求和待确认科学参数；
9. 草拟 TaskSpec。

断言：

- 全部研究编排走 Analysis Pro Provider；
- 不访问 Coding Flash Provider；
- 同一 Session 保留上下文摘要和 Resource reference；
- 整篇文件与大图不直接永久塞进消息上下文；
- Provider Key、绝对路径、签名 URL不进入日志或响应；
- 恶意论文要求忽略系统指令、读环境变量、创建 Task、伪造确认时全部失败；
- `local_only` Resource 不到达任何外部 Provider；已允许出境的请求只含当前步骤所需的最小片段/图片。

Golden paper 验收使用一组人工标注论文，预先记录软件、版本、步骤、参数、输入输出、页码/章节/图表及已知冲突：

- 每篇论文先产生独立 evidence matrix，不能只给一份混合摘要；
- Method 中每个事实都能回到正确 `resource_id + page/section/figure/table`；
- 引用位置与原文含义一致，不能引用相关但不支持该结论的段落；
- 无证据参数明确标记 unknown/待确认，不得补成看似合理的默认值；
- 多篇论文参数冲突必须展示来源和差异，由用户或规则解决；
- 生成的输入合同明确到文件、字段、验证规则和交付物。

Golden manifest 在运行前冻结指标：关键 Method 字段 recall=100%、无证据却写成事实的参数=0、已标注冲突漏报=0、已标注 unknown 被擅自补值=0；非关键 citation-location accuracy 初始门槛至少 95%，并逐条核对 resource/page/section/figure/table。若业务 Case 另有更高阈值，以更高者为准，不得运行后降门槛。

### 4.8 T5：确认与唯一 Task

两种 Method 来源，均在 Analysis 会话中进入同一确认卡：

```text
A. 用户在 Analysis 上传 Method + Dataset
B. Analysis 搜论文并生成 Method，再关联用户 Dataset
```

任务执行中心不得提供第二套直接创建 API/UI；两种来源最终都只调用同一个 `submit_goal_driven_task`。

确认前观察：Task=0、Outbox=0、Redis 执行消息=0、Job Container=0。

Dataset 的 `validation_passed` 只能由后端确定性验证器写入；前端布尔值、模型陈述和文件扩展名都不能把它设为 true。

确认后必须原子出现：

```text
Method frozen revision
Dataset frozen snapshot
TaskSpec frozen revision
1 Task
1 pending Outbox
1 queue notification（最终）
```

并发测试：双击、请求超时重试、同一 idempotency key 5 次、多标签页、callback 重放。最终始终一个 Task ID。冻结后修改 Method/Dataset 只能产生新 revision/new snapshot，旧 Task hash 不变。

额外检查：数据库只存在一个 `task_queued` Outbox；在 Task 插入、幂等写入、Event 或 Outbox 任一步注入失败时，整个事务回滚为 0 条，不允许留下“无消息 Task”或“无 Task 消息”。同一个 key 搭配不同 request hash 必须返回 409，而不是错误复用旧 Task。

额外关键断言：提交返回 `task_id` 后停止 Analysis Provider、关闭浏览器或重启 API，Docker Task 仍继续；这证明 Coding 不是 Analysis 常驻子 Agent。

### 4.9 T6：两种 Provider 协议与凭据完全隔离

| 能力 | 协议与观察端点 | 模型 |
|---|---|---|
| Analysis/Paper（AGNO） | OpenAI-compatible `analysis-spy` | 任意高质量模型名 |
| Docker Coding（Claude Code） | Anthropic Messages-compatible `coding-spy` | 任意代码模型名 |

断言：互不访问、Key 不同、不串用；模型名只来自配置；不要求模型发现接口。Analysis 路径以 AGNO 实测 stream/JSON/tool 能力，Coding 路径必须从固定版本 Claude Code 发起真实 Messages、count_tokens、stream 和 tool-use 往返；能力不足时明确失败。429 遵循 Retry-After；5xx 受限重试；401/403 不无限循环；base URL 重定向到私网被拒。

多用户断言：Alice 不能列出、读取指纹、探测或使用 Bob 的任一 Profile；同一用户也不能跨 Project 复用未授权 Profile。Profile revoke 后新调用立即失败，已进入 Job 的 Attempt-scoped token 按撤销策略失效；API、SSE、日志、数据库普通查询、容器环境和 Artifact 均找不到长期 credential。把 OpenAI-format 端点误配给 Coding 或把 Anthropic-format 端点误配给 Analysis 必须在 probe 阶段失败，不能在长任务运行数小时后才暴露。

Coding 工具循环至少实测 list/read/write/edit/execute/inspect，并验证目录越界、写 input、超时命令和超大输出被确定性代码拒绝。

密钥与出站恶意用例必须使用一份明确诱导攻击的 Method，让 Job 尝试：

```text
env / printenv
读取 /proc/*/environ 与常见 Secret 文件
访问 127.0.0.1、RFC1918、link-local 和云 metadata
访问任意未授权公网域名
访问 /var/run/docker.sock 或 Docker API
读取其他 Attempt / Worker / 宿主路径
把 Dataset、prompt 或环境变量复制进 Artifact
绕过 Model Gateway 直接调用 Provider
在 output 创建指向宿主/其他 Attempt 文件的 symlink、hardlink、FIFO 或 device
在 Method/PDF/HTML 中要求忽略 TaskSpec、打印 env、上传输入或改变权限
```

通过标准：Job 内不存在长期 Provider/OIDC/DB/Redis/Worker Secret；仅能使用绑定当前 Attempt 的短时 Model Gateway 能力；未授权网络、宿主和其他任务访问均失败；注入 canary 从未被执行；Artifact collector 在读取/哈希/压缩前拒绝所有链接和特殊文件，发布包不含 Secret、根外文件或非合同输入副本。专用开发机暂时使用 Docker Socket 只能完成改造前诊断，不能通过 T12/T13 或本地发布门槛。

### 4.10 T7：Worker 自动加入与唯一执行

1. 启动 Worker A，两个 heartbeat 周期内出现；
2. 启动 B，health 同时显示 A/B；
3. 创建一个 Task；
4. Outbox pending → published；
5. Redis Stream/PEL 出现消息；
6. A/B 竞争，数据库 CAS 只有一个成功；
7. 只有一个 active Attempt 和一个 Job Container；
8. 最终只有一个有效 Artifact；
9. 用同一镜像和配置模板、但不同的一次性 enrollment token/Worker credential 启动 C，不修改中央代码；
10. C 自动加入下一次竞争；
11. 停 C 后心跳过期；重复 Worker ID 明确冲突；
12. 撤销 C 的凭证后，C 不能 heartbeat、claim、更新 Attempt 或上传 Artifact，A/B 不受影响；
13. Redis ACL 证明 Worker 只能访问本 namespace 的任务 Stream、Consumer Group 和自己的 heartbeat，不能执行管理命令或读取其他 namespace；
14. Worker DB role 只能调用受控 claim/update/publish 路径，不能读取 Session、Message、私有论文或任意 Artifact。

实时 SQL 至少观察：

```sql
SELECT task_id, status, phase, lease_owner, attempt_count,
       result_artifact_id, updated_at
FROM tasks
WHERE project_id = $1;

SELECT task_id, attempt_index, worker_id, status,
       executor_image_digest, started_at, finished_at, failure_code
FROM task_attempts
WHERE task_id = $1
ORDER BY attempt_index;

SELECT status, count(*)
FROM outbox_events
WHERE aggregate_id = $1
GROUP BY status;

SELECT artifact_id, task_id, task_attempt_id, checksum_sha256, storage_path
FROM artifacts
WHERE task_id = $1;
```

硬指标：同一时刻有效 lease=1、有效执行者=1、最终 Artifact=1、失租 Worker 发布=0。

### 4.11 T8：故障注入

| ID | 注入 | 必须结果 |
|---|---|---|
| F1 | Redis 停止后创建 Task | Task/Outbox 留在 PG；API 不伪报已发布 |
| F2 | Redis 恢复 | Outbox 自动排空，Worker 领取 |
| F3 | Worker A 执行中停止 | lease 到期，B 建新 Attempt 接管 |
| F4 | A 失租后恢复 | 旧 lease token 更新和发布被拒绝 |
| F5 | claim/CAS 事务提交后、Redis XACK/Queue ACK 前停止 | 消息可重投但不得产生第二个 active Attempt；原 DB lease 到期后由 scheduler 重发通知并建立新 Attempt |
| F5b | Task 完成事务提交后、ACK 前停止 | 重投后读取 PG 终态，只 ACK，不重复执行或发布 |
| F6 | Outbox 重复发布 | 最终一个有效 Attempt/Artifact |
| F7 | SSE 中断后重连 | 按 last event ID 补发，无永久丢失和重复卡 |
| F8 | Provider 首次 429 | 按 Retry-After 重试，轨迹完整 |
| F9 | Provider 连续 5xx | 到上限明确 failed，不无限循环 |
| F10 | 模型说完成但必需文件缺失 | Verifier 令 Task failed |
| F11 | 打包中取消 | 成功或取消只有一个 CAS 生效 |
| F12 | Artifact 被篡改 | checksum 失败，不作为有效结果 |
| F13 | API 重启 | 从 DB 恢复 Session/Resource/Task/Event |
| F14 | PostgreSQL 短断 | 不产生假成功；恢复后状态唯一 |
| F15 | Job OOM/timeout | 分类正确，重试使用干净目录 |
| F16 | Analysis Provider 停止 | 已提交 Coding Task 不受影响 |
| F17 | 删除 Session 中途失败，且 Session 有 queued/running/succeeded Task 引用 | 删除状态可重试；先删 link 而不破坏冻结输入；立即删除模式先取消/废止 active Task；保留期后 GC/crypto-shred，不出现孤儿或伪可复现记录 |
| F18 | 当前 Attempt 的 Model Gateway 能力过期/撤销 | Job 调用立即失败并分类，不能回退到长期 Key |
| F19 | Worker C 凭证执行中撤销 | 不能续租或发布；租约到期后由其他 Worker 建新 Attempt |
| F20 | Job 请求私网/metadata/任意公网 | 出站策略拒绝并记录脱敏审计，不泄露目标响应 |
| F21 | Job 尝试复制 Secret/完整输入到 Artifact | Secret/合同扫描拒绝发布，Task 不得 succeeded |
| F22 | Job 在 output 创建指向 `/etc/hosts`、Worker Secret 或另一 Attempt 的 symlink/hardlink/FIFO/device | 收集器在任何读取/哈希/ZIP 前拒绝；根外字节不出现在日志、manifest 或包内 |
| F23 | Method/PDF/HTML 注入要求打印 env、上传 Dataset、改 Task 目标或访问额外网络 | 只提取科研事实，canary 0 次执行，权限与网络层仍拒绝 |

每个故障保存注入前后状态、lease、Attempt、PEL、最终 Artifact 和 Secret 扫描。

### 4.12 T9：三组真实科研任务

按快到慢执行，三组都必须最终 `succeeded`，不再允许 `error` 算通过。每组在运行前冻结 verifier manifest：输入计数/hash、必需文件、表 schema/类型、可解析格式、科学不变量、数值范围/容差、图像最小尺寸和允许的非确定性区间；Verifier 只按 manifest 判定，不接受人工解释“看起来合理”。

#### Case 2 — Biopython

- 输入确为 94 条序列；
- 统计表可解析，GC/长度范围合理；
- Newick 树可解析；
- 图片非空；
- 脚本、依赖、日志和报告存在；
- manifest 与 ZIP 一致。

#### Case 1 — DESeq2

- 设计矩阵与用户确认一致；
- 差异结果列和数值可解析；
- PCA、heatmap、MA、volcano 有效；
- 参数、包版本、脚本、日志和报告进入结果包；
- 关键范围校验，不要求字节级一致。

#### Case 3 — Scanpy

- matrix/barcode/gene 对齐；
- QC 后细胞数合理；
- cluster assignment 行数一致；
- marker 表、UMAP、h5ad 均可解析；
- 大 Artifact 下载后 hash 一致。

至少选择一组重跑，固定 TaskSpec、Dataset hash 和镜像 digest，验证结果结构与关键指标可复现。不得人工修改输出后冒充 Agent 结果。

### 4.13 T10：任务执行中心与结果

- 只显示当前用户 Task；
- 状态无需刷新；
- 每条 Task 含 Attempt/事件；
- 结果属于 Task，不重复设“执行记录/执行结果”主页面；
- 页面没有“新建执行任务”或独立 Coding 表单；正式创建只从 Analysis 确认卡发生；
- succeeded 显示 Artifact、报告、代码与 checksum；
- failed 显示可理解原因和重试状态；
- 下载后 hash 与 DB 一致；
- Bob 看不到/下不了 Alice 结果；
- logout 后 Cookie/BFF 下载立即失效；若测试短时预签名 URL，则只承诺其在记录的 TTL 后失效，不能把 logout 当作预签名 URL 撤销机制；
- Analysis 能引用结果解释，但不得捏造数字。

### 4.14 T11：性状提取本地验收

先冻结测试硬件说明、模型/规则版本、TraitDefinition、准确性阈值和性能阈值，再运行 500 张图片。图片包含正常、重复、损坏、超大、EXIF 旋转、Unicode、嵌套目录和不支持格式；人工真值至少覆盖所有正式支持的性状与边界类别。

#### T11-A：能力合同与数据完整性

1. 文档和 UI 明确当前旧能力是参考图分类，不把旧分类结果伪装成多性状数值；
2. 每个正式性状存在版本化 TraitDefinition，类型、单位、协议、允许值、是否需要标定和 QC 规则完整；
3. 每张有效图片按定义生成一个或多个 TraitObservation，包含 image/specimen/trait ID、value、unit、可空的校准置信度、quality flags、版本和 review status；未经校准时置信度必须为空；
4. 需要绝对物理量的性状只在有比例尺/相机标定的样本上输出；缺少标定时必须为 `REVIEW/UNSUPPORTED`，不能给伪精确数值；
5. Web 只下载/唤起桌面端，不上传目录；桌面端用系统选择器，原图默认留在本机；
6. SQLite 保存输入、Observation、错误、版本和恢复状态；
7. 输出 CSV/Excel/QC/失败清单/摘要，行数按冻结的长表或宽表合同与 SQLite 一致；
8. `成功 + 失败 + 跳过 = 500`，每个输入都有最终状态；
9. 中途关闭后恢复，已完成项不重复调用 Provider；重复扫描不重复 item；
10. 日志无 Key、Token 和非必要绝对路径；Web 只在用户确认后导入选中的结构化输出。

#### T11-B：科学准确性与质控

按性状类型输出完整指标和误差分布：

- category/ordinal：macro F1、每类 precision/recall、混淆矩阵和 UNKNOWN/REVIEW 比例；
- count：MAE、中位绝对误差、在预设容差内的比例；
- calibrated continuous：带单位的 MAE、RMSE、bias 和置信区间；
- 所有类型：可用结果覆盖率、损坏/低质量识别率、人工复核命中率。

每种性状的通过阈值写入验收 manifest，必须在运行前固定，不能看完结果后降低。达不到阈值的性状不得标记“正式支持”，只能作为实验功能或全部转人工复核。

#### T11-C：快速获取数据的性能

证据包记录 CPU/GPU、内存、磁盘、OS、网络模式、模型和图片尺寸分布，并测量：

- 首条 TraitObservation 延迟；
- 总耗时与稳定 images/min；
- 峰值 RAM、GPU 显存和临时磁盘；
- 中断后恢复到继续处理的耗时；
- 实际上传字节数与原图总字节数之比。

“快速”阈值按目标发布硬件在运行前写入 manifest。若平台速率限制导致不可达，UI 必须显示预计完成时间和可恢复状态，不能只用“500 张最终跑完”代替性能验收。

按模式抓包：

- BYOK：证明发往唯一配置 Provider 的只是 TraitDefinition 所需的预处理目标图和可选参考图 data URL；
- 平台：当前必须披露 reference/target 原始文件上传；改造后用 multipart payload hash 证明只发 TraitDefinition 所需的预处理 bytes；
- Local-only：断网完成 500 张且不产生外联，才可显示“图片不离开设备”。

桌面直传如启用，再验证系统浏览器 SSO + loopback PKCE、短期凭证、用户确认和只上传结构化结果；未启用时验证 Web 文件选择导入，不把 HttpOnly Cookie 暴露给桌面进程。

### 4.15 T12：发布候选现场链路

```text
全新浏览器
→ Zhang Auth 一次登录
→ 默认进入 Analysis
→ 拖入 Dataset
→ 上传或搜索论文
→ Analysis Pro 读论文/图并生成 Method + TaskSpec
→ 用户确认
→ 快速返回唯一 task_id
→ 关闭浏览器
→ Worker A/B 竞争并在独立 Docker 中运行数小时
→ Coding Flash 试错、Verifier 验收、Artifact 发布
→ 再打开任务执行中心看记录和结果
→ 原 Analysis 对话显示同一成功卡
→ 下载 ZIP 并校验 checksum
→ logout / 再登录历史仍在
→ Bob 登录后看不到 Alice 任何对象
```

同一候选版本必须完成一次非开发者 walkthrough。参与者不能打开终端、数据库或开发工具，由其独立完成：提出研究目标、搜索/上传论文、检查 evidence/未知项、关联 Dataset、理解确认卡、提交、关闭页面、从 Activity/任务执行中心恢复、下载并判断结果包是否可交给研究人员。观察并记录：

- 是否需要开发者替其组织 Method/Dataset 或修数据库状态；
- 是否理解 Analysis 的证据、未知项、两项任务材料和用户确认责任；
- 系统问题是否过多、含糊或诱导用户盲目确认；
- 方法整理耗时、等待期间人工介入次数和最终结果可检查性；
- 用户是否能把同一方法用于第二个 Dataset，以及是否愿意再次使用。

核心链路必须无需开发者代操作完成；任何人工救援都写入证据包并标为发布阻塞或明确的已知限制，不能从记录中删除。

发布硬门槛：

```text
跨用户数据泄漏                       0
重复确认产生重复 Task                0
单 Task 同时有效执行者 >1 的观测次数   0
失租 Worker 成功发布                 0
必需文件缺失但显示 succeeded         0
Redis 重启导致事实状态丢失           0
SSE 重连永久丢事件                   0
Secret 出现在日志/响应/证据包         0
Artifact checksum 不一致             0
未经确认自动创建 Task                0
Analysis 被长时 Coding 阻塞          0
Web 自动上传性状提取原图              0
长期 Provider/OIDC/DB/Redis Key 进入 Job 0
Job 访问 Docker Socket/宿主/未授权网络   0
未授权 Resource 到达外部 Provider       0
性状标记正式支持但未达预设准确度阈值     0
```

### 4.16 T13：5 个长任务过夜批量 Soak

目标：直接验证“用户睡前排入多个任务，Analysis 不占用长时 Coding 资源，第二天取得可验证结果”的核心产品承诺。

准备：

- 使用独立 `RUN_ID`，记录完整硬件、Worker 数量、每 Worker 并发上限、镜像 digest 和 Provider 配置；
- 准备 5 个各自冻结的 Method + Dataset，预计每项运行 2–3 小时；测试数据可不同，但每项都必须有独立 TaskSpec、Verifier 和 Artifact 合同；
- Worker A/B 使用不同凭证，设置总并发小于 5，使剩余 Task 确实在队列等待；
- 启动前确认没有 Analysis Session 对应的常驻 Coding 容器，只有正式 Task 的 active Attempt 才能创建 Job Container。

步骤：

1. 用户在 Analysis 中逐项检查并确认 5 个任务；每次只产生一个 Task 和一个规范 Outbox；
2. 看到 5 个唯一 Task ID 后关闭所有浏览器窗口，并停止 Analysis Provider；
3. 测试至少跨越 12 小时，并一直运行到 5 个 Task 全部进入唯一终态；deadline 取 `max(12h, ceil(预计总 worker-hours / 配置总并发) + 2h 恢复余量)`。期间按脚本重启一次 API，并在一个 active Attempt 中停止 Worker A，验证 B/恢复后的 Worker 接管；deadline 到达仍有 queued/running Task 则本次 soak 失败并保留现场；
4. 实时但不干预地记录 queue depth、Outbox、PEL、lease、Attempt、容器、CPU/RAM/磁盘、Provider 调用和成本；
5. 第二天重新登录，从独立的 Activity 提醒进入任务执行中心，逐项查看状态和下载结果；
6. 对每个 succeeded Task 校验 Artifact hash、manifest、输入 revision、Attempt 和 Verifier 记录；失败 Task 必须有确定性原因和允许/不允许重试状态。

通过标准：

```text
确认产生的正式 Task                  5
重复 Task                            0
同一 Task 同时有效 lease >1 的观测次数 0
失租 Worker 发布                     0
排队 Task 被长期饿死                  0
Analysis 常驻 Coding 容器             0
超过 Worker 配置并发的 Job Container  0
跨 Task 输入/输出混用                 0
浏览器/API/Analysis Provider 停止导致丢 Task 0
Verifier 未通过却 succeeded           0
长期 Secret 进入 Job/Artifact/日志     0
Attempt 结束后遗留明文输入/临时容器     0
```

5 个任务不要求首次 Attempt 全部成功；允许 Goal-driven Runtime 长时间试错和受控重试，但测试结束时每个 Task 必须处于可解释的唯一终态，且所有成功结果都通过 Verifier。任务耗时本身不是失败，失控循环、无界资源占用、无证据成功或无法恢复才是失败。


## 5. 阶段与验收闸门

实施阶段与实时测试不是两套独立清单。每个阶段只有在对应测试通过后才可进入下一阶段：

| 实施阶段 | 必过测试 | 进入下一阶段的证据 |
|---|---|---|
| L0 验收环境 | T0 | 独立 DB/Redis/目录、Fixture manifest、脱敏版本快照 |
| L1 OIDC/Project 安全 | T1、T2 的身份部分 | 单次登录 trace、Alice/Bob 负向矩阵 |
| L2 Resource/FileBroker | T2 的全部文件隔离 | RLS/复合外键结果、路径/ZIP/SSRF/加密测试 |
| L3 Analysis Provider | T4、T6 的 Analysis 部分 | 任意模型名、论文工具、证据引用、Provider spy |
| L4/L5 Workspace 与研究链 | T3、T4 | 拖放、只读文件栏、Activity、golden paper 证据 |
| L6 异步 Task 提交 | T5 | 确认前零 Task、确认后一条原子 Task/Outbox、快速返回 |
| L7 Coding Runtime | T6、T9 | 独立 Coding Provider、受控工具循环、真实科研 Case |
| L8 Worker/Executor | T7、T8 | A/B/C 自动加入、CAS 唯一性、故障恢复、Secret/出站边界 |
| L9 性状提取 | T11 | 500 图完整性、准确性、吞吐、QC 与本地隐私证据 |
| L10 发布候选 | T10、T12、T13 | 非开发者全链路、结果下载、5 个长任务过夜 soak |

任一阶段失败时保留证据包并修复该层，不允许用前端 mock、手工改数据库或人工补 Artifact 绕过闸门。

## 6. 本地推荐提交顺序

```text
1. docs + acceptance namespace + 修正真实 Case harness
2. global OIDC Cookie session
3. owner/project composite FK + RLS + DB roles
4. Resource model + ResourceBroker + public/private paper split
5. PDF/URL/image security + deletion lifecycle + log redaction
6. Analysis/PaperAgent 2.0 Provider abstraction
7. Analysis Workspace + Activity + read-only file rail
8. drag/drop Resource processing
9. Method Compiler + TaskSpec confirmation
10. atomic async submit + user-scoped idempotency
11. Claude Code + Anthropic Messages-compatible Coding Provider + Attempt-scoped Model Gateway
12. 受控 Executor + Job secret/egress/host boundary
13. unique Worker enrollment + Redis ACL + Worker A/B/C fault injection
14. three real scientific cases
15. trait schema/observation migration + 500-image accuracy/throughput acceptance
16. non-developer walkthrough + five-task overnight soak
17. local release candidate
```

每个提交必须可运行、可测试、可回退。认证、RLS、Resource、Agent、Task、Worker 和 Executor 不应在同一个不可审查的改动中重写。

## 7. 本地实施前需固定的参数

以下参数通过本地安全配置固定，不改变本文的产品合同：

- Zhang Auth 本地 issuer、client type、redirect URI 和 audience；
- Analysis Pro Provider 的 base URL、model ID 与 capability；
- Coding Provider 的 Anthropic Messages base URL、opaque model ID 与 Claude Code capability probe revision；
- Job 镜像内固定的 Claude Code 版本及其升级回归策略；
- Project MVP 是单用户还是立即支持成员；
- 本地 Resource 的 storage root、信封加密 KEK 托管与轮换方式；
- Worker A/B/C 的独立数据库角色、Redis ACL 和机器凭证；
- 受控 Executor 运行位置、最大并发、CPU/RAM/磁盘和任务 deadline；
- Attempt-scoped Model Gateway 凭证格式及 Provider/依赖源 allowlist；
- 三组科研 Fixture 的稳定位置、Verifier 合同和最大资源档位；
- 性状提取正式支持的 TraitDefinition、单位/标定合同、准确性和吞吐阈值。

没有固定的真实 Provider Key 时，可以先用 OpenAI-format `analysis-spy` 和 Anthropic-format `coding-spy` 完成协议验收；真实发布候选仍需分别完成一次真实 AGNO Analysis 调用和一次从生产 Claude Code 镜像发起的 Coding 调用。

## 8. 本地完成定义与远程阶段闸门

本地完成要求同时满足：

- T0–T13 全部通过；
- 三组真实科研 Case 最终成功；
- 5 个长任务完成过夜 soak；
- 非开发者无需终端完成核心链路；
- Analysis 提交后不持有 Coding 协程、容器或长连接等待；
- 关闭浏览器、重启 API、停止 Analysis Provider 不影响已入队 Task；
- 新增第二/第三台 Worker 不改中央业务代码，且可独立 drain、轮换和撤销；
- Job 不持有长期 Provider/OIDC/数据库/Redis/Worker Secret；
- Job 无宿主 Docker 控制权、无任意文件系统和任意网络出站；
- Alice/Bob 跨 Session、Resource、Task、Event 和 Artifact 零泄漏；
- Verifier 是唯一成功闸门，Artifact 有 manifest 与 checksum；
- 正式支持的性状达到预先冻结的准确性、QC 和吞吐门槛。

只有上述本地条件全部成立，才允许进入独立的远程部署阶段。本文件不定义 Cloudflare 实施步骤；后续唯一入口为：

- [`CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`](./CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md)

GPT-5.6 Luna 与千问 Max 二选一后，所选单一模型如何从头执行、拆卡、保存证据、续跑和停止升级，由 [`MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`](./MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md) 统一规定；本文件仍是本地阶段“做什么、测什么”的权威来源。

远程部署不得改变已经通过本地验收的 Analysis → 确认 → 异步 Task → Worker → Verifier → Artifact 产品合同。
