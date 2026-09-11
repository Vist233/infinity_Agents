# Infinity Agent — Paper Discovery + Data Collection 设计方案

> 状态：DESIGN BASELINE
> 目标分支：`cloudflare-deploy`
> 原则：不重构现有 Chat、Task Center、Worker v2、D1/R2、Redis Relay；只在现有 Cloudflare 生产链路上增加 Paper DeepWiki、Data Collection、匹配与可行性评价能力。
> 核心目标：把“论文需要什么数据、做了哪些分析”与“用户数据里有什么”结构化，然后自动发现可执行的 Research Opportunity，并在满足门槛时复用现有 Goal-Driven Task Executor。

---

## 1. 最终产品形态

本轮只新增两个一级页面：

1. **Papers**：DeepWiki 风格的论文库。
2. **Data Collections**：用户数据集合库。

现有 Chat / Analysis、Task Center、ImageJudge 保持现状，不在本轮重构。

推荐导航：

```text
Analysis / Chat        （保持不动）
Papers                 （新增）
Data Collections       （新增）
Task Center            （保持不动）
ImageJudge / Traits    （保持不动）
```

整个闭环：

```text
                    ┌────────────────────┐
PDF / 新论文监测 ──>│ Paper Ingestion    │
                    └─────────┬──────────┘
                              │
                    PDF Processor（现有）
                              │
                    text + figures + manifest
                              │
                    Paper Profile Compiler
                              │
                ┌─────────────▼─────────────┐
                │ Paper + Analysis Modules   │
                │ required capabilities      │
                └─────────────┬─────────────┘
                              │
                              │ coarse match
                              │
                 ┌────────────▼────────────┐
Dataset/ZIP ────>│ Data Collection         │
                 │ Dataset Inspector       │
                 │ available capabilities  │
                 └────────────┬────────────┘
                              │
                    Candidate Matcher
                              │
                    Feasibility Evaluator
                              │
          hard gate PASS + confidence >= 60
                              │
                  Research Opportunity
                              │
                    Existing Task Creator
                              │
                    Existing Task Center
                              │
                  Existing Docker Worker v2
                              │
                   Goal-Driven Claude Code
                              │
                           Artifact
```

这里最重要的边界是：

- **Tag 负责候选召回和 UI 展示，不直接决定科研结论。**
- **真正自动创建 Task 前必须再经过 Feasibility Evaluator。**
- **Task Executor 不需要知道任务来自 Chat 还是 Discovery。**
- **D1 继续是结构化状态事实源；R2 继续保存大文件。**

---

## 2. 直接复用现有生产能力

当前 `cloudflare-deploy` 已经具有以下能力，本轮应直接复用：

### 2.1 Paper Processor

现有文件：

- `cloudflare-worker/src/paper-resources.ts`
- `cloudflare-worker/src/paper-processor.ts`
- `cloudflare-worker/src/paper-object-store.ts`
- `backend/paper_processor/ingest.py`
- `backend/paper_processor/client.py`
- `backend/paper_processor/runner.py`
- `backend/Dockerfile.paper-processor`

现有 Paper Processor 已经有：

```text
Paper Resource
→ claim / lease / fencing
→ source PDF
→ PDF extraction
→ text pages
→ image extraction
→ manifest
→ R2
→ ready
```

所以本轮**不要再写第二套 PDF Processor**。

需要新增的只是：

```text
ready paper resource
→ Profile Compiler
→ paper_profile.json
→ paper_overview.md
```

### 2.2 Task Runtime

现有链路保持不动：

```text
D1 Task
→ Outbox
→ Redis Relay hint
→ Docker Worker v2 poll / claim
→ Method + Dataset
→ Claude Code
→ Artifact
→ R2 + D1
```

相关生产入口继续使用：

- `cloudflare-worker/src/tasks.ts`
- `cloudflare-worker/src/worker-v2.ts`
- `backend/code_agent/worker/consumer_v2.py`
- `backend/code_agent/worker/executor_v2.py`
- `backend/code_agent/worker/claude_runtime.py`
- `backend/Dockerfile.worker`

Discovery 最终只调用**现有的 Task 创建逻辑**，不新建第二套任务系统。

---

# 3. Papers 页面

## 3.1 页面形态

Papers 首页采用 DeepWiki 风格卡片：

```text
Papers

[ Upload PDF ]

┌─────────────────────────────────────┐
│ Prediction of Red Wine Quality ...  │
│ Di & Yang · arXiv · 2023            │
│                                     │
│ [Tabular] [PCA] [Correlation]       │
│ [Normality Test] [1D-CNN]           │
│                                     │
│ 5 Analysis Modules · Ready          │
└─────────────────────────────────────┘
```

点入论文：

```text
┌──────────────────────┬──────────────────────────────────────┐
│ Overview             │ Title / Authors / Abstract           │
│ Research Question    │                                      │
│ Data                 │ 结构化论文讲解                        │
│ Analysis 1           │                                      │
│ Analysis 2           │ 每项分析：                            │
│ Analysis 3           │ - purpose                            │
│ Analysis 4           │ - required data                      │
│ Analysis 5           │ - method                             │
│ Results              │ - output                             │
│ Evidence             │ - paper locator                      │
└──────────────────────┴──────────────────────────────────────┘
```

左侧章节由结构化 Profile 自动生成，不直接依赖 PDF 原目录。

---

## 3.2 Paper 处理流程

### Step A — 上传与安全检查

```text
Browser
→ POST Paper Resource
→ source PDF → R2
→ D1 paper resource = requested
```

先执行确定性检查：

- MIME / PDF magic bytes；
- 文件大小；
- SHA-256 去重；
- 页数和可解析性；
- 不允许非 PDF 伪装；
- 用户归属。

### Step B — 现有 PDF Processor

现有 Processor：

```text
PDF
→ page text
→ extracted images
→ text_manifest
→ image_manifest
```

全部继续走现有 D1 lease/fencing + R2 上传协议。

### Step C — Spam / Document Classification

在深度 Profile 生成前做一次轻量判断：

```json
{
  "document_type": "scientific_paper | non_paper | spam | invalid",
  "confidence": 0.0,
  "reason": "..."
}
```

规则：

- `scientific_paper`：继续；
- `non_paper/spam/invalid`：不进入 Papers Catalog，不触发匹配；
- 原 PDF 仍按用户资源生命周期处理，避免误删用户文件。

建议采用：

```text
确定性特征
(title / abstract / references / page count)
+
一次便宜模型分类
```

而不是只凭 LLM。

### Step D — Paper Profile Compiler

把提取文本、关键图片与 manifest 交给模型，要求严格 JSON Schema 输出。

论文不是只生成 summary，而是生成：

```json
{
  "paper": {
    "title": "...",
    "authors": [],
    "year": 2023,
    "venue": "...",
    "abstract": "...",
    "research_question": "...",
    "main_claims": []
  },
  "analysis_modules": [
    {
      "analysis_id": "analysis-01",
      "name": "Pearson correlation analysis",
      "goal": "...",
      "required_capabilities": [
        "tabular.numeric_features",
        "target.ordinal_or_numeric"
      ],
      "optional_capabilities": [],
      "operations": [],
      "expected_outputs": [],
      "verification": [],
      "evidence": [
        {
          "page": 2,
          "section": "3.1 Pearson Correlation Analysis"
        }
      ]
    }
  ],
  "paper_level_requirements": [],
  "display_tags": []
}
```

同一篇论文可以包含多个 `analysis_modules`。

这一步生成两个对象：

1. `paper_profile.json`：机器匹配使用；
2. `paper_overview.md`：DeepWiki 页面直接展示。

二者都带 `profile_version` 和 `model_version`。

---

# 4. Data Collections 页面

## 4.1 MVP 输入模型

为了保持与当前 Task Executor 的单 Dataset 输入合同兼容，第一版**不要实现任意多文件对象拼装**。

一个 Data Collection 对应：

- 一个单数据文件；或
- 一个 ZIP/TAR 类归档文件。

例如：

```text
Data Collection
Name: Red Wine Quality

dataset.zip
├── winequality-red.csv
└── README.txt
```

原始对象写入 R2。

优点：

1. 当前 Task 仍然只下载一个 Dataset object；
2. 不需要 Cloudflare Worker 临时打 ZIP；
3. DatasetSnapshot/Task 输入合同基本不改；
4. Inspector 在本地 Docker 解压即可。

后续再扩展浏览器多文件直传。

---

## 4.2 Data Collection Inspector

Data Collection 上传后进入：

```text
uploaded
→ inspecting
→ ready | failed
```

Inspector 与现有 Paper Processor **运行在同一台 Docker 主机上**，但代码职责独立。

第一版可以：

- 复用 Paper Processor 的 trusted-session / lease / fencing 模式；
- 同一个 Docker 镜像内增加 dataset inspection loop；
- 或同一 Compose 中使用同镜像不同 command。

不要再增加第三种任务事实源。

Inspector 做：

### 文件级扫描

- archive file list；
- 文件名；
- MIME / extension；
- 大小；
- hash；
- CSV/TSV/JSON schema；
- 行数 / 列数；
- 列名；
- bounded sample；
- missing ratio；
- numeric/categorical/text/image 等类型；
- README / metadata 文件摘要。

### Collection 级合并

输出 `dataset_profile.json`：

```json
{
  "collection_id": "...",
  "domain_hint": "machine_learning",
  "files": [],
  "capabilities": {
    "tabular.numeric_features": true,
    "target.ordinal_or_numeric": true,
    "sample_count": 1599,
    "feature_count": 11,
    "missing_values": false
  },
  "semantic_fields": {
    "target": "quality",
    "feature_names": []
  },
  "display_tags": [
    "Tabular",
    "Regression",
    "Classification",
    "11 Features",
    "1599 Samples"
  ]
}
```

注意：

> Dataset Tag 是 `capabilities` 的 UI 投影，不应成为唯一事实源。

---

# 5. Matching：Paper 需要什么 vs Dataset 有什么

## 5.1 两级匹配

### Level 1 — D1 快速候选召回

把常用 capability key 规范化，例如：

```text
tabular.numeric_features
target.numeric
target.ordinal
image.rgb
sequence.protein_fasta
annotation.gff
timeseries.timestamped
graph.edge_list
```

D1 只做粗筛：

```text
Paper required capabilities
∩
Dataset available capabilities
```

目的是减少模型调用。

### Level 2 — Feasibility Evaluator

召回候选后，把以下有限结构传给模型：

```text
Paper Profile
Dataset Profile
Analysis Modules
Execution Environment Summary
```

不要把整个原 PDF 和完整 Dataset 再塞进去。

输出严格 Schema：

```json
{
  "hard_gate": "pass | fail | review",
  "coverage": {
    "supported_modules": 5,
    "total_modules": 5,
    "ratio": 1.0
  },
  "execution_confidence": 78,
  "scientific_fit": 82,
  "missing_requirements": [],
  "risks": [],
  "recommended": true,
  "reason": "..."
}
```

`execution_confidence` 是 **0–100 的 gating/ranking score，不是真实概率**。

---

## 5.2 自动执行门槛

第一版采用：

```text
hard_gate == PASS
AND
coverage >= 0.60
AND
execution_confidence >= 60
```

才允许自动生成 Opportunity。

如果：

- Hard Gate fail：拒绝；
- 40–59：展示给用户，暂不自动执行；
- >=60：可进入自动 Task 流程。

建议再加一个系统级开关：

```text
DISCOVERY_AUTO_EXECUTE=false/true
```

上线初期先 `false` 做 shadow evaluation；
完整验收后再打开。

---

# 6. “值不值得写论文”的组件是什么

它不建议实现成一个随意的 `skill.md`。

在产品中应拆成两个 Evaluator：

## 6.1 Pre-Execution Feasibility Evaluator

本轮立即实现。

回答：

> 论文方法能否迁移到这个 Data Collection，并且是否值得花算力执行？

核心维度：

- 输入满足度；
- 分析模块覆盖度；
- 方法完整度；
- 数据规模与设计是否足够；
- 运行环境可实现性；
- 明显科学冲突；
- 预期输出完整度。

它决定是否创建 Task。

## 6.2 Publication Readiness Evaluator

本轮可以只保留接口，不阻塞 MVP。

它运行在 Task 成功、Artifact 已经产生之后。

建议结构：

```text
Hard Gates
- method validity
- statistical validity
- reproducibility
- claim/evidence consistency

Scored Dimensions
- novelty
- dataset fitness
- methodological rigor
- evidence strength
- robustness
- figure/reporting readiness
- venue fit
```

输出：

```text
P0 Invalid
P1 Technically Valid
P2 Supporting Result
P3 Manuscript-Core Ready
P4 Strong Publication Candidate
```

重要：

> 该结果是 evidence-backed readiness，不输出“录用概率 83%”。

其 rubric 要版本化：

```text
publication_evaluator_version = "pub-ready-v1"
```

所以它在工程上是一个 **Versioned Evaluator Policy**，可以由模型执行，但不应仅仅当 Prompt 文本管理。

---

# 7. D1 数据模型：最小新增

保持现有 Task / Attempt / Worker 表完全不动。

建议新增一个 migration：

```text
cloudflare-worker/migrations-infinity/0017_discovery_catalog.sql
```

### 7.1 papers

```text
paper_catalog
- paper_id
- owner_user_id nullable
- source_resource_id
- visibility: private/public
- title
- authors_json
- year
- venue
- status
- spam_status
- profile_version
- profile_json
- overview_object_key
- created_at
- updated_at
```

公共 Literature Watcher 论文：

```text
owner_user_id = NULL
visibility = public
```

用户上传论文：

```text
owner_user_id = user
visibility = private
```

避免把用户私人 PDF 自动公开。

### 7.2 paper capabilities

```text
paper_capabilities
- paper_id
- analysis_id
- capability_key
- requirement: required/optional
```

用于快速匹配。

### 7.3 data collections

```text
data_collections
- collection_id
- owner_user_id
- name
- source_object_key
- source_sha256
- status
- profile_version
- profile_json
- created_at
- updated_at
```

### 7.4 dataset capabilities

```text
dataset_capabilities
- collection_id
- capability_key
- capability_value
- confidence
```

### 7.5 matches

```text
research_matches
- match_id
- paper_id
- collection_id
- paper_profile_version
- dataset_profile_version
- status
- hard_gate
- coverage_ratio
- execution_confidence
- evaluator_version
- evaluation_json
- created_task_id nullable
- created_at
- updated_at
```

唯一约束：

```text
paper_id + collection_id + paper_profile_version + dataset_profile_version
```

防止重复评价和重复 Task。

---

# 8. R2 对象布局

继续使用当前 `RESOURCE_BUCKET`。

建议：

```text
papers/{resource_id}/source.pdf
papers/{resource_id}/text/...
papers/{resource_id}/images/...
papers/{resource_id}/profile/paper_profile.v1.json
papers/{resource_id}/profile/overview.v1.md

datasets/{collection_id}/source/data.zip
datasets/{collection_id}/profile/dataset_profile.v1.json

discovery/{match_id}/evaluation.v1.json

tasks/...                         # 继续现有路径
artifacts/...                     # 继续现有路径
```

D1 只保存 object key / hash / small metadata。

---

# 9. API：最小新增

不修改现有 Chat API。

新增：

```text
# Papers
POST   /api/discovery/papers
GET    /api/discovery/papers
GET    /api/discovery/papers/:id
DELETE /api/discovery/papers/:id

# Data Collections
POST   /api/discovery/data-collections
GET    /api/discovery/data-collections
GET    /api/discovery/data-collections/:id
DELETE /api/discovery/data-collections/:id

# Matches
GET    /api/discovery/matches
GET    /api/discovery/matches/:id
POST   /api/discovery/matches/:id/evaluate
POST   /api/discovery/matches/:id/create-task
```

自动流不通过浏览器自调用 HTTP。

Cloudflare Worker 内部直接调用共享的：

```text
createTask(...)
```

避免：

```text
Worker → 自己的公网 API → Worker
```

---

# 10. 自动新论文监测

本轮最后阶段再加，不要阻塞手动闭环。

复用 Cloudflare Worker `scheduled()`：

```text
scheduled
├── existing lease recovery
├── existing outbox flush
├── existing paper cleanup
└── literature discovery
```

第一版只接两个来源即可：

```text
arXiv
Europe PMC / PMC
```

D1 保存：

```text
literature_watch_state
- source
- query
- last_cursor
- last_checked_at
```

流程：

```text
Cron
→ search latest papers
→ canonical ID 去重
→ create public Paper Resource
→ existing Paper Processor
→ Profile Compiler
→ Match all ready Data Collections
→ Feasibility Evaluator
→ Opportunity / Task
```

必须有：

- 每轮数量上限；
- 去重；
- 日调用预算；
- 失败重试；
- 不因单篇失败中止整个 batch。

---

# 11. 部署拓扑

保持当前 Cloudflare 生产体系。

```text
Browser
  │
  ▼
Cloudflare Worker
  ├── Auth
  ├── Static frontend
  ├── Discovery API
  ├── D1
  ├── R2
  └── Scheduled discovery
          │
          ▼
       Internet

Cloudflare Control Plane
  │
  ├─────────────────────────────┐
  ▼                             ▼
Paper/Data Processor        Task Worker v2
Docker on your computer     Docker on your computer
  │                             │
  ├─ PDF extraction             ├─ Goal-Driven Claude Code
  ├─ Dataset inspection         ├─ research execution
  ├─ profile API call           └─ Artifact upload
  └─ D1/R2 processor API
```

你的笔记本只是提供重计算 Runtime。

公网事实状态继续存在 Cloudflare：

```text
D1 + R2
```

所以电脑重启不会丢 Paper Catalog / Data Collection / Match / Task 的事实记录。

---

# 12. 前端文件建议

推荐新增：

```text
frontend/app/papers/
frontend/app/papers/[paperId]/
frontend/app/data-collections/
frontend/app/data-collections/[collectionId]/

frontend/components/papers/
frontend/components/data-collections/
frontend/lib/api/discovery.ts
```

修改：

```text
frontend/components/workspace/AgentNav.tsx
```

只增加两个导航项，不动现有页面行为。

DeepWiki Paper Detail 使用静态 Next export 时，要像现有 Task detail 一样准备动态 route shell，并在 Edge Worker 静态路由中加入 paper detail / data collection detail 的 shell 映射。

---

# 13. 最小成功定义

本轮完成不是“页面出来了”。

必须真实完成：

```text
1. 上传公开论文 PDF
2. R2 保存
3. Paper Processor 成功解析文本和图
4. Spam 分类通过
5. 生成 Paper Profile
6. Papers 页面能显示 5 个分析模块
7. 创建 Data Collection
8. 上传真实数据归档
9. Dataset Inspector 生成 capability profile
10. Matcher 找到论文和数据的匹配
11. Evaluator 输出严格 JSON 和 score
12. score 达门槛时只创建一个 Task
13. Task Center 能看到该 Task
14. Windows/Mac Docker Worker 领取任务
15. Goal-Driven Runtime 完成分析
16. Artifact 成功进入 R2
17. 页面能从 Discovery 追溯到 Task / Artifact
```

只有这条链完全真实通过，才算新功能成立。

---

# 14. 生产验收案例

## 主测试案例

### Paper

**Prediction of Red Wine Quality Using One-dimensional Convolutional Neural Networks**

- arXiv: `2208.14008`
- PDF: https://arxiv.org/pdf/2208.14008
- Abstract: https://arxiv.org/abs/2208.14008

论文明确包含：

1. Pearson correlation；
2. PCA；
3. Shapiro-Wilk test；
4. data transformation / normalization；
5. 1D-CNN 训练与评价；
6. dropout / batch normalization；
7. baseline / ablation 相关实验。

第一版 Profile 至少稳定抽取 5 个核心 Analysis Modules。

### Dataset

**UCI Wine Quality**

- Dataset page: https://archive.ics.uci.edu/dataset/186/wine+quality
- Official archive: https://archive.ics.uci.edu/static/public/186/wine+quality.zip
- DOI: https://doi.org/10.24432/C56S3T

该数据体积小，适合生产链路测试：

- Red wine: 1599 samples；
- 11 physicochemical features；
- `quality` target；
- 无缺失值；
- CSV 规模远低于当前 25 MiB Task Dataset 限制。

### 预期匹配

Dataset Inspector 至少识别：

```text
tabular.numeric_features = true
target.ordinal_or_numeric = true
feature_count = 11
sample_count = 1599 (red)
missing_values = false
```

Paper Profile 至少要求：

```text
tabular.numeric_features
target.ordinal_or_numeric
numeric_matrix
sufficient_sample_count
```

最终应得到：

```text
hard_gate = PASS
coverage >= 0.60
execution_confidence >= 60
```

并在自动执行开关打开时生成唯一 Task。

---

# 15. 不在本轮做的事

为了避免继续膨胀，本轮明确不做：

- 不重构 Chat；
- 不替换 Worker v2；
- 不替换 Redis Relay；
- 不引入 PostgreSQL；
- 不做新的任务队列；
- 不做多 Region Worker Pool；
- 不做任意超大数据集；
- 不做浏览器多文件动态打包；
- 不让 LLM 的 0–100 score 冒充统计概率；
- 不做完整期刊投稿系统；
- 不自动公开用户上传的 PDF；
- 不用“Tag 相同”直接判定科学可行。

---

## 一句话架构

> **Papers 把论文编译成“需要什么、做什么、产生什么”的研究模板；Data Collections 把用户数据编译成“我拥有什么”的能力描述；Cloudflare 用结构化匹配和轻量 Evaluator 发现机会，达到门槛后复用现有 Task Center + Docker Worker 把机会变成真实 Artifact。**
