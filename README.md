# Infinity Agents

Infinity Agents 是面向生命科学研究的 Method-to-Result 工作台。它不是多个并列聊天
Agent，而是一条从研究问题、论文方法和数据到异步执行结果的完整链路。

## 待发布的云端前端

```text
云端静态前端
├── Task Center：本地任务执行入口
├── Papers：本地论文检查/查看入口
└── Trait Agent / ImageJudge：桌面端说明与 GitHub Release 下载
```

任务、论文数据和执行在用户本地应用、本地数据库/文件和本地执行器中完成。HTTPS
云端页面不会默认跨源访问用户电脑的 `localhost` API；没有明确的 HTTPS API origin
时，Task Center 和 Papers 只显示可操作的本地入口说明。

## 三个产品区域

- **Task Center**：本地任务创建、状态和结果入口；
- **Papers**：本地论文上传、检查、结构化查看入口；
- **Trait Agent / ImageJudge**：保留现有示例页和桌面 Release 下载按钮。

ImageJudge 当前是参考图分类工具，不宣称已经完成通用多性状数值提取、物理量标定或科学准确性证明。

本分支不启用 Cloudflare Worker 部署。历史 `cloudflare-worker/` 和 ImageJudge Worker
配置仅为可回滚/审计材料；默认部署脚本已移除，线上资源不在本次变更中删除或修改。

## 现有线上地址

[打开 Infinity Agents](https://infinity.zhangyvjing.com)

本分支的静态前端改动目前仅保存在本地，尚未推送或部署；上述现有站点不代表本分支的验收结果。

## 当前文档

- [历史 D1 + Redis Worker 架构决议](docs/ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)
- [历史续作实施计划](docs/D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md)
- [历史 Goal-Driven Prompt](docs/D1_REDIS_WORKER_GOAL_DRIVEN_PROMPT_2026-08-20.md)
- [旧 PostgreSQL Worker 架构（已被替代）](docs/ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md)
- [历史 Worker 差距报告](docs/WORKER_ARCHITECTURE_GAP_REPORT_2026-08-19.md)
- [Worker 接入目标说明](docs/WORKER_ONBOARDING.md)
- [本地开发](docs/LOCAL_DEVELOPMENT.md)
- [ImageJudge 桌面端](image-judge/README.md)
- [Cloudflare 前端单独托管计划](docs/CLOUDFLARE_FRONTEND_ONLY_PLAN_2026-09-28.md)

`main` 保存完整产品源码；`cloudflare-deploy` 在同一产品源码上保留历史 Worker、
Wrangler 和线上资源绑定供审计/回滚，但当前交付只发布静态前端。任何未来获授权的
线上变更都必须能够由 GitHub 中记录的 Git SHA 和固定 Worker image digest 重建。
