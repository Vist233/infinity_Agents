# Infinity Agents

Infinity Agents 是面向生命科学研究的 **Method-to-Result 工作台**。它的目标不是提供三个并列的聊天 Agent，而是把研究问题、论文方法、用户数据和可验证的计算结果连接成一条可追踪的工作流。

## 体验地址

[打开 Infinity Agents](https://infinity.zhangyvjing.com)

## 核心工作流

```text
研究问题
  → Analysis 检索论文、阅读资料并整理方法
  → 形成可读、可执行的 Method Document 与 Dataset 关联
  → 用户确认关键科学选择
  → 任务执行中心冻结并提交异步 Task
  → Docker Worker 长时执行、排错和恢复
  → Verifier 验收并发布可下载的 Artifact
```

任务的事实输入是冻结后的 Method Document 和 Dataset Snapshot；聊天消息、Redis 消息或模型自述都不能替代任务状态和结果证据。

## 产品结构

### Analysis：唯一主 Agent

Analysis 负责研究工作本身：

- 检索和比较 PubMed、Europe PMC、arXiv 等公开来源；
- 阅读论文、补充材料、PDF、网页和提取图片；
- 提取软件版本、步骤、参数、输入输出和证据位置；
- 关联用户数据集，整理执行文档和 TaskSpec；
- 在用户明确确认后提交异步任务。

Analysis 不在 Web/API 进程中安装 R/Python 包，也不长时间占用对话上下文执行代码。长时计算由独立的 Docker Worker 完成。

### 任务执行中心：异步计算控制面

任务执行中心不是第二个聊天 Agent，而是所有异步任务的控制与结果界面。它负责展示和管理：

- queued、running、verifying、succeeded、failed 等任务状态；
- Worker、Attempt、租约、事件和失败原因；
- 经过验证的代码、日志、表格、图片、报告和 manifest；
- Task 取消、重试以及属于当前用户的结果下载。

### ImageJudge：本地图片数据生产工具

ImageJudge 是 Infinity Agents 的桌面端图片数据入口。它在本地处理图片批次，使用参考图和自然语言规则完成参考图引导分类，生成可复核的结构化结果，并将结果作为后续 Analysis 和科研任务的数据输入。

当前版本仍然是参考图分类器，主要输出分类、状态、复核标记和理由；它尚不宣称已经完成通用多性状数值提取、物理量标定或科学准确性证明。未来的性状提取能力必须建立在版本化 TraitDefinition、逐图 TraitObservation、标定和质量控制之上。

## 运行边界与数据职责

- **PostgreSQL** 是 Session、Resource、Task、Attempt、Event 和 Artifact 的事实源。
- **Redis** 负责通知、队列协调、实时事件和短期缓存，不保存不可重建的任务事实。
- **Docker Workers** 可以运行在本机或服务器上，负责隔离执行长时 Goal-driven 任务。
- **ImageJudge 桌面端** 在本地管理图片和结构化结果；Web 不自动接收整份原图目录，用户选择的结构化输出才进入 Analysis。
- **模型 Provider** 由用户或部署环境配置。使用远程视觉/语言模型时，实际发送范围取决于对应的 Provider 与隐私策略，不能笼统宣称所有数据永不离开设备。

## 文档

- [技术架构与本地运行](docs/LOCAL_DEVELOPMENT.md)
- [ImageJudge 桌面端说明](image-judge/README.md)
- [Cloudflare 部署说明](https://github.com/Vist233/infinity_Agents/blob/cloudflare-deploy/cloudflare-worker/README.md)
- [Analysis Workspace 产品与系统设计](docs/ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md)
- [本地 MVP 实施与验收计划](docs/LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md)

`main` 是完整产品源码；`cloudflare-deploy` 在相同源码之上增加 Cloudflare Worker、Wrangler 配置和线上资源绑定。
