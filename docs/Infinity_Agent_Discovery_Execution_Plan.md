# Infinity Agent — Paper Discovery + Data Collection 执行与验收方案

> 状态：READY FOR IMPLEMENTATION
> 基线：`cloudflare-deploy`
> 目标：在不重构现有 Chat / Task Worker 的前提下，增加 Papers、Data Collections、Matching、Feasibility Evaluation 和自动 Task 创建。
> 强制规则：**每一步必须“实现 → 测试 → 保存证据 → checkpoint”，未通过不得进入下一步。**

---

# 0. 执行总规则

## 0.1 禁止事项

整个实施周期禁止：

- 手工修改线上 D1 结果伪造成功；
- 用 mock Task 冒充真实 Worker 执行；
- 用本地 PostgreSQL 验证替代 Cloudflare D1/R2 生产链路；
- 跳过失败测试继续下一阶段；
- 将 Secret、Token、Worker credential、API Key 写入 Git；
- 为新功能再创建第二套 Task / Attempt / Artifact 事实源；
- 破坏当前 Worker v2、Chat、Task Center 已通过能力。

---

## 0.2 每张执行卡固定结构

每一个 Card 都必须生成：

```text
evidence/IMPLEMENT-DISCOVERY/<stage>/<card>/
├── execution-card.md
├── baseline.txt
├── commands.txt
├── test-output.txt
├── diff-summary.txt
├── secret-scan.txt
└── checkpoint.md
```

有浏览器行为的 Card 再保存：

```text
browser/
├── screenshots/
├── console.txt
└── network.txt
```

有 Cloudflare 变更的 Card 再保存：

```text
cloudflare/
├── d1.txt
├── r2.txt
├── deploy.txt
└── health.txt
```

---

## 0.3 Card 通过定义

一个 Card 只有同时满足以下条件才 PASS：

```text
代码完成
AND 相关单元测试通过
AND 相关集成测试通过
AND 负例通过
AND Secret scan 通过
AND Evidence 已归档
AND git diff 已审查
AND checkpoint 写明 commit SHA
```

不得用“页面能打开”“容器 running”“Agent 说成功”作为 PASS。

---

# D0 — 冻结生产基线

## D0.1 只读盘点

记录：

- `cloudflare-deploy` HEAD；
- 当前线上 Edge version；
- 当前 D1 database name；
- 当前 R2 bucket；
- 当前 Paper Processor 状态；
- 当前 Docker Worker v2 状态；
- 当前 Git 工作区；
- 当前前端导航；
- 当前 `/health`。

### Test

必须验证现有链路在任何代码修改前正常：

```text
GET /health
登录
Chat/Analysis 基本页面
Task Center 页面
已有 Worker connect/poll
Paper Processor connect/poll
现有 Paper Resource smoke test
```

### Gate

所有 baseline 行为均正常。

### Archive

```text
evidence/IMPLEMENT-DISCOVERY/D0/baseline/
```

建立恢复 tag，例如：

```text
pre-discovery-YYYYMMDD
```

---

# D1 — D1 Schema：只新增 Discovery 对象

## D1.1 新增 migration

创建：

```text
cloudflare-worker/migrations-infinity/0017_discovery_catalog.sql
```

最小表：

```text
paper_catalog
paper_capabilities
data_collections
dataset_capabilities
research_matches
```

不得改现有：

```text
tasks
task_attempts
workers
worker_sessions_runtime
artifacts
outbox_events
```

除非发现 Discovery 创建 Task 所需的纯兼容索引；任何现有语义修改必须单独 Card。

## D1.2 Migration test

本地 D1：

```text
clean DB → 全量 migration
已有 DB snapshot → apply 0017
重复 migration 检查
FK / UNIQUE / index 检查
```

负例：

- duplicate paper/profile version；
- duplicate match；
- other-user read；
- invalid status；
- delete referenced object。

## D1.3 Tests / Regression

执行：

```bash
cd cloudflare-worker
npm test
npm run check
```

并把 migration test、schema negative test、原 Worker regression 的完整 stdout/stderr 与 exit code 一起保存。

### Gate

- 原 Cloudflare Worker tests 全通过；
- 新 schema tests 全通过；
- 旧 Task schema 没发生语义变化。

### Archive

```text
D1/schema/
```

通过后 commit。

---

# D2 — Paper Catalog：复用现有 PDF Processor

## D2.1 API

新增 Discovery Paper API：

```text
POST /api/discovery/papers
GET  /api/discovery/papers
GET  /api/discovery/papers/:id
DELETE /api/discovery/papers/:id
```

上传 PDF 必须继续创建/复用现有 Paper Resource，并由现有：

```text
/api/paper-processor/*
```

处理。

禁止重新写 PDF parser。

## D2.2 Paper 生命周期

验证：

```text
requested
→ downloading/uploaded
→ extracting
→ uploading
→ ready
→ profiling
→ profiled
```

Paper Processor 原状态不必全部改名。

Discovery 自己维护 Profile 状态即可。

## D2.3 Tests

### Unit

- owner check；
- duplicate SHA；
- invalid PDF；
- over-limit PDF；
- missing resource；
- processor fail；
- stale lease。

### Integration

真实上传一个 2–10 页测试 PDF：

验证：

```text
D1 paper resource exists
R2 source_pdf exists
text manifest exists
image manifest exists（无图允许 0）
resource ready
```

### Regression

原 paper-resource tests 必须全通过。

### Gate

“旧 PDF Processor 路径完全可用 + Discovery 能引用结果”，才 PASS。

### Archive

```text
D2/paper-catalog/
```

commit。

---

# D3 — Paper Profile Compiler + Spam Filter

## D3.1 Profile Schema

实现固定版本：

```text
paper-profile-v1
```

要求模型输出严格 JSON。

核心字段：

```text
bibliographic metadata
research_question
main_claims
analysis_modules[]
required_capabilities[]
expected_outputs[]
verification[]
evidence[]
display_tags[]
```

## D3.2 Spam Gate

先判断：

```text
scientific_paper
non_paper
spam
invalid
```

不得让 spam/non-paper 进入 Match Engine。

## D3.3 Model input

只提供：

- extracted text；
- bounded figures / figure captions；
- manifest；
- resource ID。

不传 Cloudflare credential / R2 key /用户 Secret。

## D3.4 Schema tests

固定 fixtures：

1. 正常科研论文；
2. 空白 PDF；
3. 纯广告 PDF；
4. 简历；
5. 有正文但不是论文；
6. 恶意 prompt-injection 文档。

测试必须确认：

- 模型输出无法改变 system goal；
- 非法 JSON 被拒；
- evidence locator 缺失时对应 Module 标记 unknown/review；
- spam 不进入 catalog-ready；
- 重试不会生成两份 profile version。

## D3.5 Live API smoke

用一篇真实公开论文跑一次真实模型 API。

### Gate

同一 PDF 连续执行两次：

- semantic profile 基本稳定；
- Analysis Modules 数量不出现灾难性漂移；
- JSON schema 100% 合法；
- provenance 存在。

### Archive

```text
D3/paper-profile/
```

commit。

---

# D4 — Papers DeepWiki 前端

## D4.1 Routes

新增：

```text
frontend/app/papers/
frontend/app/papers/[paperId]/
frontend/components/papers/
frontend/lib/api/discovery.ts
```

修改：

```text
frontend/components/workspace/AgentNav.tsx
```

只新增 Papers，不修改现有导航语义。

若使用静态 export：

Cloudflare Worker 增加 paper detail shell rewrite，沿用 Task detail shell 的实现思想。

## D4.2 UI

首页：

- Upload PDF；
- loading / processing / failed / ready；
- card；
- display tags；
- Analysis Module count。

详情：

- 左侧 section navigation；
- Overview；
- Research Question；
- Data Requirements；
- Analysis Modules；
- Expected Results；
- Evidence。

## D4.3 Tests

```bash
cd frontend
npm run test:unit
npm run typecheck
npm run lint
npm run build
```

Playwright：

- upload；
- processing；
- refresh 后状态保持；
- ready card；
- detail；
- back；
- invalid paper；
- unauthorized user；
- mobile layout。

### Gate

浏览器不依赖 mock API。

至少一次测试必须连接 Cloudflare preview / staging API。

### Archive

```text
D4/papers-ui/
```

commit。

---

# D5 — Data Collections Backend + R2

## D5.1 MVP 输入限制

第一版 Data Collection 接受：

```text
single data file
OR
single ZIP archive
```

并继续满足当前 Task Dataset 大小限制。

不要实现浏览器多文件动态打包。

## D5.2 API

```text
POST /api/discovery/data-collections
GET  /api/discovery/data-collections
GET  /api/discovery/data-collections/:id
DELETE /api/discovery/data-collections/:id
```

R2：

```text
datasets/{collection_id}/source/*
datasets/{collection_id}/profile/*
```

## D5.3 Ownership tests

- A 不能读 B 的 private collection；
- A 不能替换 B 的对象；
- object key 不由浏览器决定；
- path traversal 无效；
- size/hash 不一致拒绝。

## D5.4 Tests / Persistence

上传后浏览器刷新、Edge redeploy、Processor restart 后：

- D1 status 仍存在；
- R2 object 仍存在；
- hash 一致。

额外执行：

- 同一文件重复上传；
- 错误 Content-Length；
- 上传中断；
- R2 写成功但 D1 finalize 失败；
- 删除后再次读取；
- 其他用户读取。

### Gate

Data Collection 能真实上传、读取 metadata、删除并正确清理/标记。

### Archive

```text
D5/data-collection-storage/
```

commit。

---

# D6 — Dataset Inspector

## D6.1 Runtime

复用当前可信 Processor Docker 主机。

推荐：

```text
同一 image / codebase
新增 dataset inspection command/loop
```

不要创建新的 SQL 数据面。

Inspector 在临时目录解包；完成后删除临时文件。

## D6.2 第一版识别

至少支持：

```text
CSV
TSV
JSON
TXT/README
ZIP containing above
```

产出：

- files；
- rows；
- columns；
- column names；
- inferred data types；
- bounded samples；
- missing ratio；
- numeric/categorical/text；
- likely target；
- capability keys；
- display tags。

## D6.3 Tests

Fixtures：

1. 单 CSV；
2. ZIP + CSV + README；
3. corrupt ZIP；
4. path traversal ZIP；
5. ZIP bomb / excessive expansion；
6. binary unknown file；
7. CSV with missing values；
8. very wide CSV。

负例必须验证：

- `../` 不能写出工作目录；
- symlink 不跟随；
- archive expansion 有上限；
- scan 超时会 fail；
- retry 幂等。

### Gate

Inspector 结果进入 D1/R2 后，Collection 状态为 ready，且重启不丢。

### Archive

```text
D6/dataset-inspector/
```

commit。

---

# D7 — Data Collections 前端

## D7.1 Routes

新增：

```text
frontend/app/data-collections/
frontend/app/data-collections/[collectionId]/
frontend/components/data-collections/
```

导航增加 Data Collections。

## D7.2 UI

Card：

```text
Name
status
files
sample count
data type
capability tags
updated time
```

Detail：

```text
Overview
Files
Schema
Capabilities
Quality
Matched Papers
```

## D7.3 Tests

完整前端：

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Browser E2E：

```text
create
upload
processing
ready
refresh
detail
delete
error
mobile
```

### Gate

真实 Cloudflare API + R2 上传至少通过一次。

### Archive

```text
D7/data-ui/
```

commit。

---

# D8 — Matching Engine

## D8.1 Coarse matching

实现规范 capability key。

Paper：

```text
required capability
optional capability
analysis_id
```

Dataset：

```text
available capability
value
confidence
```

D1 只产生候选。

不得用 Tag overlap 直接创建 Task。

## D8.2 Coverage

计算：

```text
supported analysis modules / total analysis modules
```

保存：

```text
coverage_ratio
missing_required
candidate_reason
```

## D8.3 Tests

构造：

1. 100% match；
2. 80% match；
3. 20% match；
4. tag 名字相似但 capability 不满足；
5. capabilities 满足但语义 domain 冲突；
6. profile version 更新；
7. dataset profile 更新。

### Gate

版本改变时产生新 evaluation，不覆盖旧事实；相同版本不重复生成 match。

### Archive

```text
D8/matcher/
```

commit。

---

# D9 — Feasibility Evaluator

## D9.1 Evaluator

版本：

```text
feasibility-v1
```

输入只包括：

```text
paper_profile
dataset_profile
coverage
worker_environment_summary
```

输出严格：

```text
hard_gate
execution_confidence
scientific_fit
missing_requirements
risks
recommended
reason
```

## D9.2 Threshold

生产逻辑：

```text
hard_gate == pass
coverage_ratio >= 0.60
execution_confidence >= 60
```

第一轮 staging：

```text
DISCOVERY_AUTO_EXECUTE=false
```

只记录“would_create_task=true”。

## D9.3 Evaluator tests

必须测试：

- score 59；
- score 60；
- hard fail + score 99；
- malformed output；
- timeout；
- provider 5xx；
- retry；
- same match idempotency；
- prompt injection in paper；
- prompt injection in README/data metadata。

### Gate

Evaluator 失败不能创建 Task。

### Archive

```text
D9/evaluator/
```

commit。

---

# D10 — Opportunity → Existing Task

## D10.1 Method materialization

从 Paper Profile 生成一份冻结 Method Markdown：

```text
Research Goal
Source Paper
Required Analyses
Analysis 1...
Analysis N...
Input Contract
Expected Outputs
Verification
Evidence
```

写 R2。

## D10.2 Dataset

直接把 Data Collection 的原单文件/ZIP 作为现有 Dataset input。

不重新复制一套业务数据，必要时创建 immutable snapshot reference。

## D10.3 Task Creation

复用现有 Task 创建函数。

Idempotency：

```text
discovery:{match_id}:{paper_profile_version}:{dataset_profile_version}
```

同一 match 永远不能自动产生两个有效 Task。

## D10.4 Tests

- threshold below → no Task；
- threshold equal 60 → exactly one Task；
- duplicate event → same Task；
- evaluator retry → no duplicate；
- browser double click → no duplicate；
- Task creation fail → match remains retryable；
- Task created → Task Center visible；
- Task owner correct；
- Method/Dataset R2 input downloadable by active Worker only。

### Gate

真实 Docker Worker 成功 claim 一条 Discovery Task。

### Archive

```text
D10/task-integration/
```

commit。

---

# D11 — 自动论文监测

## D11.1 Scheduled

在现有 Cloudflare Worker `scheduled()` 增加：

```text
runLiteratureDiscovery()
```

第一版来源：

```text
arXiv
PMC / Europe PMC
```

每轮：

```text
bounded query
→ canonical ID dedupe
→ create public paper
→ process
→ profile
→ match
```

## D11.2 Safety

必须：

- max papers/run；
- max profile calls/day；
- cursor；
- retry；
- duplicate protection；
- per-source timeout；
- one paper fail 不终止 batch。

## D11.3 Tests

- same paper twice；
- cursor rollback；
- provider timeout；
- arXiv unavailable；
- 100 results but cap 10；
- private Data Collection 只和 owner 可见结果关联。

### Gate

Cron 连跑两轮，第二轮不能重复创建相同论文、match 或 Task。

### Archive

```text
D11/literature-watch/
```

commit。

---

# D12 — Production E2E：真实论文 + 真实数据

这是最终 Gate，不允许 mock。

## D12.1 Test Paper

**Prediction of Red Wine Quality Using One-dimensional Convolutional Neural Networks**

- PDF: https://arxiv.org/pdf/2208.14008
- Abstract: https://arxiv.org/abs/2208.14008

预期至少抽取：

```text
Pearson correlation analysis
PCA
Shapiro-Wilk test
data transformation
1D-CNN modeling/evaluation
```

允许模型名称细节不同，但五类核心分析必须可追溯到原论文 evidence locator。

## D12.2 Test Dataset

**UCI Wine Quality**

- Page: https://archive.ics.uci.edu/dataset/186/wine+quality
- ZIP: https://archive.ics.uci.edu/static/public/186/wine+quality.zip
- DOI: https://doi.org/10.24432/C56S3T

生产测试选：

```text
winequality-red.csv
```

预期：

```text
1599 rows
11 predictor features
quality target
no missing values
tabular numeric dataset
```

## D12.3 Full E2E

必须逐项记录：

### Paper

```text
[ ] PDF 上传成功
[ ] R2 source object 存在
[ ] SHA-256 一致
[ ] Processor claim 成功
[ ] text pages 生成
[ ] figures/manifest 生成
[ ] spam gate = scientific_paper
[ ] paper_profile schema valid
[ ] 至少 5 core modules
[ ] Papers card ready
[ ] DeepWiki detail ready
```

### Dataset

```text
[ ] Collection 创建
[ ] ZIP/CSV 上传
[ ] R2 object 存在
[ ] hash 一致
[ ] Inspector claim
[ ] archive 安全解包
[ ] red wine CSV 被识别
[ ] row/feature/target 正确
[ ] capability profile valid
[ ] Data Collection 页面 ready
```

### Match

```text
[ ] candidate match created
[ ] required capabilities aligned
[ ] coverage computed
[ ] evaluator real API call
[ ] evaluator schema valid
[ ] hard_gate not silently overridden
[ ] evaluation persisted
```

### Task

在 staging 先 shadow：

```text
AUTO_EXECUTE=false
→ would_create_task=true
→ D1 无 Task
```

然后生产测试打开：

```text
AUTO_EXECUTE=true
```

验证：

```text
[ ] exactly one Task
[ ] Task visible in Task Center
[ ] D1 event sequence correct
[ ] Redis hint emitted or poll fallback works
[ ] Docker Worker accepts
[ ] correct Method input
[ ] correct Dataset input
[ ] Claude Code runs
[ ] Artifact uploaded
[ ] Artifact hash verified
[ ] Task succeeded
[ ] result downloadable
[ ] match.created_task_id points to Task
```

### Recovery

最终还要执行一次故障恢复：

```text
1. Dataset ready 后重启 Processor
2. Task queued 时暂时停止 Redis Relay
3. Worker 仍应通过 poll 获得任务或在恢复后继续
4. 不能产生第二个 Attempt/Task
```

### Gate

D12 只有在 Paper、Dataset、Match、Task、Artifact、Recovery 六组检查全部通过时才 PASS。
任何一项依赖 mock、手工改 D1、历史 Artifact 或本地 PostgreSQL 都判定失败。

### Archive

保存：

```text
evidence/IMPLEMENT-DISCOVERY/D12/real-production-case/
├── paper/
├── dataset/
├── match/
├── task/
├── artifact/
├── recovery/
├── browser/
├── cloudflare/
└── checkpoint.md
```

其中必须记录真实 `paper_id / collection_id / match_id / task_id / attempt_id / artifact_id` 和 hash。

---

# D13 — Production Deploy

## D13.1 Deploy order

严格顺序：

```text
1. Git clean + tests
2. Git commit
3. push
4. D1 migration staging
5. Edge staging deploy
6. Processor Docker image build
7. Windows PowerShell SSH deploy Processor
8. Worker image/容器确认
9. staging E2E
10. production D1 migration
11. production Edge deploy
12. production Processor rollout
13. /health
14. production real-case smoke
```

## D13.2 Windows Docker

通过现有 SSH → PowerShell：

```text
pull exact image digest
stop old processor
start new processor
health check
processor connect
processor poll
```

必须固定 image digest，不用 floating `latest` 作为最终证据。

## D13.3 Cloudflare

归档：

```text
D1 migration output
Edge version ID
R2 verification
Worker /health
scheduled trigger result
```

## D13.4 Rollback

回滚条件：

- Paper Processor 连续失败；
- D1 error rate；
- unauthorized read；
- duplicate Task；
- existing Task Center regression；
- existing Worker v2 regression。

回滚顺序：

```text
disable AUTO_EXECUTE
disable literature watcher
rollback Edge version
rollback Processor image
保留 0017 additive schema，不做危险 drop
```

## D13.5 Tests

部署完成后必须立即执行：

```text
GET /health
authenticated Papers list/detail
authenticated Data Collections list/detail
one PDF processing smoke
one Dataset inspection smoke
one shadow match evaluation
Worker v2 connect/poll
existing Task Center smoke
```

同时检查 Cloudflare logs 中没有新的 5xx/permission error。

### Gate

只有 staging E2E 已通过、production smoke 全部通过、旧 Task/Worker 行为无回归，D13 才 PASS。

### Archive

```text
evidence/IMPLEMENT-DISCOVERY/D13/deploy/
```

必须包含 Edge version、D1 migration output、Processor image digest、Worker image digest、health 和 rollback reference。

---

# D14 — 最终回归与存档

## D14.1 Tests

最终同一个 commit 执行：

```bash
cd cloudflare-worker
npm test
npm run check

cd ../frontend
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

再运行：

- Paper Processor tests；
- Dataset Inspector tests；
- Worker v2 regression；
- real Paper/Data E2E；
- auth negative tests；
- Redis outage test；
- duplicate/idempotency test；
- Secret scan。

### Gate

以下任一项失败都不得发布最终完成结论：

```text
Cloudflare Worker test/check
Frontend unit/type/lint/build/e2e
Paper Processor
Dataset Inspector
Worker v2 regression
Real Paper/Data E2E
Auth negatives
Redis outage recovery
Idempotency
Secret scan
```

### Archive

最终生成：

```text
evidence/IMPLEMENT-DISCOVERY/FINAL/
├── SUMMARY.md
├── commits.txt
├── edge-version.txt
├── processor-image-digest.txt
├── worker-image-digest.txt
├── d1-migrations.txt
├── real-case.md
├── full-test-output.txt
├── known-limitations.md
└── rollback.md
```

---

# 最终验收标准

只有以下全部为真才宣布完成：

```text
Papers DeepWiki 页面真实可用
Data Collections 页面真实可用
PDF 真实经过现有 Paper Processor
Dataset 真实经过 Inspector
Profile 是严格结构化数据
Spam 被隔离
Paper Requirements 和 Dataset Capabilities 可匹配
Feasibility Evaluator 有版本、有证据、有失败路径
Threshold 不被绕过
达到门槛只产生一个真实 Task
现有 Worker v2 能真实执行
Artifact 进入 R2
Task Center 能显示并下载
Cron 不重复创建论文/任务
每个 Stage 都有独立证据和 checkpoint
现有 Chat / Task Center / Worker v2 无回归
```

---

## 实施顺序一句话版

```text
D0 冻结
→ D1 Schema
→ D2 Paper Catalog
→ D3 Paper Profile
→ D4 Papers UI
→ D5 Data Storage
→ D6 Dataset Inspector
→ D7 Data UI
→ D8 Match
→ D9 Evaluate
→ D10 Create Task
→ D11 Watch Papers
→ D12 Real E2E
→ D13 Deploy
→ D14 Final Audit
```

任何阶段 Gate 不通过：**停在当前阶段修复，不进入下一阶段。**
