# Worker 接入与执行说明

> 当前合同：`docs/ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`
> 当前镜像入口：`backend/Dockerfile.worker`
> 当前状态：C4 的 D1/HTTPS Worker 本地实现已完成；真实 D1、R2、zhangbot Relay 和 Claude
> Case 2/3 验收属于 C5，未获得远程操作授权前不修改线上环境。

## 1. 唯一生产架构

Cloudflare D1 是唯一 SQL 和任务事实源。它保存 Task、Attempt、Worker session、Event、
Outbox 以及 Artifact 元数据；R2 保存 Method、Dataset 和最终 Artifact 文件本体。

zhangbot 上的 Redis 只保存可重建的任务提示、Worker presence 和实时事件。Cloudflare Worker
通过受认证的 HTTPS Relay 写入 Redis，Docker Worker 不连接 Redis TCP，也不获得 Redis 管理密码。

```text
网页用户
  -> Cloudflare Worker / env.DB(D1) + R2
  -> D1 Outbox -> zhangbot HTTPS Redis Relay -> 可重建 hint
  -> Docker Worker v2 HTTPS API -> D1/R2
  -> 容器内直接运行 Claude Code
  -> R2 multipart Artifact + D1 finalize
```

不存在 PostgreSQL、Hyperdrive、DATABASE_URL、RLS claim、学生/可信 Worker 等级或私有
Worker 池。所有 Worker 都属于服务端固定的 `public-default / infinity-public` 公共池。

## 2. 身份和权限

- 超级管理员控制 D1、R2、Relay、公网地址、协议、镜像 digest、Provider 配置和签发策略。
- 普通用户只能点击网页“创建”，获得服务端生成的持久 Worker ID 和 credential，并查看
  自己生成的 Worker 状态。
- Namespace、Pool、数据库地址、Redis 地址、Cloudflare token 和 Provider 管理配置不能由
  浏览器或 Worker 自己提交。
- 可以创建任意数量的 Worker，没有两个 Worker 的上限。
- 一个持久 credential 只能绑定一个 active instance；同 credential 的第二个实例会被拒绝。
- 轮换 credential 会立即使旧 credential 失效；撤销会使连接、续租、下载、上传和 finalize
  全部失效。

## 3. 超级管理员交给 Windows 机器的内容

管理员只需提供以下已验证值：

1. 固定 GHCR 镜像引用和 digest；
2. Cloudflare Worker HTTPS 地址；
3. zhangbot Redis Relay HTTPS 地址和 Worker hint token；
4. 本次容器对应的 Worker ID 和持久 credential；
5. `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`，以及批准使用的 API Key 或 Auth Token。

Windows 机器不需要、也不应该填写：

- D1 管理 token 或 D1 REST API 地址；
- R2 parent key；
- Redis 管理密码或 raw Redis URL；
- PostgreSQL 地址；
- Namespace、Pool、信任等级或任务所有者。

配置模板是仓库根目录的 `worker.cloudflare.env.example`。复制后填入真实值，文件只允许
Docker Worker 账户读取：

```powershell
Copy-Item worker.cloudflare.env.example worker-b.cloudflare.env
```

## 4. 一键启动

在 Windows PowerShell 中进入包含 `docker-compose.cloudflare-workers.yml` 的目录：

```powershell
docker login ghcr.io
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml pull
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml up -d
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

停止容器但保留配置和公共集群中的 Worker 记录：

```powershell
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml down
```

重新启动使用同一个 Worker credential；不重新签发临时 token。若要启动第二个容器，必须先
在网页中点击“创建”得到另一个 Worker ID/credential，并使用另一个 env 文件和另一个
`WORKER_INSTANCE_ID`。不能复制第一台机器的 credential。

## 5. Worker v2 协议

唯一控制/数据面路由：

```text
POST /api/worker/v2/connect
POST /api/worker/v2/heartbeat
POST /api/worker/v2/poll
POST /api/worker/v2/tasks/:id/accept
POST /api/worker/v2/tasks/:id/renew
GET  /api/worker/v2/tasks/:id/spec
GET  /api/worker/v2/tasks/:id/inputs/method|dataset
POST /api/worker/v2/tasks/:id/artifacts/start
PUT  /api/worker/v2/artifacts/:upload/parts/:part
POST /api/worker/v2/artifacts/:upload/complete
POST /api/worker/v2/tasks/:id/fail
POST /api/worker/v2/tasks/:id/cancelled
```

Redis hint 只用于唤醒。真正的 poll、claim、续租、输入下载、Artifact 上传和任务终态都由
D1 控制的 HTTPS API 完成。即使 Redis 清空或短暂不可用，Task 也仍在 D1，Worker 可以恢复
poll；不会产生第二个任务事实源。

## 6. 单个任务的真实执行

```text
收到 hint
-> D1 poll + CAS accept
-> 读取冻结 TaskSpec、Method、Dataset
-> 每个输入 <= 25 MiB，并校验 D1 记录的大小/SHA-256
-> 使用平台固定 Goal-Driven Prompt
-> 容器内以非 root 用户直接运行 Claude Code
-> 收集结果 ZIP，按 R2 multipart 流式上传
-> 服务端校验 lease/fencing、对象、大小、SHA-256、manifest 和 ZIP
-> D1 原子写 succeeded + Artifact published
-> 成功/失败/取消/超时/失租后删除任务目录
-> 同一容器继续等待下一任务
```

没有独立 Verifier、子任务容器、Docker-in-Docker 或 Docker Socket。Claude Code 的 provider
配置只传给容器内的非 root Claude 子进程；Worker credential、Relay token 和平台控制面
信息不会传给 Claude。

## 7. 连接排错顺序

1. `WORKER_IMAGE` 是否为管理员提供的 digest，且镜像架构与 Windows 虚拟机 Docker 架构匹配；
2. `WORKER_ID`、`WORKER_CREDENTIAL` 是否属于同一条服务端签发记录；
3. `WORKER_INSTANCE_ID` 是否是本机唯一且稳定的值；
4. 控制面和 Relay 是否为可访问的 HTTPS 地址；
5. `WORKER_PROTOCOL_VERSION=2` 与 `goal-driven-claude-code` 是否保持不变；
6. Claude 三项 provider 配置是否来自管理员已批准的环境；
7. 查看 `connect`、`poll`、`heartbeat` 的错误码，再处理任务内容问题。

不要通过修改 Namespace、添加 PostgreSQL URL、直连 Redis 或临时签发 token 来绕过错误。

## 8. 当前验收边界

C4 已在本地完成以下可观察验证：

- Worker v2 HTTP 客户端、输入流式下载和 R2 multipart 上传测试通过；
- Executor 上传结果后删除 attempt 目录测试通过；
- Docker 镜像可构建，入口模块可导入；
- 镜像内没有 `asyncpg`、Redis Python 客户端、Docker CLI 或 Docker socket；
- 镜像内 Claude Code 可执行；
- D1 Edge typecheck 和 53 个测试通过，Python 全量为 328 passed / 45 skipped。

这些结果不等于真实远程 D1/R2/Relay/Claude Case 2/3 已通过。C5 必须在取得明确远程
操作授权后，从真实网页任务开始，下载最终 Artifact 并记录大小和 SHA-256。

## 9. 旧文件说明

`backend/code_agent/worker/consumer.py`、`executor.py`、`reaper.py`，以及旧的
`docker-compose.local.yml`、`docker-compose.acceptance.yml` 和旧迁移表只作为历史测试/迁移
记录保留，不能用于 Cloudflare D1 生产 Worker。唯一有效的生产镜像和 Compose 文件分别是
`backend/Dockerfile.worker` 与 `docker-compose.cloudflare-workers.yml`。在 C5 真实链路通过、
调用关系再次确认后，再删除不再被测试或迁移依赖的历史代码。
