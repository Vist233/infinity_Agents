# Infinity Agents — 计划文档迁移说明

> 状态：已拆分
> 日期：2026-08-09
> 原文件名保留用于兼容旧链接。

原文档把本地 MVP 与 Cloudflare 远程部署写在同一份文件中，容易让实现顺序和验收边界混淆。现在由以下互相衔接、职责独立的文档共同取代：

1. [本地 MVP 实施与实时验收计划](./LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md)
   - 本地产品边界；
   - Analysis/PaperAgent 2.0；
   - OIDC、用户文件隔离与 Resource 安全；
   - 异步 Goal-driven Task；
   - Claude Code + Anthropic Messages-compatible Coding Runtime；
   - Worker 自动加入、故障恢复；
   - T0–T13 实时验收与发布闸门。

2. [Cloudflare 远程部署计划](./CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md)
   - 只在本地 T0–T13 全部通过后进入；
   - 远程身份、存储、数据库、队列和外部 Worker 部署；
   - 不改变本地已经验收的产品合同。

3. [开发模型实施执行运行手册](./MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md)
   - GPT-5.6 Luna 与千问 Max 二选一，由所选单一模型顺序执行整个项目；
   - 规定拆卡、测试、checkpoint、失败恢复和必要时的整体现任切换；
   - 不把这两个开发模型写成产品部署模型；
   - 以测试、证据和 Gate 决定完成，不接受模型自报。

产品目标以 [Analysis Workspace 产品与系统设计](./ANALYSIS_WORKSPACE_SYSTEM_DESIGN.md) 为准；桌面分发另见 [性状提取桌面端分发计划](./TRAIT_EXTRACTION_DESKTOP_DISTRIBUTION_PLAN.md)。

唯一允许的执行顺序是：

```text
LOCAL_MVP_EXECUTION_AND_TEST_PLAN.md
全部通过 T0–T13
→
CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md
```

`MODEL_IMPLEMENTATION_EXECUTION_RUNBOOK.md` 贯穿上述两阶段，负责把每一阶段转换为模型可执行的小 Task Card；它不改变本地优先、Cloudflare 后置的顺序。

请不要继续依据旧版混合文档中的 C0–C7 章节实施。
