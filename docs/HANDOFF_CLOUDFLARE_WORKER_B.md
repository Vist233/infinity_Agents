# 统一 Docker Worker B 交接文档

> 适用分支：`cloudflare-deploy`
> 镜像：`ghcr.io/<org-or-user>/infinity-agent-worker:v1`
> 目标机器：已安装 Docker Desktop 的 Windows 电脑
> 本文不包含任何真实 credential、数据库 URL、Redis 密码或模型密钥。

## 目标架构

这台电脑是公共 Worker 集群中的一个长期执行节点。它只运行一个长期存在的
Docker Worker 容器：

```text
PostgreSQL（管理员提供，唯一任务事实源）
Redis（管理员提供，任务通知/事件）
                 │
                 ▼
Windows Docker Worker B
  ├─ 下载 Method + Dataset
  ├─ 使用固定 Goal-Driven 提示词运行 Claude Code
  ├─ 上传单文件或分片 Artifact
  ├─ PostgreSQL 租约/校验/完成
  ├─ 清空当前任务目录
  └─ 等待下一项任务
```

Cloudflare 只负责网页、登录和公网入口；旧的 `/api/worker/v1/*` HTTPS poll
客户端已经删除并由边界返回 410。不要安装 Wrangler、不要配置 Cloudflare API
Token、不要启动第二个 Redis、不要启动 verifier、不要在容器里启动 Docker，
也不要挂载 Docker socket。

## 管理员需要交给执行人员的配置

超级管理员统一签发并提供以下值。普通用户不能自行填写数据库、Redis、API、
Namespace 或 Provider 的中心配置：

```dotenv
WORKER_IMAGE=ghcr.io/<org-or-user>/infinity-agent-worker@sha256:<verified-digest>
WORKER_ID=<server-issued-worker-id>
WORKER_CREDENTIAL=<server-issued-persistent-credential>
WORKER_INSTANCE_ID=windows-worker-b-<unique-suffix>
WORKER_PROTOCOL_VERSION=1
WORKER_RUNTIME_CAPABILITY=goal-driven-claude-code
WORKER_IMAGE_DIGEST=sha256:<same-image-digest>

# 中央 API：负责当前 Attempt 的输入、模型能力和 Artifact 传输
WORKER_CONTROL_PLANE_URL=https://<administrator-central-api>

# 中央 PostgreSQL/Redis；不要使用 Cloudflare D1 或第二个本地服务
WORKER_DATABASE_URL=postgresql://<worker-role>:<password>@<db-host>:5432/<db>?sslmode=verify-full
WORKER_REDIS_URL=rediss://<redis-user>:<password>@<redis-host>:6380/0?ssl_cert_reqs=required
REDIS_NAMESPACE=<administrator-issued-shared-namespace>

# 仅写入这台机器的本地 env 文件；不提交、不上传、不写进镜像
ANTHROPIC_BASE_URL=<existing-local-provider-base-url>
ANTHROPIC_MODEL=<existing-local-model>
ANTHROPIC_API_KEY=<existing-local-api-key>
ANTHROPIC_AUTH_TOKEN=
```

`ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 按现有环境填写其中一个即可；
不要替换成陌生的默认值。若管理员的 Provider 通过中央 Attempt gateway
下发短期能力，则本机仍只保存管理员指定的本地配置，Worker 不把全局 Provider
密钥发送到 Cloudflare。

## Windows 文件准备

在仓库根目录复制示例：

```powershell
Copy-Item worker.cloudflare.env.example worker-b.cloudflare.env
```

把上面的真实值填入 `worker-b.cloudflare.env`，并将文件 ACL 限制为运行 Docker
Worker 的 Windows 账户。不要把文件加入 Git，不要粘贴到聊天，不要把 credential
放进命令行历史。

Compose 的变量插值来自 `--env-file`；因此启动时必须显式传入这个文件，不能只
设置 `WORKER_ENV_FILE`：

```powershell
docker login ghcr.io
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml config
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml up -d worker-b
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

`config` 只用于检查配置是否完整，不会启动容器。生产/公共机器使用不可变
digest；本地测试可以把 `WORKER_IMAGE` 改成已经本地构建并验收过的 tag。

## 启动前检查

```powershell
docker image inspect $env:WORKER_IMAGE
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml ps
```

启动日志中不得出现完整 credential、Redis URL、数据库密码或 Provider key。
Worker 应报告：

1. 以指定 Worker ID 和 instance ID 完成数据库身份校验；
2. Namespace 与凭证绑定一致；
3. Redis 可达并进入 ready 状态；
4. 等待任务而不是自动创建任务。

一个 credential 只能有一个活动 instance。需要第二台机器时，必须由管理员创建
新的 Worker ID 和持久 credential，不能复制本机 credential。

## 任务验收

通过网页创建 Case 2 或 Case 3 后，观察任务中心和容器日志：

```text
queued → claimed/running → download Method + Dataset
→ Goal-Driven Claude Code → Artifact upload
→ checksum/manifest/fencing finalize → succeeded
```

成功条件：

- 两个输入均来自当前 Task，单项不超过 25 MB；
- Claude Code 使用仓库固定的 Goal-Driven 平台提示词；
- 大结果通过分片上传，不把整个文件一次性读入浏览器；
- Artifact 可从任务中心下载并校验 SHA-256；
- 当前任务的输入、解压目录、临时日志和 scratch 已清空；
- 容器仍在线等待下一项任务。

不得用手工文件、mock、旧 Worker 或 Cloudflare 410 负测试冒充 Case 2/3 通过。

## 故障处理

- `WORKER_ALREADY_CONNECTED`：同一 credential 已有活动容器，先停止旧实例或申请新 credential。
- `Worker enrollment is invalid or revoked`：检查 Worker ID、Namespace、持久 credential 是否成对来自管理员。
- `REDIS_NAMESPACE does not match`：不要自行改 Namespace，重新向管理员核对整套凭证。
- 输入/Artifact 401 或 403：检查中央 API URL、Worker ID、credential 和当前 lease，不要改成匿名请求。
- `Claude Code CLI not found`：重新拉取已核验 digest，不要在运行容器内临时安装。
- 任务失败：保留日志和 Task ID，先检查中央 PostgreSQL/Redis/Provider 状态，不删除数据库记录。

## 停止与清理

测试结束只停止本次容器：

```powershell
docker compose --env-file worker-b.cloudflare.env -f docker-compose.cloudflare-workers.yml stop worker-b
```

不要撤销或删除其他 Worker，不要删除中央 PostgreSQL/Redis 数据，不要删除任务
Artifact。若需要重新常驻，使用同一个 Worker 注册启动同一 digest；如果迁移到
另一台电脑，则新建对应的 Worker ID/credential。
