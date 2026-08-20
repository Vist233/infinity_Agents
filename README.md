# Infinity Agents

Infinity Agents 是面向生命科学研究的 Method-to-Result 工作台。它不是多个并列聊天
Agent，而是一条从研究问题、论文方法和数据到异步执行结果的完整链路。

## 产品闭环

```text
研究问题
→ Analysis 搜索、阅读和比较论文
→ 整理 Method Document 并关联 Dataset Snapshot
→ 用户确认，或在 Task Center 直接创建
→ Cloudflare D1 Task + zhangbot Redis 通知
→ Docker Worker 内的 Goal-Driven Claude Code 异步执行
→ Artifact 上传、校验和发布
→ 用户在 Task Center 查看并下载结果
```

## 三个产品区域

- **Analysis**：唯一主 Agent，负责论文研究、方法整理、执行文档和数据关联；
- **任务执行中心**：任务创建、状态、Attempt、Worker、事件和结果下载，不是第二个 Agent；
- **ImageJudge**：在本地使用参考图和自然语言规则处理图片批次，生成可复核的结构化分类结果，作为后续 Analysis 的数据输入。

ImageJudge 当前是参考图分类工具，不宣称已经完成通用多性状数值提取、物理量标定或科学准确性证明。

## Worker 架构

平台服务器、管理员电脑和学生电脑上的 Worker 全部加入同一个 D1/Redis 公共集群。
Cloudflare D1 是任务唯一事实源，zhangbot Redis负责通知、presence和实时事件；Docker
Worker通过受凭证保护的Cloudflare HTTPS API访问D1/R2。超级管理员统一提供Redis、API、
模型Provider、Namespace和公网地址；
普通用户只能点击“创建”触发服务器签发 Worker credential，并查看该 credential 对应的
Worker 状态；签发策略和签发密钥始终由超级管理员控制。

同一集群不表示所有机器共用管理员密码：每个 Worker 使用独立、最小权限、可撤销的
平台credential、Redis ACL和Provider机器凭证，不获得Cloudflare Account/D1管理Token。

一个 Worker credential 对应一个长期 Docker 容器。容器内直接运行 Claude Code，不使用
Docker-in-Docker 或 Docker Socket；每个任务只接收冻结的 Method + Dataset，上传结果后
清空本地目录并继续等待下一任务。

## 体验地址

[打开 Infinity Agents](https://infinity.zhangyvjing.com)

## 当前文档

- [当前 D1 + Redis Worker 架构决议](docs/ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)
- [当前续作实施计划](docs/D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md)
- [续作 Goal-Driven Prompt](docs/D1_REDIS_WORKER_GOAL_DRIVEN_PROMPT_2026-08-20.md)
- [旧 PostgreSQL Worker 架构（已被替代）](docs/ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md)
- [Worker 当前差距详细报告](docs/WORKER_ARCHITECTURE_GAP_REPORT_2026-08-19.md)
- [Worker 接入目标说明](docs/WORKER_ONBOARDING.md)
- [本地开发](docs/LOCAL_DEVELOPMENT.md)
- [ImageJudge 桌面端](image-judge/README.md)
- [Cloudflare 部署分支说明](https://github.com/Vist233/infinity_Agents/tree/cloudflare-deploy)

`main` 保存完整产品源码；`cloudflare-deploy` 在同一产品源码上增加 Cloudflare Worker、
Wrangler 和线上资源绑定。任何线上部署都必须能够由 GitHub 中记录的 Git SHA 和固定
Worker image digest 重建。
