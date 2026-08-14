# Cloudflare Worker B 交接文档

> 适用分支：`cloudflare-deploy`
> 控制面：`https://infinity.zhangyvjing.com`
> 镜像名：`ghcr.io/<org-or-user>/infinity-agent-worker:v1`
> 本文不包含任何真实凭证；Worker ID、持久 credential、Redis ACL 和 Claude 配置必须从受信环境填入。

## 目标

在一台受信任的 Windows 电脑上常驻一个 Docker Worker B：

```text
Windows Docker Worker B
  ├─ HTTPS → Cloudflare control API / D1 / R2
  ├─ SSH 或受保护网络 → zhangbot Redis
  └─ 容器内直接运行 Claude Code
```

不启动 PostgreSQL、第二个 Redis、verifier 容器，也不在容器内启动 Docker；容器
不挂载宿主机 Docker socket。任务完成后只清理任务目录，容器继续在线等待下一项任务。

## 需要从任务中心取得的值

登录任务中心，展开 Worker 管理并点击“创建”，只填写 Namespace。每次创建都会得到新的
Worker ID 和新的持久 credential；同一 Namespace 可以创建任意数量 Worker。

```text
CONTROL_BASE_URL=https://infinity.zhangyvjing.com
WORKER_NAMESPACE=<创建时填写的共享 Namespace>
WORKER_ID=<本次创建返回的 Worker ID>
WORKER_CREDENTIAL=<本次创建返回的持久 credential>
WORKER_INSTANCE_ID=windows-worker-b
```

不要把 credential 发到聊天、提交 Git、写进镜像或放入浏览器 Local Storage。一个
credential 同时只允许一个活动实例；如果需要第二台机器，创建另一个 Worker ID。

## Windows 文件准备

在项目根目录复制 `worker.cloudflare.env.example` 为 `worker-b.cloudflare.env`，
填入上面的四个值，以及管理员自己的 Claude 配置：

```dotenv
CONTROL_BASE_URL=https://infinity.zhangyvjing.com
WORKER_NAMESPACE=<shared-namespace>
WORKER_ID=<server-generated-worker-id>
WORKER_CREDENTIAL=<persistent-worker-credential>
WORKER_INSTANCE_ID=windows-worker-b

WORKER_WORK_ROOT=/worker-inputs
WORKER_OUTPUT_ROOT=/worker-outputs
WORKER_REDIS_REQUIRED=1
WORKER_RECYCLE_AFTER_TASK=0
WORKER_POLL_INTERVAL=5
WORKER_TASK_TIMEOUT_SECONDS=43200

# 只填写这台受信电脑自己的模型配置，不上传到 Cloudflare。
ANTHROPIC_BASE_URL=<local-provider-base-url>
ANTHROPIC_MODEL=<local-provider-model>
ANTHROPIC_API_KEY=<local-api-key>
ANTHROPIC_AUTH_TOKEN=
```

`ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 至少填写一个；三项模型配置使用
管理员现有环境变量，不要使用陌生的默认值。将此文件 ACL 限制为 Docker/Worker
服务账户可读。

## Redis 连接

Cloudflare D1 不是直接 SQL 连接，Worker 通过 HTTPS control API 访问它。Redis
仍使用 zhangbot 上已有的 Redis，不创建新 Redis。

如果 Windows 能使用 OpenSSH，先建立 SSH 隧道（端口按本机空闲端口调整）：

```powershell
ssh -N -L 16379:127.0.0.1:6379 zhangbot
```

然后在 `worker-b.cloudflare.env` 中使用 zhangbot 管理员提供的 ACL 用户名和密码：

```dotenv
REDIS_URL=redis://<redis-username>:<redis-password>@host.docker.internal:16379/0
```

不要把 Redis 密码写入本交接文档。若 Docker VM 无法通过
`host.docker.internal` 访问隧道端口，应把隧道终点改为该 VM 可访问的受保护地址，
但不要将 Redis 端口公开到公网。

## 一键启动

在包含 `docker-compose.cloudflare-workers.yml` 的项目根目录执行：

```powershell
docker login ghcr.io
$env:WORKER_IMAGE = "ghcr.io/<org-or-user>/infinity-agent-worker:v1"
$env:WORKER_ENV_FILE = "worker-b.cloudflare.env"
docker compose -f docker-compose.cloudflare-workers.yml up -d --build worker-b
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

这条命令会从 `worker-b.cloudflare.env` 读取 Redis、Worker credential 和 Claude
配置；Compose 文件本身不覆盖这些值。Mac 上的远程 Redis 隧道测试另用仓库中的
`scripts/run_local_cloudflare_workers.sh`，它会在内存中注入隧道地址，不会改写这个
配置文件。

如果镜像尚未推送到 GHCR，使用本地构建标签：

```powershell
$env:WORKER_IMAGE = "infinity-agent-worker:cloudflare"
docker compose -f docker-compose.cloudflare-workers.yml up -d --build worker-b
```

镜像内包含 Node、Python、Claude Code CLI 和 Worker 控制程序；不包含任何凭证、
Docker CLI 或 Docker socket。启动日志中不得打印 credential、Redis URL 或模型 Key。

## 连接验收

启动后在任务中心查看该 Worker 是否在线。控制面应完成：

```text
connect → heartbeat → health → poll → accept → download inputs
→ Claude Code → ZIP + SHA-256 → upload → finalize → succeeded/published
```

`finalize` 直接把绑定当前租约的 Artifact 发布为可下载结果；当前不使用
`verification_pending`，也不需要 verifier 服务。Worker B 完成一个任务后仍应保持
在线，等待下一个任务。

## Case 2 / Case 3 测试

测试前确认：

1. 使用新的本地 Worker B 注册，不修改或重启远程现有 Worker；
2. Case 2 和 Case 3 的执行文档、ZIP 数据集各自不超过 25MB；
3. 在任务中心创建任务并确认提交；
4. 观察 Worker 日志和任务状态，最终必须为 `succeeded`；
5. 下载 Artifact，重新计算 SHA-256，与任务详情一致；
6. 确认容器任务目录已清空、Worker 仍在线；
7. 删除/停止测试容器后，不删除任务中心数据库记录和 R2 Artifact。

Case 2 应至少产生序列统计、可解析树、图片、脚本/依赖/日志/报告；Case 3 应
至少产生矩阵、barcode/gene 对齐、QC、cluster、marker、UMAP、h5ad 和报告。
不能用手工生成的输出冒充 Worker 结果。

## 故障处理

- `WORKER_ALREADY_CONNECTED`：同一 credential 已有活动实例，停止旧实例或创建新的 Worker。
- `WORKER_SESSION_LOST`：会话租约失效，进程会重新握手；不要重新注册。
- `REDIS_URL is required`：检查 SSH 隧道、ACL 和 env 文件，不要创建本地 Redis。
- `Claude Code CLI not found`：重新构建指定镜像，不要在容器内临时安装并改变运行环境。
- 缺少 ID/credential/模型配置：停止容器，补齐本机 env；不要把密钥写入镜像。

## 清理

测试结束只停止本次 Worker B：

```powershell
docker compose -f docker-compose.cloudflare-workers.yml stop worker-b
```

不要撤销远程现有 Worker，不要删除任务中心注册，不要删除 zhangbot 上原有 Redis，
也不要删除线上 D1/R2 数据。若以后再次常驻，使用同一 Worker B 的 credential；若
需要第二台电脑，创建新的 Worker 注册。
