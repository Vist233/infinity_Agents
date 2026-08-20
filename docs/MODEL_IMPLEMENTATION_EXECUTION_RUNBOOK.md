# Infinity Agents — 单一开发模型全程执行手册

> 版本：v2.0  
> 日期：2026-08-09  
> 状态：供 GPT-5.6 Luna 或千问 Max **二选一**执行整个项目  
> 范围：规定所选模型怎样从本地 MVP 一直执行到桌面分发和 Cloudflare 远程阶段；不重新定义产品。

> **2026-08-20 当前架构覆盖说明**：Worker实施必须以
> [`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`](./ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)、
> [`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`](./D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md)
> 和专用Goal-Driven Prompt为准。本文的执行卡、测试、checkpoint和单主Agent规则继续
> 有效；PostgreSQL、RLS、信任分级、Verifier和子Docker阶段均不再定义当前目标。

## 0. 先把执行方式说死

本项目不是“双模型协作”，也不是两个模型交替审查。

```text
开始实施前二选一

方案 A：GPT-5.6 Luna 从头执行到尾
方案 B：千问 Max 从头执行到尾

选定后：
同一个模型顺序完成全部阶段
→ 每个阶段跑确定性测试
→ 保存 checkpoint
→ 继续下一阶段
```

另一个模型只作为故障备用。正常实施过程中不参与分工、不并行改文件、不承担 Reviewer，也不要求 50/50 工作量。

如果主模型确实无法继续，才允许在一个干净 checkpoint 上切换备用模型；切换后由备用模型接管后续全部工作，不能让两个模型同时写同一工作区。

## 1. 不得混淆的两类模型

### 1.1 开发执行模型

开发执行模型只负责修改这个仓库、运行测试和生成证据：

| 可选执行器 | 配置标识 | 执行策略 |
|---|---|---|
| GPT-5.6 Luna | `gpt-5.6-luna` | 全程可用，但任务必须切得更小、指令更明确、检查点更密 |
| 千问 Max | 使用运行环境实际提供的 exact model ID；当前可核实候选为 `qwen3.7-max` | 全程可用，可读取稍大的阶段包，但仍逐阶段验收 |

用户口述的“千问 3.8 Max”不构成架构问题。运行时提供什么 exact ID，就把什么 ID 写入执行清单并先跑 practical probe；不静默 fallback 即可，不因型号名称考据阻塞项目。

### 1.2 产品部署模型

最终产品的模型配置与上面两个开发执行器无关：

```text
Analysis / PaperAgent 2.0
  = AGNO
  + 用户配置的 OpenAI-compatible endpoint
  + 用户配置的 base_url / credential / model

Coding / 长时 Docker Task
  = Claude Code
  + 用户配置的 Anthropic Messages-compatible endpoint
  + 用户配置的 base_url / credential / model
```

硬规则：

- Analysis 是唯一主 Agent，也是 PaperAgent 2.0；
- Coding 是用户确认后的异步执行能力，不是第二个前台主 Agent；
- 性状提取是本地批量图片生成结构化数据的能力；
- 开发执行器的型号不得被写进产品默认 Provider、前端模型列表、TaskSpec 或 Worker 镜像；
- 不得把 Analysis 与 Coding 强行统一成一种 API 协议。

## 2. 怎样选择唯一主执行模型

启动前只填写一次：

```yaml
execution_run:
  run_id: IMPLEMENT-YYYYMMDD-NN
  primary_executor: gpt-5.6-luna | qwen-max
  configured_exact_model_id: ""
  resolved_model_id: ""
  tool_runtime: ""
  repository_baseline: ""
  current_stage: S0
  status: active
```

选择建议：

- 已有稳定的 Luna 接入、希望成本可控且不介意多切任务：选 Luna；
- 已有稳定的千问 Max 接入、希望单个阶段包容纳更多跨模块关系：选千问 Max；
- 不做抽象的“谁更聪明”争论，先用同一个小 Fixture 测一次读代码、patch、运行成功/失败测试和保存 checkpoint；谁被选中，谁就执行全程。

### 2.1 对 Luna 的准确约束

OpenAI 将 GPT-5.6 Luna 定位为成本敏感、高吞吐档，而不是该系列的旗舰能力档。因此它可以完成整个项目，但文档必须替它减少推断负担：

- 每张执行卡只允许一个可观察结果；
- 默认最多 3 个主要实现文件；
- 一次只跨一个高风险边界；
- 数据库、认证、Worker、Cloudflare 都拆成可运行的小纵向切片；
- 每完成一张卡立即测试并写 checkpoint，不积累巨大 diff；
- 对复杂卡使用运行环境支持的较高 reasoning 档位；是否使用 `high/xhigh/max` 以实际测试为准；
- 不能因为上下文很长，就一次把整个仓库和全部文档塞给它。

### 2.2 对千问 Max 的准确约束

千问 Max 可以使用较完整的阶段 Context Packet，并承担跨前后端的纵向切片，但不能跳过确定性验收：

- 一次仍只执行一个阶段或一个可回滚的纵向目标；
- 开启运行环境实际支持的 reasoning/thinking 模式；
- 工具调用、结构化输出和长上下文必须先 practical probe，不能只看型号名称；
- Auth、租户隔离、加密、Worker lease、Artifact 和 Cloudflare 上线仍逐项跑负向测试；
- 发现文档冲突时停止并记录，不自行重写产品目标。

### 2.3 主模型预检

正式实施前，用合成 Fixture 验证主模型能够：

1. 正确读取指定文件和符号；
2. 只修改允许文件；
3. 使用 patch 完成一个可逆改动；
4. 运行一个应成功测试和一个故意失败测试；
5. 正确认出失败，不能把非零退出码解释成通过；
6. 不回显 canary secret；
7. 输出完整 checkpoint。

预检失败时先修工具环境、权限或模型端点。不要直接让模型进入 OIDC、数据库或 Cloudflare 阶段试错。

## 3. 权威文档与执行顺序

### 3.1 文档职责

| 文档 | 决定什么 |
|---|---|
| [`ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md`](./ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md) | 产品目的、Agent 层级、数据与安全不变量 |
| [`LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md`](./LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md) | 本地 L0–L10、T0–T13 和本地完成门槛 |
| [`TRAIT_EXTRACTION_DESKTOP_DISTRIBUTION_PLAN.md`](./TRAIT_EXTRACTION_DESKTOP_DISTRIBUTION_PLAN.md) | Linux/macOS/Windows 分发、签名、manifest 与更新 |
| [`CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`](./CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md) | 本地通过后的远程拓扑、实施 R0–R7 和 G0–G9 |
| 本文件 | 所选单一模型怎样逐步执行、测试、保存现场和继续 |
| [`../HANDOFF.md`](../HANDOFF.md) | 当前代码事实；不覆盖目标设计 |

旧 [`LOCAL_MVP_AND_CLOUDFLARE_EXECUTION_PLAN.md`](./LOCAL_MVP_AND_CLOUDFLARE_EXECUTION_PLAN.md) 只是迁移索引。

### 3.2 冲突优先级

```text
项目负责人最新明确决定
> 系统设计中的产品不变量
> 当前阶段专项计划
> 已冻结 schema / ADR / Fixture
> 当前代码和 HANDOFF 的现状事实
> 模型自己的推断
```

模型发现冲突时输出 `STOP-CONFLICT`，列出冲突位置、影响和最小选择；不得静默选边。

### 3.3 唯一阶段顺序

```text
S0 预检与本地验收环境
→ S1–S10 本地产品
→ T0–T13 全部通过
→ LOCAL-GO
→ SD 桌面分发所需实施
→ SR0–SR7 Cloudflare 离线/预生产实施
→ G0–G9 同一版本全部通过
→ 管理员一次生产切换，或不部署
```

Cloudflare 可以提前做只读调研和文档，但在 `LOCAL-GO` 前不得以远程架构为由改变本地实现，也不得公开部署半成品。

## 4. 单一模型的标准执行循环

每个阶段由同一个主模型重复以下循环：

```text
读取当前 checkpoint
→ 生成一张 Execution Card
→ 只读检查现状和 dirty worktree
→ 跑 baseline
→ 实现最小改动
→ 跑正例、负例、集成测试
→ 检查 diff 和 Secret
→ 写 checkpoint
→ 满足 Gate 后进入下一张卡
```

### 4.1 Execution Card 模板

```markdown
# EXEC-<stage>-<number>: <single outcome>

## Control
- run_id:
- primary_executor / resolved_model_id:
- stage:
- baseline_commit:
- current_dirty_files:
- risk: R0 | R1 | R2 | R3

## Authority
- system-design sections:
- phase-plan sections:
- active ADR/schema:

## One outcome
- observable result:
- explicit non-goals:

## Scope
- files allowed:
- files read-only:
- files forbidden:
- external systems allowed:

## Frozen invariants
- product protocol:
- tenant/auth:
- Task/lease/Verifier:
- Secret/egress:

## Baseline
- exact checks:
- known failures:

## Implementation steps
1. ...
2. ...
3. ...

## Acceptance
- positive check:
- negative/security check:
- integration/UI check:
- expected state:

## Rollback
- code/config:
- schema/data:

## Stop conditions
- missing decision:
- scope expansion:
- destructive/external action:
```

### 4.2 卡片大小

Luna 默认：

- 1 个结果；
- 不超过 3 个主要实现文件；
- focused test 一次可判断；
- 预计 30–90 分钟的模型工作量；超过就继续拆卡。

千问 Max 默认：

- 1 个纵向结果；
- 可以跨少量前端/API/测试文件；
- 仍不得同时重写认证、数据库、任务状态机和部署；
- 一个卡必须能独立回滚并在一次集成测试中判定。

时间不是问题。宁可多执行十张清楚的小卡，也不要一张卡留下半套 schema、半套 API 和无法启动的仓库。

### 4.3 每卡完成条件

一张卡只有同时满足以下条件才结束：

- 目标在真实文件/服务中可观察；
- 指定正例通过；
- 指定负例通过；
- 测试退出码真实记录；
- 没有用 mock 冒充要求的真实集成；
- diff 只包含卡内范围；
- Secret 扫描无泄漏；
- rollback 可执行；
- checkpoint 已写完。

模型说“已完成”不算证据。

## 5. Checkpoint：让同一个模型能跑数天

每张卡结束时覆盖当前运行 checkpoint，并保留阶段历史：

```markdown
# CHECKPOINT <run_id> / <stage> / <revision>

- primary executor / resolved model ID:
- repository baseline and current commit:
- dirty files and ownership:
- completed cards:
- current product behavior:
- migrations applied:
- tests run with exit codes:
- failed/skipped tests:
- DB/Redis/Docker/browser state:
- evidence paths and artifact hashes:
- known risks and unresolved conflicts:
- rollback point:
- next exact card:
- external state touched: none | details
- secrets/data exposure: none | details
```

上下文压缩、进程重启或隔天继续时，主模型先读：

1. 本文件相关规则；
2. 最新 checkpoint；
3. 下一张卡引用的权威章节；
4. 卡内相关代码和测试。

不要重新读取整个仓库后凭印象“接着做”，也不要依赖聊天记忆。

## 6. 本地阶段执行地图

主模型严格按本地计划推进：

| Stage | 实施范围 | 必须通过后才能继续 |
|---|---|---|
| S0 | L0：隔离验收 namespace、真实 Fixture、当前基线 | T0 |
| S1 | L1：全局 Zhang Auth OIDC、Project、数据库角色 | T1 与 T2 身份部分 |
| S2 | L2：ResourceBroker、虚拟文件系统、文件/URL/PDF 安全 | T2 全部资源隔离 |
| S3 | L3：AGNO Analysis/Paper + OpenAI-compatible Provider Profile | Analysis provider probe、T4 |
| S4 | L4/L5：Analysis UI、拖放、Activity、论文证据矩阵 | T3、T4 |
| S5 | L6：确认卡、原子 Task/Outbox、异步释放 | T5、T10 |
| S6 | L7：Docker Claude Code + Anthropic Messages-compatible Provider | Coding probe、T6、T9 |
| S7 | L8：Worker enrollment、lease/fencing、Secret/egress/Executor | T7、T8 |
| S8 | L9：TraitDefinition/Observation、500 图性状提取 | T11 |
| S9 | L10：真实科研 Case、非开发者 walkthrough、发布候选 | T12 |
| S10 | 五个长任务、关闭浏览器/API 重启、过夜恢复 | T13 |

任一 Gate 失败，主模型继续在当前 Stage 拆卡和修复；不能先跳到后续阶段再回来补。

## 7. 桌面分发轨道

按桌面分发计划串行执行：

```text
SD0 发布包含现有 Linux 固定文件名修复的新版本
SD1 签名 latest manifest + SHA-256
SD2 macOS arm64 / x86_64 构建、签名、公证、真实启动
SD3 Windows/Linux/macOS 更新与回滚验收
```

边界：

- 生成代码和本地打包可由主模型执行；
- 创建公开 tag/Release、使用签名证书、公证、发布下载链接属于外部写入，必须单独获得项目负责人确认；
- 打包成功不能替代 T11 性状准确性和吞吐验收；
- 当前 ImageJudge 是参考图分类器，不能只改名字就宣称完成多性状提取。

## 8. Cloudflare 远程阶段

只有 `T0–T13=PASS` 且项目负责人签发 `LOCAL-GO` 后，主模型才执行：

```text
SR0 远程合同、D1 唯一事实库、威胁模型
SR1 静态站、OIDC、10 ms Control API
SR2 R2 quarantine → 加密 canonical Resource → 授权下载
SR3 2C2G Task Relay + loopback Redis + Tunnel
SR4 Cloudflare Analysis 分步 checkpoint + AGNO Provider
SR5 可信远程 Worker 闭环
SR6 不可信 Worker 对抗测试（只用 public/sanitized Fixture）
SR7 G0–G9 全量生产同构验收
```

远程不变量：

- Cloudflare 只由平台管理员部署一次；
- 学生/学校不部署 Cloudflare，也没有 Cloudflare 账户或 Token；
- 所有Docker Worker使用管理员签发的持久Worker ID/credential，并配置管理员提供的`WORKER_CONTROL_BASE_URL`、`WORKER_REDIS_URL`和`REDIS_NAMESPACE`；
- D1是Task、Attempt、Worker、Event、Outbox、Artifact metadata唯一事实源，R2保存文件，Redis只保存hint/presence/实时事件；
- Worker通过v2 HTTPS API下载Method + Dataset、上传Artifact；D1条件更新和R2对象检查完成lease/fencing/finalize；
- 10 ms 只约束 Cloudflare Worker 的 CPU，不约束 2C2G Redis/Relay 或学生 Docker；
- Cloudflare通过最小HTTPS Relay写zhangbot Redis，不公开raw Redis command；Worker只持有窄Redis ACL；
- 不区分可信/不可信Worker；权限由平台credential、Worker API、lease/fencing和最小Redis/Provider凭证控制；
- 不运行独立 Verifier；Worker 内置的确定性输出/归档安全检查不是独立服务；
- 全部 G0–G9 同一版本通过后一次切换生产，否则不部署。

真正执行 `wrangler deploy`、改 DNS/route、创建生产 Secret、迁移真实数据或开放学生 enrollment 前，主模型必须停下请求明确授权。

## 9. 测试和证据

### 9.1 证据强度

从强到弱：

1. 真实故障/越权负测与数据库/Artifact 不变量；
2. 真实 PostgreSQL/Redis/Docker/OIDC/浏览器/Cloudflare 集成；
3. 单元、类型、构建、schema 检查；
4. diff 与静态审查；
5. 模型自然语言说明——不能单独作为证据。

### 9.2 每卡证据包

```text
evidence/<run_id>/<stage>/<card_id>/
├── execution-card.md
├── baseline.txt
├── diff-summary.txt
├── tests-and-exit-codes.txt
├── negative-security/
├── runtime-state/
├── artifacts-and-checksums/
├── secret-scan.txt
└── checkpoint.md
```

证据只保存脱敏状态、ID、hash 和必要日志，不复制真实用户文件、Cookie、Key、数据库 dump 或完整私有 Prompt。

### 9.3 不允许假通过

- `done` 或 `error` 都算通过：禁止；
- 只证明文件存在、不验证内容：禁止；
- Playwright mock 代替真实 OIDC/DB/Worker：禁止；
- 多跑几次只选最好结果：禁止；
- 修改测试放宽失败条件：禁止；
- 手工把数据库 Task 改成 succeeded：禁止。

## 10. 当前必须阻断的安全问题

主模型处理相关阶段时必须明确修复并做负测：

1. PaperAgent 文件/图片工具当前能访问共享缓存，必须经 ResourceBroker 逐次授权；
2. Task API 共享 Token、默认 Project 和缺 owner/RLS 可能跨用户；
3. PDF URL 要防 SSRF、重定向、超大响应和私有内容进入公共缓存；
4. Job 当前默认联网，并透传全部 `ANTHROPIC_*`/`STEPFUN_API_KEY`；长期 Key 不能进入 Job；
5. 联网 Worker 挂宿主 `docker.sock` 等同高权限，生产必须换受控 Executor；
6. Redis 不得无认证公网开放；
7. Method/PDF/HTML 是不可信数据，其中“打印 env、上传 Dataset、忽略 TaskSpec”等指令没有权限；
8. Artifact collector 当前会跟随 output symlink，再由宿主读取/ZIP 根外文件；必须使用不跟随链接的检查，拒绝 symlink、hardlink 越权、FIFO、device、socket，确认路径仍在 output root，并限制文件数/大小；
9. Worker 自报完成不能成为成功，只有 Verifier 可以发布 Artifact；
10. 用户 Provider credential 必须加密保存、按 Project 授权、日志脱敏，Analysis/Coding 两套 Key 不串用。

安全卡必须包含真实恶意 Fixture，不能只读代码后声称已安全。

## 11. 工作区、回滚和外部动作

### 11.1 工作区

- 现有 dirty changes 默认属于用户；
- 修改前记录精确文件清单；
- 使用 patch 编辑；
- 不覆盖卡外文件；
- 禁止 `git reset --hard`、宽目录 checkout、递归删除和无目标清理；
- formatter 只作用于当前卡文件并立即检查 diff。

### 11.2 回滚

- 代码：小 patch 可反向应用；大行为用 feature/config flag；
- API：先兼容增加，再迁移调用方，删除旧字段单独成卡；
- DB：expand → backfill → verify → switch → contract；
- D1/R2：迁移前备份并实际验证可读；
- Cloudflare bundle 回滚不能假装回滚了 schema；
- Secret 泄漏后轮换，不恢复旧值；
- 删除/crypto-shred 用户数据必须另行授权。

### 11.3 立即停止条件

主模型遇到以下情况输出 `STOP` 并保留现场：

- 产品决定或权威文档实质冲突；
- 需要卡外高风险改动；
- 与用户现有改动重叠且无法安全合并；
- 发现真实 Secret 或跨用户数据泄漏；
- 需要删除数据、不可逆 migration、生产部署、发布、改 DNS 或轮换真实 Secret；
- baseline 与计划不一致，继续会让结论无效；
- 真实验收服务不可用且 mock 不能替代；
- 连续三张修复卡出现同一根因；
- 当前 diff 已无法独立回滚。

STOP 报告只需要：阻塞点、客观证据、当前改动、是否触及外部状态、最小下一步。

## 12. 主执行模型启动指令

### 12.1 通用指令

```text
你是 Infinity Agents 本次实施唯一的主开发模型。你将顺序执行整个项目，
不是只给计划，也不与另一个模型轮换。

先读取：
1. MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md；
2. 最新 CHECKPOINT；
3. 当前 Stage 对应的系统设计和专项计划章节；
4. 当前 Execution Card 涉及的代码与测试。

产品事实：
- Analysis/Paper = AGNO + 用户配置 OpenAI-compatible；
- Coding = Docker Claude Code + 用户配置 Anthropic Messages-compatible；
- 开发模型型号不得成为产品默认模型。

每次只完成一张 Execution Card：检查基线、实现、跑正负测试、检查 diff、
保存证据和 checkpoint。测试失败就留在当前 Stage 修复。不得自行部署、
发布、删除数据、读取真实 Secret 或跳过 Gate。模型自报不算完成。
```

### 12.2 选择 Luna 时追加

```text
当前主执行器是 gpt-5.6-luna。把每个目标拆成更小且明确的卡：默认一个结果、
最多三个主要实现文件、一次一个高风险边界。复杂任务宁可多轮 checkpoint，
不要扩大单次 diff。每完成一卡立即运行确定性测试再继续。
```

### 12.3 选择千问 Max 时追加

```text
当前主执行器是千问 Max，exact ID 以 execution_run 为准。你可以承担完整的
纵向阶段卡，但仍必须顺序执行、保持可回滚、逐项运行正例/负例和集成 Gate。
长上下文不能替代读取最新 checkpoint，也不能授权跨阶段或外部动作。
```

## 13. 只有主模型失败时才切换

备用模型不参与正常实施。只有以下情况可以切换：

- 主端点长期不可用；
- 主模型在相同根因上连续失败三轮；
- 工具环境与主模型永久不兼容；
- 项目负责人明确决定切换。

切换前必须：

1. 停止所有写操作；
2. 跑当前可运行的测试；
3. 保存完整 checkpoint、diff、migration 和运行状态；
4. 明确哪些卡完成、哪些失败、哪些未开始；
5. 记录新主模型 exact ID；
6. 新模型先只读复核 checkpoint，再从当前未完成卡继续。

切换不是双模型协作。完成切换后，旧模型退出，新模型成为唯一执行者。

## 14. 最终完成定义

### 14.1 本地完成

- T0–T13 全部真实通过；
- 三组科研 Case 成功且 Verifier 检查内容；
- 五个长任务完成过夜执行与故障恢复；
- Analysis 提交后不等待 Coding；
- OIDC、跨用户/跨 Project、文件、Provider、Worker 与 Artifact 隔离通过；
- 性状提取达到冻结的准确性、QC 和吞吐指标；
- 非开发者能完成核心链路。

### 14.2 桌面分发完成

- Linux 固定下载资产真实可用；
- Windows/Linux/macOS 包的架构、hash、签名和启动通过；
- macOS 完成 Developer ID 签名、公证与 staple；
- signed manifest、更新和回滚通过；
- 发布动作得到负责人授权。

### 14.3 Cloudflare 完成

- 本地先完成；
- G0–G9 在同一个 production-candidate 版本通过；
- 所有动态 Cloudflare 路径满足 10 ms CPU 目标；
- D1/Redis/R2/Provider Secret 不向学生暴露；
- 两个 Worker URL 完成 enrollment、数据、模型和 Artifact 闭环；
- Redis/Relay origin 和 6379 公网不可达；
- 全量门槛通过后由管理员一次切换，否则保持不部署。

## 15. 参考资料

- [GPT-5.6 Luna 模型页](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-5.6 模型选择与 reasoning 指引](https://developers.openai.com/api/docs/guides/latest-model)
- [Alibaba Cloud Model Studio 支持模型](https://www.alibabacloud.com/help/en/model-studio/models)
- [Claude Code LLM gateway](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)

这些资料只帮助确认模型/接口事实。项目是否完成，始终由本仓库的测试、真实运行状态和验收 Gate 决定。
