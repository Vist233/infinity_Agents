# Worker 接入与执行说明

Worker 是一个持续消费共享 Redis 任务流的 Docker 容器。任务状态、凭证和结果元数据保存在中心 PostgreSQL，任务事件和心跳使用中心 Redis。

## 运行边界

- Worker 容器内直接启动 Claude Code 子进程。
- Worker 不挂载 `/var/run/docker.sock`，不启动 Docker-in-Docker，也不需要额外的 Job 容器。
- 每个任务使用独立的工作目录；任务完成后由执行器收集产物，下一次任务使用新的目录。
- Worker 控制面环境中的 PostgreSQL、Redis、Session、Worker 凭证和长期 Provider Key 不会传给 Claude Code；每个 Attempt 只接收由控制面签发的短期 Gateway URL/token/model 映射。
- `CLAUDE_CODE_ALLOW_ALL=1` 表示在 Worker 容器边界内允许 Claude Code 执行任务。Worker 容器本身应使用专用机器或专用账号，不要和其他服务共用高权限挂载。
- Worker 的 `trust_level` 由服务端根据签发账户生成：只有已验证的 `superuser`/`root` 角色或
  `SUPERUSER_USER_IDS` 中的账户会得到 `full`，普通用户和学生都是 `general`。不要在
  `worker.env` 中添加或修改信任等级；客户端字段不会被接受。
- 任务信任等级由服务端根据创建者生成：普通用户/学生创建的是账号范围内的 `general` 任务，
  超级用户创建的任务才是 `full`。`general` Worker 只能领取自己账号创建的任务；`full`
  Worker 是受控的服务器执行层。领取、输入下载和产物登记都会再次检查该策略。

## 新机器接入

前置条件：安装 Docker，能访问中心 PostgreSQL、Redis 和控制面 API，并能访问 Claude Code
所需的模型 API。若 Worker 与 API 不共享文件系统，必须配置 `WORKER_CONTROL_PLANE_URL`；
它用于在任务租约有效期间下载执行文档/数据集并上传结果归档。

1. 复制配置模板并填写：

   ```bash
   cp worker.env.example worker.env
   ```

至少设置：`REDIS_URL`、`REDIS_NAMESPACE`、`WORKER_DATABASE_URL`、`WORKER_A_CREDENTIAL`、`WORKER_B_CREDENTIAL`、
`WORKER_CONTROL_PLANE_URL`、`REDIS_PASSWORD`。Coding Provider 应配置在控制面；不要把长期 `ANTHROPIC_*` Key 写入 Worker 环境。

2. 在网页的“任务执行中心 → 添加 Worker”中填写唯一的 Worker ID 与 Namespace，签发后保存返回的持久凭证。凭证只在签发响应中明文返回，数据库只保存摘要。

3. 构建并启动两个本地 Worker：

   ```bash
   docker compose -f docker-compose.local.yml --env-file worker.env up -d --build worker-a worker-b
   ```

   这个 Compose 文件使用 `backend/Dockerfile.direct-worker`，镜像内安装 Claude Code，不会安装或调用 Docker CLI；
   两个容器分别读取 `WORKER_A_CREDENTIAL` 和 `WORKER_B_CREDENTIAL`，同一个凭证不会被两个 Worker 共用。
   Claude 子进程使用独立 UID，不能读取 Worker Supervisor 的控制面环境。

4. 启动 Outbox Publisher：

   ```bash
   docker compose -f docker-compose.local.yml --env-file worker.env up -d outbox-publisher reaper
   ```

   `worker.env` 中的 Outbox 和 Reaper 必须分别配置 `OUTBOX_DATABASE_URL`、
   `REAPER_DATABASE_URL`；它们不能复用 Worker 登录。Lease Reaper 是独立服务，普通
   Worker 不再负责回收其他 Worker 的租约。

## 验收

```bash
docker compose -f docker-compose.local.yml --env-file worker.env ps
docker compose -f docker-compose.local.yml --env-file worker.env logs --tail=50 worker-a worker-b
```

网页创建任务后，任务应从 `queued` 进入 `claimed/running`，完成后在任务详情页出现产物。若任务仍排队，先检查 Outbox Publisher、Redis Namespace、PostgreSQL 连接、任务创建账号和两个 Worker 的持久凭证是否属于同一中心环境。

## 凭证与密钥

- 每个凭证只对应一个 Worker ID；同一 Worker ID 重新签发会更新该 Worker 的凭证，旧凭证失效。
- Worker 凭证、数据库 URL 和 Redis 密码只放在本机 `worker.env`，不要提交到 Git 或镜像；模型 API Key 只留在控制面的 Provider Secret/Gateway。
- Claude Code 子进程只接收当前 Attempt 的 `ATTEMPT_GATEWAY_URL`、`ATTEMPT_GATEWAY_TOKEN`、`ATTEMPT_MODEL_ID`（映射成标准 Anthropic 变量）和显式的安全 `CLAUDE_*` 配置；长期 Anthropic/API Key 不得进入 Claude 子进程。
- 如果启动本地 Compose 的 Reaper，必须把 `ARTIFACT_HOST_ROOT` 指向控制面实际使用的 Artifact 根目录；Worker-only 机器不能假装拥有中心存储，否则应只运行两个 Worker。
- 中心 API 默认要求登录会话和 CSRF；本地未认证 Task API 只有在显式设置 `LOCAL_DEV_OPEN_TASK_API=1` 时才打开，不能带入 acceptance/production。

## 常见问题

- **登录页 404**：本地 Next 开发服务需要使用当前 `frontend/next.config.ts`，它会同时代理 `/api/*` 和 `/auth/*`；修改后重启前端。
- **127.0.0.1 被拒绝**：后端 `CORS_ALLOWED_ORIGINS` 必须包含实际前端 Origin，例如 `http://127.0.0.1:3000`，不能只配置 `http://localhost:3000`。
- **Worker 凭证无效**：确认 Worker ID、Namespace、中心数据库和凭证来自同一次签发；Redis key Namespace 也必须与 enrollment 完全一致。撤销后必须重新签发。
- **Claude Code 找不到**：检查 `docker compose ... logs worker-a`，并确认 `claude` 在 `backend/Dockerfile.direct-worker` 构建出的镜像中可执行；可用 `CLAUDE_CODE_COMMAND` 指定命令路径。
- **任务失败但没有结果**：查看任务详情中的事件和执行日志。结果文件必须写入任务输出目录，执行器才会收集并提交到中心数据库/存储；远程 Worker 还要确认 `WORKER_CONTROL_PLANE_URL` 可达且租约未过期。
