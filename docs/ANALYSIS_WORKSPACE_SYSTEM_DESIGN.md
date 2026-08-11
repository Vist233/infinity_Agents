# Infinity Agents — Analysis Workspace 产品与系统设计

> 版本：v0.5
> 日期：2026-08-09
> 设计依据：`HANDOFF.md`、当前仓库实现、`CodeExcuteGoalDriven/Infinity_Agent_产品设计与工程实施规范_v1.0.md` 与三组可行性实验。
> 范围：先完成本地产品与安全闭环；Cloudflare 是独立的远程第二阶段，不与本地实施和验收混写。

## 0. 本版结论

Infinity Agents 不是“三个 Agent 并排聊天”的产品。正确的产品结构是：

```text
一个主 Agent + 两个功能中心

Analysis Agent（PaperAgent 2.0，唯一主 Agent）
├─ 搜论文、读论文、读图、管理会话资源
├─ 从多篇论文提炼方法证据与执行文档
├─ 关联用户数据集、整理 TaskSpec 和科学确认项
└─ 用户确认后，以异步 function call 提交 Goal-driven Task

任务执行中心（不是 Agent）
├─ 接收冻结后的 method document + dataset snapshot
├─ 展示排队、Attempt、Worker、验证和打包状态
└─ 展示并下载属于该 Task 的全部结果

性状提取（原 ImageJudge，本地数据生产能力）
├─ 从数百张田间图片批量提取性状
├─ 在本机生成结构化表型数据与质控结果
└─ 用户明确选择后，把 CSV/Excel 作为 Dataset 交给 Analysis
```

“Analysis 整合 Coding”只表示产品编排上的整合，不表示把 Coding Agent 放进 Analysis 的进程、上下文或模型调用里。长时 Coding 必须在另一套 Docker Job 沙盒中独立运行。

### 0.1 用户术语与代码迁移名

用户界面只使用三组名称：

| 用户名称 | 含义 | 当前代码/内部迁移名 |
|---|---|---|
| Analysis | 唯一主 Agent，完成论文研究、方法整理、数据关联和任务提交 | PaperAgent → Analysis |
| 任务执行中心 | Task 状态、Attempt、验证、结果与下载 | CodeAgent 页面；Goal-driven Coding Runtime 是内部执行器 |
| 性状提取 | 本地批量生产结构化表型数据 | ImageJudge；当前仍只是参考图分类器，尚需能力重构 |

后文出现 PaperAgent、ImageJudge、CodeAgent 时，只是在描述现代码或迁移位置，不表示它们仍是三个并列产品 Agent。

## 1. 产品根本目的

原始产品规范把 Infinity Agent 定义为面向生命科学研究者的 **Method-to-Result 科研任务执行系统**。实验室真正缺少的不是论文、数据或一段聊天回答，而是把已有方法和数据稳定转化为可信、可复现结果的执行能力。

完整价值链是：

```text
研究问题
→ 搜索、阅读并比较论文
→ 从每篇论文提取方法、参数、证据位置和缺失信息
→ 整理成用户可读方案与机器可执行文档
→ 关联并验证用户数据
→ 用户确认关键科学选择
→ 冻结 TaskSpec + Method + Dataset
→ 独立 Docker Worker 长时执行、排错和恢复
→ 外部 Verifier 验收
→ 返回代码、日志、表格、图片、报告与 manifest
```

允许一个 Task 执行两三小时、经历多次修复，甚至在用户离开或睡眠期间连续跑多个任务。耗时和模型试错次数不是 MVP 的失败条件；最终结果不正确、不可验证、不可恢复或越权泄漏才是失败。

### 1.1 核心对象

系统事实对象仍然是：

1. `AnalysisSession`：可反复讨论的研究会话；
2. `Resource`：完整文件不常驻、也不整份塞进模型上下文；只有经授权的最小文本片段、表头或图片可进入一次临时模型请求；
3. `TaskSpec`：用户目标、方法、参数、输入合同、交付物和验收条件；
4. `DatasetSnapshot`：冻结且可校验的数据版本；
5. `Task`：经过用户确认后创建的正式执行单元；
6. `TaskAttempt`：某个 Worker 的一次独立执行；
7. `Artifact`：经过验证、打包和校验的结果。

聊天消息不是任务事实源；Redis 不是任务事实源；模型自述“已完成”也不是成功证据。

## 2. 三个产品面的职责

### 2.1 Analysis Agent：PaperAgent 2.0

Analysis Agent 是现有 PaperAgent 的升级和改名。它保持“论文研究与方法整理”作为主任务，增加数据集关联、TaskSpec 编译和异步 Task 提交能力。

它负责：

- 理解研究问题；
- 检索 PubMed、Europe PMC、arXiv 等公共来源；
- 阅读用户上传的 PDF、HTML、Markdown 和网页；
- 对论文正文、补充材料、图表和提取图片进行理解；
- 从每篇论文提取数据类型、软件/版本、步骤、参数、输入输出和证据位置；
- 比较多篇论文并生成统一的分析/执行文档；
- 对数据集只做元数据检查、结构识别和确定性轻量验证；
- 识别仍需用户确认的分组、比较方向、阈值和科学选择；
- 草拟、修订和冻结 TaskSpec；
- 在用户明确确认后调用 `submit_goal_driven_task`；
- 使用已验证 Artifact 解释结果。

它不负责：

- 在 Web API 进程中安装 R/Python 包；
- 在同一 Agent 上下文中长时间写代码和反复排错；
- 直接运行两三小时的科研分析；
- 决定权限、重试次数、状态迁移或成功条件；
- 未经用户确认自动创建高成本 Task。

### 2.2 为什么需要“假文件系统”

论文正文、数据集和提取图片可能远大于模型上下文，不能直接塞进每轮 prompt。所谓每个 Agent 的虚拟/假文件系统，真实作用应是 **受授权的资源索引和内容代理**：

```text
物理文件 / 对象存储
        ↓
Resource 元数据与用户/项目归属
        ↓
Session 只保存 resource reference
        ↓
Analysis 工具按需读取一页、一段、一张图或一个表头
        ↓
上下文只保留摘要、引用与资源 ID
```

它不是让模型看到服务器目录，也不是依赖“文件名编码”隔离用户。模型只应看到诸如：

```text
paper://resource/{resource_id}
image://resource/{resource_id}
dataset://resource/{resource_id}
artifact://resource/{resource_id}
```

每次打开资源都必须经过 `ResourceBroker` 的当前用户、Project、Session 和用途检查。

### 2.3 Analysis Agent 应有的工具

| 工具组 | 允许能力 | 明确边界 |
|---|---|---|
| Literature Search | 搜索公共学术索引、固定结果 | 搜索结果只是候选，固定后才形成 Resource |
| Paper Reader | 按页/段/正则读取、生成 outline | 只接受授权的 `paper_id/resource_id` |
| PDF Extractor | 在隔离抽取进程生成文本和图片 | 限 CPU/内存/时间、无网络；不在 API 主进程解析不可信 PDF |
| Resource Browser | 列出当前 Session 已关联资源，读取文本片段 | 不接受绝对路径、`..`、basename 全盘递归搜索 |
| Image Reader/Vision | 读取当前论文的授权图片并送往配置的视觉模型 | 发送前检查资源出境策略并披露 Provider；不能扫描其他 Session |
| Lightweight Inspector | 查看 CSV/TSV schema、样本数、列名、文件清单 | 不做完整统计分析；不任意安装包 |
| Method Compiler | 从多篇论文生成带证据引用的执行文档 | 文档是 Task 输入之一，必须可版本化和确认 |
| TaskSpec Tools | draft、validate、freeze、submit、status | `submit` 前必须通过确定性闸门和用户确认 |
| Result Reader | 读取 manifest、报告和结构化结果 | 只引用 Verifier 已接受的 Artifact，不重新猜数字 |

Method Compiler 的核心产物不是一篇“看起来合理”的总结，而是可追溯证据矩阵：

```text
method_step / parameter / normalized_value
source_resource_id
page + section + figure/table（至少一种可定位证据）
source_excerpt_hash
conflict_with_other_sources
status = supported | conflicting | unknown | user_confirmed
```

跨论文冲突不得被静默平均或合并；论文没有说明的参数必须标为 `unknown` 并进入用户确认项。冻结 Method 时同时冻结证据矩阵与引用版本，后续可用固定 golden papers 检查参数完整度、定位正确率和冲突处理。

轻量 Python 操作只能是服务端预置的确定性函数：用于格式识别、表头/小样本检查、PDF 图片提取或确定性转换；短超时、固定依赖、无任意网络，禁止 `eval/exec`，也禁止执行模型生成的代码。任何需要安装环境、反复修复或处理完整数据的工作都转交 Docker Task。

### 2.4 Coding：异步执行能力，不是前台 Agent

前台不再展示独立的 `Coding Agent` 人格或聊天页。Analysis 的工具调用只做：

```text
submit_goal_driven_task(
  frozen_method_resource_id,
  frozen_dataset_snapshot_id,
  frozen_task_spec_revision,
  user_confirmation_id,
  idempotency_key
) → task_id
```

之后：

```text
PostgreSQL 写 Task + Outbox
→ Redis/Queue 通知
→ 独立 Worker 竞争租约
→ Worker 启动干净 Docker Job Container
→ Goal-driven Coding Runtime 执行数小时
→ Verifier 验收
→ Artifact 原子发布
```

Analysis 服务器只订阅状态并显示 Task 卡，不持有长期 Coding 上下文。这样可以：

- 避免 Web 请求和主 Agent 被长任务占用；
- 让廉价但适合代码执行的模型独立反复试错；
- 每次 Attempt 使用干净沙盒并可被其他 Worker 接管；
- 把失败恢复、并发与成功判断交给确定性系统；
- 用户一次提交多个任务后离开页面，任务仍继续运行。

用户可见、可浏览的业务材料严格只有：

```text
1. 冻结的分析/执行文档（Method Source）
2. 冻结的数据集快照（Dataset Snapshot）
```

TaskSpec revision、confirmation ID 和 idempotency key 是系统控制元数据，不是第三份用户材料。TaskSpec 只描述这两项输入的结构化合同与验收定义；Worker 不得临时读取 Analysis 的完整聊天或其他会话文件。

### 2.5 任务执行中心

任务执行中心不是第二个 Agent，而是所有异步 Task 的控制与结果界面。

它包含：

- 当前用户全部 Task；
- queued/claimed/running/verifying/packaging/succeeded/failed 状态；
- 每个 Task 的 Attempt、Worker、时间线、失败原因和重试；
- Method、Dataset 与 TaskSpec 的冻结版本和校验和；
- 结果文件、报告、脚本、日志、manifest 和下载；
- 取消、允许重试的操作。

不再单设“执行记录”和“执行结果”两个同级入口。结果属于一条 Task 记录，在 Task 详情中显示。

本地 MVP 中，任务执行中心只负责历史、状态、控制和结果；创建 Task 统一从 Analysis 的确认卡发起，避免出现第二套授权与冻结路径。Coding 的“单独使用”仍然保留：用户可新建一个 Analysis 会话，直接上传 Method + Dataset，不做论文搜索，经过同一确认卡提交。它是最短工作流，不是独立 Coding Agent 或第二套 Task API。

### 2.6 性状提取：大图片到结构化数据

原 ImageJudge 这条产品线的目标价值不是“图像聊天”，而是 **快速获取表型数据**：例如从 500 张田间照片中批量抽取叶色、病斑等级、器官计数或经过标定的物理性状，生成可继续统计分析的数据表。

但必须把目标和现状分开。当前代码是一个“参考图 + 目标图”的二图视觉分类器：`task_type` 只有 `CLASSIFICATION`，模型输出是 `predicted_category/status/spotting_features/review`，CSV 也只有图片 ID、预测类别、状态、复核与错误字段。它当前没有多性状定义、逐性状数值、Excel/QC 汇总，也不能测量株高。**把页面改名为性状提取并不代表能力已经完成。**

推荐产品名：

```text
主导航：性状提取
副标题：从本地图片批量生成表型数据
学术备选：表型数据提取
```

目标能力需要先定义可审计的数据合同：

```text
TraitDefinition
  trait_id / display_name
  value_type = categorical | boolean | count | continuous
  categories / unit / valid_range
  measurement_protocol
  calibration = none | scale_bar | checkerboard | camera_geometry
  rule_version / review_policy

TraitObservation
  specimen_id / image_id / trait_id
  value / unit
  evidence_region_or_text
  quality_status / review_required / missing_reason
```

没有比例尺、标定板或足够相机几何信息时，系统不得编造株高、叶长等绝对物理量，应返回“不支持/缺少标定/待人工复核”。第一阶段可以先支持类别型、布尔型和可直接计数的性状，并保留现有参考图分类作为兼容模式；连续物理量必须在标定链路和标注集验收通过后开放。

目标标准输出：

- CSV/Excel 性状表；
- 每张图片/性状的证据、质量与人工复核标记；只有经过校准验证的模型才显示数值置信度；
- 失败、损坏和跳过图片清单；
- 运行摘要和规则版本；
- 本地 SQLite 断点恢复状态。

每个版本都必须记录 `TraitDefinition`、规则/模型版本、测试机配置和运行清单。不能只验证“500 行都写入”，还要用标注子集按性状报告 F1/MAE/count error、coverage、人工复核率，以及首行耗时、images/min、峰值 RAM/磁盘和恢复耗时；阈值由具体性状和科学用途决定，不用一个虚假的统一置信分数替代验证。

默认数据流：

```text
原始图片目录留在用户电脑
→ 桌面端通过系统选择器扫描
→ 本地断点执行与保存
→ 生成小得多的性状表/QC
→ 用户主动选择“用于 Analysis”
→ 只同步 CSV/Excel/摘要，不自动同步原图
```

当前代码的隐私事实必须准确披露：

- SQLite、任务状态和 CSV 在本地；
- DashScope BYOK 模式使用预处理后的 reference/target data URL；
- 平台 `WorkerGateway` 当前直接 multipart 上传原始 `reference_path/target_path` 文件字节；
- 因此平台模式目前不能宣称“只发送缩放图”，更不能宣称“图片不离开设备”；
- 只有真正实现可断网运行的 `LocalModelGateway` 后，才能提供 local-only 模式。

性状提取与 Analysis 串联的是结果数据，不是把 500 张原图搬进浏览器。

## 3. 模型与 Provider 边界

Analysis 与 Coding 使用两套完全独立、且**协议不同**的 Provider 配置。不能为了统一抽象而强迫两边共用一种 API：

- Analysis/Paper 由 AGNO 驱动，调用 OpenAI-compatible API；
- Coding/长时 Docker Task 由 Claude Code 驱动，调用 Anthropic Messages-compatible API。

两边都不固定厂商或模型名。部署者或获授权的 Project 用户选择 Provider Profile；服务端保存加密后的 credential reference，浏览器不回显 Key，TaskSpec、Event、日志和 Artifact 都不得包含 Key。

```text
ProviderProfile
  id / project_id / created_by_user_id
  purpose = analysis | coding
  protocol = openai_compatible | anthropic_messages
  base_url / opaque_model_id
  wrapped_credential_ref
  capability_snapshot / probe_revision / last_verified_at
  status = draft | probing | ready | rejected | revoked
```

`purpose=analysis` 只能绑定 `openai_compatible`，`purpose=coding` 只能绑定 `anthropic_messages`。这是产品契约，不是用户可切换的高级选项。Profile 按 Project 授权且版本化；用户可以换端点、模型或 Key，但已有 Analysis Run/Task 只记录当时的 profile revision、模型 ID 和能力快照，不复制长期 Key。Alice 不能看到、测试或使用 Bob/另一 Project 的 Profile，成员撤销后也不能继续调用。兼容性探针只使用内置合成 Fixture，不得把用户论文、Dataset 或历史 Prompt 发给尚未验证的端点。

```env
ANALYSIS_MODEL_BASE_URL=
ANALYSIS_MODEL_API_KEY=
ANALYSIS_MODEL_ID=
ANALYSIS_PROVIDER_PROTOCOL=openai_compatible

CODING_MODEL_BASE_URL=
CODING_MODEL_API_KEY=
CODING_MODEL_ID=
CODING_PROVIDER_PROTOCOL=anthropic_messages
CODING_RUNTIME=claude_code
```

推荐默认档位：

```text
Analysis/Paper 研究与工具编排 → Pro / 高质量模型
Docker Goal-driven Coding     → DeepSeek Flash 或成本更低的代码模型
```

系统不得假设：

- 固定厂商或固定模型名；
- 任一端点的模型发现接口一定存在；
- 一定支持 stream、vision、tool call、JSON Schema 或 Responses API；
- 标注为“兼容”就等于通过 AGNO 或 Claude Code 的真实运行验收；
- OpenAI-compatible 与 Anthropic Messages-compatible 可以互换。

Analysis Provider 保存时必须用 AGNO 的真实调用路径探测最小聊天、流式、工具调用和项目所需的结构化输出；不支持的能力要明确记录或拒绝，不能只检查 `/models`。

Coding Provider 保存时必须在与生产相同版本的 Claude Code Job 镜像中运行兼容性探针。最低契约是 Anthropic Messages 的 `/v1/messages` 与 `/v1/messages/count_tokens`，正确处理流式响应、tool-use/tool-result、错误码，并保留 `anthropic-version` 与 Claude Code 需要的 `anthropic-beta` 语义。模型 ID 是不透明配置值；模型发现失败时仍可使用显式配置。只有探针完成“读冻结输入 → 调工具 → 写输出 → 正常结束/取消”的小任务后，Provider Profile 才能标记为 `ready`。

平台长期 Coding credential 只存在于受信 Model Gateway。Job 只获得当前 Attempt 可撤销的短期 Gateway URL/token，由 Worker 映射成 Claude Code 使用的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL`；不得把用户的长期 Provider Key 注入容器。即使底层模型来自 Qwen、DeepSeek 或其他厂商，只要使用 Coding 通道，就必须通过这条 Claude Code + Anthropic Messages 契约。

协议依据：[Claude Code LLM gateway](https://code.claude.com/docs/en/llm-gateway)、[Claude Code model configuration](https://code.claude.com/docs/en/model-config)。兼容状态绑定 `Claude Code version + gateway revision + exact model ID`，任一项升级后重新验证。

服务端可配置的 `base_url` 必须防 SSRF：HTTPS、解析后拒绝私网/loopback/link-local/metadata、每次重定向重验、限制 DNS 与响应大小。API Key 进入 Provider Profile 时立即写入 Secret Store/信封加密字段，读取接口只返回末尾指纹，绝不进入 TaskSpec、Event 或日志。只有 `APP_ENV=development|acceptance` 时，运维配置才可为本地测试端点启用精确的 `scheme + host + port` allowlist；地址不能来自普通任务输入，生产启动时若仍允许 loopback/private endpoint 必须 fail closed。这样可测试 OpenAI-format 的 `analysis-spy` 与 Anthropic-format 的 `coding-spy`，但不会把测试例外变成生产 SSRF 绕过。

模型调用本身也是数据出境。论文片段/图片、Coding 命令输出和性状图片都可能被发送给外部 Provider。每个私有 Resource 必须带 `egress_policy=local_only|provider_allowed`、允许的 Provider 目的地和保留策略；`ResourceBroker` 在发送前检查用途与策略，审计只记 Resource ID 和目的地，不记正文。未授权字节不得进入任何 Provider 请求。“严格本地”只有在本地模型可断网完成相应能力时才能展示。

## 4. 全局 Zhang Auth OIDC

用户只认证一次：

```text
Infinity Agents
→ /auth/login
→ Zhang Auth OIDC Authorization Code + PKCE
→ /auth/callback
→ 建立 Infinity 第一方 HttpOnly Session Cookie
→ 返回原页面
```

同一个 Web Session 覆盖：

- Analysis 会话与资源；
- TaskSpec、Task、Event 与 Artifact；
- 任务执行中心；
- 性状提取网页入口及可选结果同步。

浏览器不得持有公开共享的 `TASK_API_TOKEN`。REST、SSE、WebSocket 都通过同源 Cookie 解析同一个 `Principal`。长期 access token 不进入 Local Storage、URL query 或前端构建变量。

HttpOnly Cookie 不能也不应直接交给性状提取桌面程序。如果 MVP 由用户手动把本地 CSV/Excel 拖回 Analysis，桌面端完全不需要登录；如果以后提供“一键同步”，桌面端使用系统浏览器触发同一 Zhang Auth SSO，并以 Authorization Code + PKCE 和 loopback/custom-scheme callback 换取独立、短期、最小权限凭证。用户通常无需再次输入账号，但协议上不是复用 Web Cookie。

Worker 是机器身份，不参加用户 OIDC。每台 Worker 使用可撤销的独立凭证，只能领取被授权的 Task、更新自己的 Attempt、上传该 Task 的 Artifact；长期目标是走 Worker Control API，而不是直连拥有广泛权限的 PostgreSQL/Redis。

## 5. 信息架构

### 5.1 主导航

主导航固定为：

```text
Analysis
任务执行中心
性状提取
```

导航下面直接显示两个兄弟区块，而不是再增加按钮或页面：短暂的 `Activity`，以及持久的“最近对话”。

```text
+ 新建分析

ACTIVITY

正在进行 / 待查看
↻ Airway DESeq2        运行中 2h 13m
✓ PBMC Task            结果待查看
! dataset.zip          处理失败

最近对话
● Airway RNA-seq       任务运行中
○ PBMC clustering
○ Orchid FASTA
```

不设置 `Recent Tasks` 按钮。“最近对话”只列 Analysis Session，按最近消息排序；Task 永久历史在任务执行中心。

Activity 只回答“现在有什么需要我关注”：queued/running、等待确认、失败待处理和完成未读。用户看过结果后，该提醒从 Activity 消失；最近对话仍存在，Task 也仍永久保存在任务执行中心。论文搜索、PDF 解析、读图等细粒度工具调用只在当前对话内折叠为“处理过程”；文件正常处理状态主要由右栏承担，只有失败/待处理才进入 Activity。性状提取只有在本地 Companion 明确同步状态或用户导入结果时才出现，Web 不假装实时掌握本地目录。

### 5.2 Analysis 桌面端 ASCII 线框

```text
┌────────────────────┬──────────────────────────────────────────┬────────────────────────┐
│ Infinity Agents    │ Analysis                                 │ 当前分析输入         3 │
│                    │ Airway RNA-seq                            │                        │
│ ● Analysis         ├──────────────────────────────────────────┤ 方法 / 论文             │
│ ○ 任务执行中心      │                                          │ ● DESeq2 workflow.pdf   │
│ ○ 性状提取          │ 用户：分析地塞米松对 airway 的影响       │   已就绪 · 1.8 MB       │
│                    │                                          │ ● generated-method.md   │
│ ＋ 新建分析         │ Analysis：我阅读了 6 篇论文，并整理出     │   已就绪 · rev 3        │
│                    │ 一份可执行方法。还需要确认比较组。         │                        │
│ ACTIVITY           │                                          │ 数据集                  │
│ ↻ Task 运行中      │ ┌─ 处理过程 ─────────────────────────┐   │ ◌ airway-data.zip      │
│ ✓ 结果待查看       │ │ 文献检索       6 篇             ✓ │   │   正在校验 · 63%       │
│ ! 文件处理失败     │ │ 论文/图阅读     4 篇/12 图        ✓ │   │                        │
│ 最近对话           │ │ 执行文档生成    rev 3             ✓ │   │                        │
│ ● Airway RNA-seq   │ │                                    │   │                        │
│   PBMC clustering  │ │                                    │   │                        │
│   Orchid FASTA     │ │                                    │   │                        │
│                    │ └────────────────────────────────────┘   │                        │
│                    │ ┌─ 执行任务确认 ───────────────────────┐  │                        │
│                    │ │ 方法：generated-method.md       ✓    │  │ 文件只显示状态。        │
│                    │ │ 数据：airway-data.zip           ✓    │  │ 将文件拖入对话区上传。  │
│                    │ │ 比较：treated vs untreated      ✓    │  │                        │
│                    │ │          [修改方案] [确认并执行]      │  │                        │
│                    │ └──────────────────────────────────────┘  │                        │
│                    │                                          │                        │
│                    │ ┌─ Task Airway DESeq2 ────────────────┐  │                        │
│                    │ │ 运行中 · Attempt 1 · Worker A        │  │                        │
│                    │ │ 当前：差异表达分析                   │  │ 这里只列论文、Method、 │
│                    │ │                    [查看运行详情]     │  │ Dataset/性状表等输入。 │
│                    │ └──────────────────────────────────────┘  │ 成果在 Task 详情中。    │
│                    │                                          │                        │
│                    │ [📎] 输入问题或把文件拖到这里…      [↑] │                        │
└────────────────────┴──────────────────────────────────────────┴────────────────────────┘
```

右栏是窄的只读状态栏，不是大型上传区。MVP 只显示文件名、类型、状态、大小和是否用于当前分析；不在此编辑文件。上传通过拖入中间对话区完成，同时保留回形针按钮以支持触屏、键盘和可发现性。

文件拖入后，对话附件条与右栏同步显示：

```text
uploading → processing → validating → ready | failed
```

搜索结果在被固定或生成 Method 之前不算文件；大图片目录禁止拖入 Web，应转到性状提取桌面端。

### 5.3 任务执行中心

```text
任务执行中心

全部  排队中  运行中  已完成  失败

┌───────────────────────────────────────────────────────────────┐
│ Airway DESeq2       成功       1 次尝试       12 分钟前       │
│ 方法：generated-method.md    数据：airway-data.zip           │
│                               [下载成果] [查看运行详情]       │
├───────────────────────────────────────────────────────────────┤
│ PBMC clustering     运行中     2 次尝试       当前 verifying  │
│                               [查看运行详情] [取消]           │
└───────────────────────────────────────────────────────────────┘
```

Task 详情默认显示用户可理解的阶段；原始 Event、lease token 和技术日志折叠。结果下载、校验和、报告与代码都放在同一 Task 详情中。

### 5.4 性状提取界面

Web 页负责解释价值、下载/唤起桌面端和可选导入结果；桌面端负责真实目录处理。下图是完成能力重构后的目标界面，不是当前分类器已经具备的界面：

```text
性状提取
从本地图片批量生成表型数据

[选择本地目录]  500 张图片
[选择/定义性状规则]

处理进度  312 / 500
成功 298  失败 9  跳过 5

[导出 CSV] [导出 Excel] [查看质控] [用于 Analysis]
```

“用于 Analysis”默认只选择结构化输出，不选择原图。

### 5.5 小屏幕

右栏只列当前 Analysis Session 已关联的论文、Method、Dataset 或性状表及 `uploading → processing → validating → ready|failed` 状态，不放 Artifact 或下载按钮。成果只出现在对话中的 Task 卡与任务执行中心详情；若用户让 Analysis 解释旧结果，右栏最多显示“已关联自 Task X”的输入引用。小屏幕保留主对话；左导航和右文件状态分别变成 Drawer。Task 状态卡留在消息流，不把三栏强行压缩到手机宽度。

## 6. 资源隔离与文件安全

### 6.1 当前代码审计结论

入口层已有一部分正确控制：OIDC 验证、Session REST/上传/历史按 `session_id + user_id` 检查、旧无 Session 文件接口已禁用、共享论文 HTTP 下载会检查 Session 链接。

但当前实现还不能称为多租户安全，主要问题是：

| 优先级 | 当前事实 | 风险 |
|---|---|---|
| P0 | 每个 PaperAgent 的 `FileSystemTools`/`ImageAnalysisTools` 都允许整个 `papers/cache`，工具层不查 Session 授权 | 用户可通过 Agent 枚举/读取其他会话缓存，图片还可能被发给外部模型 |
| P0 | 直接 PDF URL 缺少完整 SSRF 防护、流式大小限制，并写入全局缓存 | 可访问私网/元数据或把私有 URL 内容升级为全局可见 |
| P0 | Task API 使用共享 Token，未设置时开放；默认 Project 全局共享 | 用户可列出、取消或下载他人的 Task/Artifact |
| P0 | `create_task`、idempotency 与 Outbox 分开提交且吞异常；幂等表是复合主键，代码却只对 `idempotency_key` 做冲突目标；Endpoint 还会再写一条 Outbox | 网络重试可能创建多个 Task，同一 Task 产生重复通知，数据库事实与队列不能原子一致 |
| P0 | 旧任务页上传 ZIP 后直接提交 `validation_passed=true`，没有真实数据验证 | 未检查的数据被伪装成已通过，Task 可在错误输入上长时运行 |
| P0 | `docker-compose.local.yml` 把宿主 `/var/run/docker.sock` 挂给 Worker | Worker 被攻破通常等同取得执行宿主高权限，不能把当前结构称为生产沙盒 |
| P0 | Job 未配置 `CODE_AGENT_JOB_NETWORK` 时使用默认可出站网络，并把 Worker 中全部 `ANTHROPIC_*`/`STEPFUN_API_KEY` 长期密钥原值注入 Job | 模型生成的代码可读取环境并外传密钥、扫描内网或访问 metadata；“密钥未写进镜像”不等于安全 |
| P0 | Artifact 收集使用 `is_file()` 后再 `zip/write/read_bytes`，会跟随 Job 在 output 中创建的 symlink | 恶意或失控 Job 可诱导受信宿主打包并泄露 output 根目录以外的宿主文件 |
| P0 | Coding Prompt 要求直接“follow” Method 文档，而 Method/PDF/HTML 来自外部且可能含提示词注入 | 文档可诱导 Agent 打印环境变量、越权联网、读取其他文件或改变 Task 目标 |
| P0 | 当前 `infinity-redis` 在无需认证时返回 PONG，且容器把 6379 发布到所有主机接口 | 可达该端口的进程/设备可读写队列、伪造任务通知或 Worker 心跳；只能作为临时本地开发状态 |
| P0（未激活） | 图片 Base64 回填函数会递归遍历所有 Session 并按 basename 搜索 | 后续启用即形成跨会话图片泄漏 |
| P1 | `sessions.user_id`、Task `created_by` 等可为空，子表只凭 UUID，缺少 RLS 与同 Project 复合外键 | 任一遗漏 owner 条件的查询都可能越权，Method/Dataset/Task 可被跨 Project 错配 |
| P1 | 原始路径、签名 URL、论文正文与大量工具结果明文存储；Agent `debug_mode=True` | 主机结构、文档内容和敏感 URL进入响应、DB或日志 |
| P1 | Web 删除 Session 只删数据库，不清磁盘目录、内存 Agent；本地目录/文件通常权限过宽 | 数据长期残留、同机其他用户可读 |
| P1 | 路径边界部分使用字符串前缀或 basename 递归搜索 | 相邻目录前缀、symlink/TOCTOU 和碰撞风险 |
| P1 | 不可信 PDF 在 API 主进程内解析 | 恶意文件、解析器漏洞或资源耗尽影响整个服务 |
| P1 | Worker/Outbox/API 可共用广权限 PostgreSQL 凭证 | Worker 被攻破后可读聊天和用户资源元数据 |

在这些问题修复前，不能因为 HTTP 文件接口做了 Session 检查就认为 PaperAgent 文件已经隔离。

### 6.2 编码、哈希与加密分别解决什么

```text
Base64 / URL encoding     只改变表示，零保密能力
随机 UUID / HMAC key     隐藏名称和降低猜测，不提供授权
SHA-256                  检查完整性/版本，不提供保密
数据库 owner/RLS         阻止跨用户访问，是第一优先级
信封加密                 降低磁盘、备份或数据库泄漏后的明文暴露
```

加密不能修复“已授权服务器代码错误地替 Bob 读取 Alice 文件”的应用漏洞。顺序必须是：资源授权 → 数据库约束/RLS → 安全文件代理 → 再做加密。

### 6.3 推荐资源模型

```text
app_users
  user_id
  oidc_issuer
  oidc_sub
  UNIQUE(oidc_issuer, oidc_sub)

projects
  project_id
  owner_user_id NOT NULL

project_members
  project_id
  user_id
  role

analysis_sessions
  session_id
  project_id
  created_by_user_id NOT NULL

project_resources
  resource_id                  # 完整随机 UUID
  project_id
  created_by_user_id
  kind                         # paper/method/dataset/image/artifact/report
  visibility                   # private/project/public
  egress_policy                # local_only/provider_allowed
  allowed_provider_id/retention_policy
  opaque_storage_key
  display_name_encrypted
  content_type
  plaintext_size
  checksum_sha256
  integrity_hmac
  wrapped_dek
  encryption_nonce/version
  processing_status
  created_at/deleted_at

session_resource_links
  project_id
  session_id
  resource_id
  purpose

public_paper_catalog
  paper_id
  provenance                   # arXiv/PubMed/PMC 等可信公共来源
  public_resource_id
```

`project_id` 是强租户边界，`created_by_user_id` 只记录创建者，不替代 Project 授权。MVP 每个 Project 可先只有一个 owner；团队模式下 `private` 只允许创建者/管理员、`project` 允许当前成员、`public` 只能指向经证明的公共目录对象。所有父子关系都带 `project_id` 并使用复合外键。TaskSpec、MethodSource、DatasetSnapshot、Task 和 Artifact 也必须通过复合外键保证属于同一 Project，数据库本身拒绝把 Project A 的 Method 与 Project B 的 Dataset 组成 Task，即使两者属于同一个用户。

只有来源可证明为公共学术库的内容进入 `public_paper_catalog`。用户上传、带签名 URL、内网 URL 和无法证明公共性的外部文档一律是私有 Resource；即便内容哈希相同，也不能自动把访问权授予另一个用户。成员被撤销后，旧 Resource、Task、事件和下载票据都必须重新按当前 membership 判断，不能依赖创建时权限缓存。

### 6.4 PostgreSQL RLS

每个 OIDC 请求在数据库事务内：

```text
(issuer, sub) → internal user_id
BEGIN
SET LOCAL app.user_id = '<uuid>'
执行带应用层授权的查询
RLS 再做数据库级兜底
COMMIT
```

必须使用 `SET LOCAL`，避免连接池把 Alice 身份带到 Bob 请求。租户表启用并强制 RLS；API 角色不是表 owner、没有 `BYPASSRLS`；策略同时定义 `USING` 和 `WITH CHECK`。应用层仍显式检查 Project membership，RLS 用于防止代码漏写 owner 条件。

数据库角色至少拆分：

- migration：唯一 DDL 权限；
- analysis API：受用户/Project RLS；
- task API：受 Task/Project RLS；
- scheduler：仅队列、租约和状态机函数；
- worker：仅领取/更新指定 Task 的受控函数；
- 不允许 Worker 读取 messages、私有论文正文或任意资源表。

### 6.5 ResourceBroker

Paper/Analysis 工具不再接收 `allowed_dirs=[whole cache]`，改成：

```text
ResourceBroker.open(
  principal,
  project_id,
  session_id,
  resource_id,
  purpose="read_text|read_image|model_vision|task_input"
)
```

Broker 先查授权/RLS，再以不跟随 symlink 的方式打开文件。工具列表来自数据库授权结果，不从磁盘递归发现；响应不返回绝对路径，只返回 Resource ID、显示名、类型、大小和状态。

图片响应使用：

```text
GET /api/resources/{resource_id}/content
```

由同源 HttpOnly Cookie 鉴权。不要把大图 Base64 塞进 SSE，不要在 `<img src>` query 中放长期 token，也不要按 basename 跨目录搜索。

### 6.6 信封加密与明确的阶段门槛

对私有论文、用户数据集、提取文本、方法文档和 Artifact 使用每对象信封加密：

1. 每个 Resource 生成随机 256-bit DEK；
2. 使用 AES-256-GCM 或 XChaCha20-Poly1305；
3. AAD 包含 `project_id + resource_id + version + content_type`；
4. 用 KEK 包装 DEK；
5. DB 只存 wrapped DEK、nonce、版本和 opaque key；
6. KEK 放 macOS Keychain/Vault/KMS/Cloudflare Secret，不与数据库同处；
7. 大数据采用分块认证加密；
8. Worker 只获得单个 Attempt 所需资源的短期解密能力；
9. 解密目录为 `0700`，文件 `0600`，Attempt 结束可重试清理。

门槛固定如下，不再悬而未决：

- 本地功能验收环境：必须先完成 OIDC、Project/RLS、ResourceBroker、最小文件权限与删除清理；可依赖 FileVault/加密卷做静态存储保护，但 UI 和文档必须标为“本机开发环境”，不能宣称应用层密文隔离；
- 任何真实多用户公网/Cloudflare 发布：私有 Resource、提取正文、敏感消息和凭据字段必须完成应用层信封加密与密钥轮换测试，才允许上线。

tenant-keyed HMAC 只作为内部等值/完整性索引，避免向其他租户暴露相同文件指纹；为科研复现，Artifact manifest 仍保存 SHA-256，但只向有权访问该 Artifact 的用户展示。

### 6.7 上传、抽取、下载与删除

- 上传使用随机 storage key，原始文件名只作显示元数据；
- 流式限长，检查 magic/MIME、文件数、ZIP Slip、解压总量和压缩比；
- PDF 抽取进入低权限、无网络、限资源的短任务容器；
- 失败或断连时清理半文件和孤儿元数据；
- Artifact 下载先检查 Task → Project → Membership，使用短时单对象票据；
- 文件使用 `Content-Disposition` 与 `nosniff`，不把 HTML/SVG 当同源主动内容直接渲染；
- 删除采用资源引用图驱动的可重试状态机。删除 Session 先撤销 `session_resource_links` 并清理会话内存/临时文件；被冻结 TaskSnapshot、运行中 Attempt、Artifact manifest 或复现保留期引用的 immutable Resource 不得直接删除；
- 明确定义原始资源、提取文本、日志、备份和 Artifact 的保留期限。

数据库用 `resource_references/retention_lease` 与复合外键记录引用，而不是只靠磁盘 refcount。无引用且过保留期的私有对象进入 `gc_pending → object/DEK cleanup → audit complete`；公共论文只撤销当前 Project 的 link。若用户要求立即删除依赖 Task 的输入，queued/running Task 必须先以 CAS 取消/废止并拒绝续租、重试和发布；已终态 Task 标为 `input_revoked/result_withdrawn`，撤销 Artifact 下载和结果解释能力，再按删除/法律保留策略 GC 或 crypto-shred DEK。不能留下一个看似可复现但输入已经消失的成功记录。

### 6.8 Goal-driven 执行隔离与密钥边界

当前 `cap-drop/read-only/pids/CPU/memory` 是有用的基础限制，但无法抵消 Docker Socket、默认出站网络和长期模型密钥注入。目标边界是：

```text
Task Control API
  → 独立 Worker 身份
  → 受控 Executor API（生产不暴露宿主 docker.sock）
  → 每 Attempt 一次性 Job
       input: 只读、只含冻结 Method + Dataset
       output: 单独可写目录
       network: 默认拒绝
       model: 仅访问 Worker 侧 Gateway，使用 per-attempt 短期能力
```

硬规则：

- Job 永远拿不到 OIDC Cookie/token、数据库 URL、Redis 凭据、Worker 凭据或长期 Provider API Key；
- Provider Key 只存在于 Worker 侧模型 Gateway/Secret Store；Job 最多持有绑定 `task_id + attempt_id + model + expiry + budget` 的短期不透明票据；
- 出站默认拒绝，只允许模型 Gateway、单对象存储票据和经批准的依赖代理/镜像；包安装走带锁文件的缓存或 allowlist proxy，不开放任意互联网；
- Job 以非 root 运行，保留 `cap-drop=ALL`、`no-new-privileges`、只读根、seccomp/AppArmor、CPU/内存/PID/临时盘/总时长限制；不挂任何宿主 Socket 或无关目录；
- 生产 Worker 运行在独立执行主机/池，通过窄化 Executor API、rootless 容器或更强隔离运行时启动 Job；Web/API 主机不挂 Docker Socket；
- 本地受控 Worker 使用相同镜像和配置模板，但使用不同的可撤销机器凭证；本地 Redis 至少使用 TLS、ACL、独立 namespace/consumer 身份；
- 远程学生 Worker 永远只走 HTTPS Worker Control API，不直接获得 D1/PostgreSQL、Redis、Cloudflare Queue、R2 parent credential 或 Provider Key；
- Attempt 结束后清理明文输入、临时目录、容器和短期票据，Artifact 只有 Verifier 通过后原子发布。

安全验收必须提交恶意 Task，尝试读取 `env`、`/proc`、其他 Attempt 目录、Docker Socket、localhost/私网/metadata 和任意公网，并扫描日志与 Artifact 中的 Secret；所有越界访问必须失败。撤销某台 Worker 凭据后，该 Worker 不能再 claim、续租或上传结果。

## 7. Analysis 到 Task 的确定性边界

创建 Task 的硬条件：

```text
authenticated user
+ project membership
+ frozen method resource ready
+ frozen dataset snapshot ready
+ TaskSpec schema valid
+ deterministic dataset validation passed
+ all required scientific confirmations completed
+ explicit user confirmation
+ unused/idempotent confirmation key
= one queued Task
```

Analysis 可以建议，但模型不能伪造确认。确认前 PostgreSQL 不增加 Task、Redis 不增加执行消息、Worker 不创建 Job Container。

确认事务应原子完成：

```text
freeze Method revision
+ freeze Dataset Snapshot
+ freeze TaskSpec revision
+ insert Task
+ insert TaskEvent
+ insert OutboxEvent
+ store user-scoped idempotency record
```

现有 `backend/code_agent/task_service.py` 的这些写入是分开的，且 `backend/app.py` 会追加第二个 Outbox；改造时必须收敛到一个数据库事务和一个规范事件。幂等唯一键建议为 `(user_id, action, idempotency_key)`，同时保存 `request_hash`：同 key 同请求返回原 Task，同 key 不同请求返回冲突。双击、网络重试和多标签页并发都必须返回同一个 Task ID。

## 8. Task 状态与结果返回

Analysis 中显示嵌入式 Task 卡：

```text
Task: Airway DESeq2
Status: running · Attempt 1
Worker: local-worker-a
Phase: executing

[查看运行详情] [取消]
```

成功后：

```text
Task succeeded
✓ result.zip
✓ report.html
✓ manifest.json
✓ scripts/

[下载成果] [让 Analysis 解释结果]
```

Verifier 是唯一成功闸门。结果包至少包含代码、环境/依赖、参数、日志、关键中间结果、表格、图、报告、manifest 校验和以及冻结 TaskSpec。Analysis 解释时读取这些事实对象，不重新生成或猜测结果数字。

## 9. 本地目标拓扑

```text
Browser :3000
    │ global OIDC session cookie
    ▼
Next.js + FastAPI/BFF :8008
    ├─ Analysis Agent (PaperAgent 2.0)
    │    └─ Pro OpenAI-compatible Provider
    ├─ ResourceBroker + isolated PDF/image tools
    ├─ Task Control API
    ├─ PostgreSQL :5450 (truth + RLS)
    └─ Redis :6379 (queue/events only)
             │
             ▼
      Worker A / B / C
      （逐机唯一凭证）
             │
             ▼
      受控 Executor / 独立执行主机
             │
             ▼
      isolated Job Containers
             └─ Claude Code Goal-driven Runtime
                  └─ per-attempt token → Worker 模型 Gateway
                                             └─ 用户配置的 Anthropic Messages-compatible Provider

性状提取桌面端（目标；当前 ImageJudge 分类器待迁移）
    ├─ local image directory + SQLite
    ├─ local/BYOK/platform gateway with explicit disclosure
    └─ CSV/Excel/QC → user-approved import to Analysis
```

## 10. Cloudflare 第二阶段边界

Cloudflare 远程阶段只在本地 T0–T13 全部通过后开始。它把 Web、Analysis 编排和控制事实迁入 Cloudflare，但不把长时 Docker 科研计算搬进 Cloudflare Worker。

```text
Browser
  → Static Assets
  → web-edge（OIDC/Cookie/CSRF/限流；无 D1 binding）
       ├─ Service Binding → internal state-service（唯一 D1 binding）
       │                      └─ D1：Session/Resource/Task/lease/Artifact 事实
       ├─ Service Binding → Analysis Session Durable Object
       │                      ├─ 按模型/工具步骤 checkpoint
       │                      ├─ Pro OpenAI-compatible Provider
       │                      └─ 只读取已授权的 R2 文本块/图片引用
       └─ private R2：quarantine / encrypted canonical / Artifact

D1 Task + Outbox
  → after-commit / Scheduled Flusher
  → Cloudflare Tunnel
  → 2C2G Private Task Relay
  → loopback/Unix-socket Redis（只含 opaque task hint）

Student Worker
  → WORKER_CONTROL_BASE_URL（enroll / offer / claim / heartbeat / finalize）
  → WORKER_GATEWAY_BASE_URL（当前 Attempt 的 Resource / Model / Artifact data plane）
  → 两个公网入口都无通用数据库/Redis接口，内部再调用固定 State RPC
  → 本地 Docker Job → quarantine → 受信 Verifier → canonical Artifact
```

Cloudflare 是平台管理员只部署一次的中心服务，不是学生或普通用户的安装依赖。学生节点不登录 Cloudflare、不创建 Worker、不配置 Tunnel，也不持有 Cloudflare Token；安装 Docker Worker 后只填写上述两个 HTTPS base URL，并用管理员签发的一次性 enrollment token 完成加入。所有短时下载、模型调用和结果上传 URL 都保持在 Gateway origin 下，不能要求学生再配置 D1、R2、Redis、Queue 或 Provider 地址。

远程主线选择 Cloudflare-native D1，因为现有线上 PaperAgent 已使用 Cloudflare Worker、D1 Session data 和同源 API。D1 没有 PostgreSQL RLS，因此不能声称它自动完成租户隔离：只有内部 `state-service` 持有 binding；所有表带 `project_id`；父子关系使用复合键/外键；每条固定 prepared query 同时检查 Project membership；响应使用字段 allowlist；Alice/Bob、同用户跨 Project、成员撤销和猜 ID 都是发布阻断测试。若以后因容量、复杂事务或合规改用 PostgreSQL + Hyperdrive，它只能作为一次明确迁移后的唯一事实源，不能与 D1 无协议双写。

Paper/Analysis 仍运行在 Cloudflare，但 10 ms 约束只适用于 Cloudflare Workers 请求中的 CPU，Edge 请求只负责小型授权、状态和调度。它不约束 2C2G 上的 Redis/Task Relay，也不约束学生电脑中的 Docker Job。Analysis Session Durable Object 把一次研究回合拆成可恢复步骤；模型与搜索等待属于 I/O，PDF/OCR、ZIP、图片抽取、大正文解析、分块加解密和科学验证则交给 Tunnel 后受信 Resource Processor。若当前只有这台 2C2G 服务器，可以临时共置并发 1、带 cgroup 硬上限的确定性 PDF 抽取器；Agent、模型代理和 Docker Job 不与 Redis 共置，压测不满足余量时必须拆机。

2C2G 服务器即使有公网 IP，也不开放 6379 或 Relay origin 端口。Redis 只绑定 loopback/Unix socket，启用 protected mode、ACL、内存上限和 TTL；`cloudflared` 只建立出站 Tunnel。浏览器和学生 Worker 只调用 Cloudflare HTTPS API，既看不到 Redis 地址/密码，也不能传 raw command/key。Redis 被清空、注入重复 hint 或暂时离线时，D1 Task/Outbox 仍可重建队列；第一版不强制再叠一套 Cloudflare Queues，只有真实吞吐或托管重试需要时再加入。

学生电脑属于不可信执行域。短期能力和 Docker 不能阻止电脑所有者复制已经交给它的明文，因此学生节点只允许 `public/sanitized` Task；`private/regulated/local_only` 只能进入用户自己的电脑或机构受信节点。结果先写 Attempt quarantine，只有 fencing、内容扫描和受信 Verifier 全部通过后才成为正式 Artifact。

应用层信封加密启用后，浏览器直传只能写入私有、短生命周期、不可下载的 quarantine/staging key。可信 Ingress Service 流式校验并加密，再把密文原子提升为 canonical Resource，提交 DB `ready` 状态后删除 staging；清理器回收超时残留。MVP 下载由 BFF 授权后经可信 Resource Service 流式解密，canonical 私有密文不直接签发明文 GET。未来若设计客户端加解密协议，才可把密文预签名 GET 交给客户端。

完整的 10 ms CPU 预算、D1 无 RLS 的补偿、学生 Worker 协议、2C2G 资源限制、攻击面和远程验收门槛见 `docs/CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`。

远程阶段可以分步在离线/预生产环境实现和验收，但不能把未完成安全门槛的“轻量版”先暴露给真实用户。要么全部远程发布门槛通过后由管理员一次切换到生产公网，要么继续使用已经验收的本地模式。

## 11. 代码改造落点

### 后端

- `agent/paperAgent.py`：改为 Analysis 定位；移除整个共享缓存作为文件工具目录；生产关闭 debug；Provider 抽象。
- `agent/tools/file_tools.py`、`image_analyzer.py`：改用 ResourceBroker 和逻辑 ID，删除 basename 全盘搜索。
- `agent/tools/paper_search.py`：公共/私有缓存分流、SSRF 防护、流式限长与重定向重验。
- `backend/app.py`：全局 OIDC Cookie、统一 Resource API、Task API 用户授权、安全图片响应、删除状态机。
- `backend/db.py`：版本化 migration、owner/project 复合外键、RLS、资源与审计表；运行进程不再自动 DDL。
- `backend/code_agent/*`：Task 创建原子事务、用户级幂等、Claude Code Runtime、Anthropic Messages-compatible Provider Profile、Worker 最小权限、per-attempt 模型 Gateway 能力。
- `backend/code_agent/worker/docker_runtime.py`：默认拒绝网络，删除长期 Provider Key 透传，接入受控 Executor 与短期票据。
- `docker-compose.local.yml`：隔离验收 namespace、Redis ACL/TLS、专用 DB 角色、逐 Worker 凭证和一致的上传/Artifact 路径；生产模板移除宿主 Docker Socket。
- `image-judge/apps/desktop/imagejudge/model/*`、`export/*`：保留分类兼容模式，新增 TraitDefinition/Observation、多性状投影、标定与 QC；平台上传改为预处理 bytes。

### 前端

- `frontend/components/chat/AgentNav.tsx`：改为 `Analysis / 任务执行中心 / 性状提取`，后续改名 `WorkspaceNav`。
- `frontend/app/page.tsx`：标题改为 Analysis；增加拖放层、右侧只读文件状态栏和 Activity。
- `frontend/components/chat/Composer.tsx`：真正实现附件按钮、拖放和附件状态条。
- `frontend/hooks/use-chat-controller.ts`：管理 Resource 状态、确认卡与 Task 卡，后续改名 `use-analysis-controller`。
- `frontend/lib/api/sessions.ts`：移除上传 stub，迁移到统一 Resource API。
- `frontend/components/chat/MessagePane.tsx`：结构化渲染 Activity、TaskProposal、TaskRun 和 Result 卡。
- `frontend/app/code-agent/page.tsx`：去掉 Coding Agent 人格，改为任务执行中心。
- `frontend/app/image-judge/page.tsx`：改名性状提取，突出批量表型数据与真实隐私模式。
- `frontend/lib/i18n.tsx`：统一新产品文案。

MVP 可保留 URL，减少迁移风险：

```text
/                 → Analysis
/code-agent       → 任务执行中心
/image-judge      → 性状提取
```

## 12. 本地产品完成定义

本地 MVP 完成必须同时满足：

1. 用户一次 Zhang Auth 登录覆盖整个 Web；桌面同步若启用则通过同一 SSO 的独立 PKCE 短期凭证；
2. Analysis 能在隔离资源空间内搜论文、读论文/图并生成带逐参数证据定位、冲突与 unknown 标记的执行文档；
3. 文件拖入对话，右栏只读显示处理状态；
4. 性状提取完成从当前参考图分类器到 `TraitDefinition/TraitObservation` 的能力迁移，在标注集达到逐性状约定指标后从大图片生成结构化数据；无标定时不输出虚假物理量，Web 不自动上传原图；
5. 用户确认后只创建一个 Task；
6. Analysis 提交后立即释放，不被数小时 Coding 占用；
7. 使用逐机唯一凭证自动加入的独立 Worker 领取并在受控 Job 中执行；Job 不获得长期 Secret、Docker Socket 或任意出站网络；
8. 失败可恢复、失租 Worker 不能覆盖新结果；
9. Verifier 通过后，Task 详情和原 Analysis 对话都能下载同一 Artifact；
10. Alice 无法通过 REST、SSE、WS、Agent 工具、图片引用、文件路径或 Task API 读取 Bob 数据；
11. 同一用户也不能跨 Project 错配资源；成员撤销后旧票据和权限失效；
12. 一次排入 5 个长时 Task、关闭浏览器并重启 API 后，仍在并发/背压限制下全部到达唯一终态，没有饥饿、重复结果或残留明文输入；
13. 重新登录后历史 Analysis、Activity、最近对话、Resource、Task 和 Artifact 仍正确归属；
14. 日志、浏览器、证据包、Worker 和 Job 不泄露用户/模型/数据库密钥；
15. 本机开发环境达到 §6.6 的本地门槛；任何公网多用户发布前完成信封加密门槛。

配套计划已经按阶段拆开：

- 本地实施与 T0–T13：`docs/LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md`；
- Cloudflare 远程部署：`docs/CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`；
- 性状提取桌面端 Linux/macOS 分发：`docs/TRAIT_EXTRACTION_DESKTOP_DISTRIBUTION_PLAN.md`；
- GPT-5.6 Luna 与千问 Max 的开发实施流程：`docs/MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md`。

原 `docs/LOCAL_MVP_AND_CLOUDFLARE_EXECUTION_PLAN.md` 只保留为旧链接迁移索引。
