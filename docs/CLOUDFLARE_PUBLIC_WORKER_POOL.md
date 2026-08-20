# 公共 Worker 池运行说明

> **状态：旧PostgreSQL接入说明，暂不可使用。** 当前接入合同见
> `ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`；Worker v2 API、Redis Relay和GHCR镜像完成后
> 必须重写本文的一键启动配置。

公共 Worker 是统一 PostgreSQL/Redis 集群中的长期 Docker 执行节点。Cloudflare
只提供网页、登录和公网入口，不是 Worker 的任务事实源，也不运行 Docker、Claude
Code 或旧的 HTTPS poll 客户端。

## 1. 公共注册

超级管理员在任务中心创建公共 Worker 注册：

- Namespace 使用管理员确定的公共 Namespace（当前示例为 `infinity-public`）；
- Worker ID 由服务端生成；
- 每个 Worker 有独立、持久、可撤销的 credential；
- 没有“两台”上限，点击创建多少次就可以生成多少个注册；
- 普通用户只能生成/查看自己被授权的凭证状态，不能配置公共数据库、Redis、API、
  Provider 或 Namespace；
- 不修改、不重启、不覆盖现有远程 Worker 的注册和容器。

## 2. Windows/Mac 启动

管理员把下列值交给执行机器，并写入本机受限 env 文件：

```dotenv
WORKER_IMAGE=ghcr.io/<org-or-user>/infinity-agent-worker@sha256:<verified-digest>
WORKER_ID=<server-generated-worker-id>
WORKER_CREDENTIAL=<persistent-worker-credential>
WORKER_INSTANCE_ID=public-worker-unique-instance
WORKER_CONTROL_PLANE_URL=https://<administrator-central-api>
WORKER_DATABASE_URL=<administrator-postgresql-url>
WORKER_REDIS_URL=<administrator-redis-url>
REDIS_NAMESPACE=<administrator-public-namespace>
ANTHROPIC_BASE_URL=<existing-local-provider-base-url>
ANTHROPIC_MODEL=<existing-local-model>
ANTHROPIC_API_KEY=<existing-local-key>
ANTHROPIC_AUTH_TOKEN=
```

使用仓库根目录的 image-only Compose 文件：

```sh
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml config
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml up -d worker-b
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

Compose 不会从源码构建镜像，也不会启动 PostgreSQL、Redis 或 verifier。生产使用
不可变 image digest；本地只允许使用已经完成边界检查的本地 tag。

## 3. 执行闭环

```text
PostgreSQL Task + Outbox
→ Redis opaque hint
→ Worker claim/lease/fencing
→ 下载 Method + Dataset
→ 固定 Goal-Driven Claude Code
→ Artifact 单文件/分片上传
→ checksum/manifest/finalize
→ 清理本地任务目录
→ 等待下一项任务
```

PostgreSQL 保存 Task、Attempt、Worker、Event 和 Artifact 事实；Redis 只负责通知、
presence 和事件加速。每个 Worker 使用自己的 credential 和最小权限数据库/Redis
身份。一个 credential 同时只允许一个活动 instance；同一 Namespace 可以有任意多个
不同 Worker。

## 4. Case 2 / Case 3 验收

真实 Case 2、Case 3 必须通过真实中央 PostgreSQL、Redis、Docker Worker 和 Claude
Code 代码路径完成：

1. 网页创建任务，不手工伪造 Task；
2. 两个输入分别为 Method、Dataset，各不超过 25 MB；
3. 任务由新 Worker claim，旧 Worker 不参与；
4. 结果上传并完成 checksum/manifest/fencing 校验；
5. 页面可下载 Artifact，重新计算 SHA-256 一致；
6. 容器任务目录清空，Worker 保持在线。

## 5. 停止与轮换

```sh
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml stop worker-b
```

停止容器不会删除数据库事实或 Artifact。credential 泄漏时先停止对应 instance，
再由超级管理员轮换/撤销；不要复制 credential 到第二台机器。
