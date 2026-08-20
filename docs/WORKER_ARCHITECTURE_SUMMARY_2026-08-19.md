# Infinity Agents Worker 最新架构简报

> 更新：2026-08-20
> 权威ADR：`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`
> 续作计划：`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`

## 最终架构

```text
浏览器 / Analysis / Task Center
        ↓ HTTPS
Cloudflare Worker
        ├─ D1：Task/Attempt/Worker/Event/Outbox/Artifact metadata唯一事实源
        ├─ R2：Method/Dataset/Artifact文件
        └─ HTTPS Redis Relay → ssh zhangbot Redis
                              ↓ opaque task hint
长期Docker Worker ← Redis Consumer Group
        ↓ 持久Worker credential + HTTPS Worker v2 API
Cloudflare Worker → D1/R2
        ↓
容器内Claude Code + 固定Goal-Driven Prompt
```

D1是Cloudflare自带SQL数据库，使用SQLite语义，不是PostgreSQL。Hyperdrive连接的是外部
PostgreSQL，本项目当前不使用。

## 权限

- 全部Worker属于`public-default` / `infinity-public`公共集群；
- Worker可以领取任何用户的queued Task；
- `created_by`只限制网页查看和Artifact下载，不限制Worker领取；
- 不存在general/full、trusted/student或用户私有Worker池；
- 普通用户只能触发服务器签发credential并查看对应Worker状态；
- 超级管理员控制Namespace、Pool、D1/R2、Redis、Provider、协议和调度；
- Worker只拿自己的平台credential和窄Redis ACL，不拿Cloudflare Account/D1管理Token。

## 当前已经完成

- 唯一`backend/Dockerfile.worker`；
- 唯一`backend/code_agent/worker/claude_runtime.py`；
- 固定Goal-Driven Prompt；
- 无Docker-in-Docker、Docker Socket和独立Verifier；
- Artifact streaming/multipart、hash、manifest、ZIP和任务后清理；
- Task详情真实ID；
- PostgreSQL本地栈真实跑通两轮Case 2/3，证明Docker/Claude执行能力可用。

## 当前没有完成

- D1 canonical schema和单一public Worker策略；
- Worker v2 HTTPS Control/Data API；
- D1条件claim、lease和fencing；
- zhangbot HTTPS Redis Relay；
- Docker Worker切换到Redis hint + D1 HTTPS API；
- R2目标数据面；
- 目标D1/R2/Redis架构下重新跑Case 2/3；
- `0ed4811`之后的最终审查；
- GitHub、GHCR和Cloudflare发布。

## 为什么旧“已完成”不能继续使用

旧P9使用PostgreSQL，不是最新D1目标；旧P10只审查到`0349a8c`，之后`0ed4811`又修改了
21个文件。因此它们只能证明部分Runtime可复用，不能证明当前架构已完成。

## 下一步

只执行`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`的C0：建立完整迁移清单和baseline。
不要直接部署，不要重新维护PostgreSQL/D1双轨，不要从旧P0重新实现已通过的Docker Runtime。
