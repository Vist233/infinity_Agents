# Worker 新机器接入清单

Infinity Agent 的 Worker 是**无状态**的：任务通过 Redis Stream 消费组 +
PostgreSQL CAS 抢占分发。新增一台 Worker 不需要任何注册中心——起一个容器，
它就自动加入竞争。

## 前置条件（新机器上必须满足）

| # | 条件 | 说明 |
|---|------|------|
| 1 | 安装 Docker 并且 daemon 运行中 | Worker 通过 `/var/run/docker.sock` 调用宿主机 daemon（Docker-out-of-Docker） |
| 2 | 能访问 PostgreSQL | 容器内**不能写 localhost**，宿主机数据库要用 `host.docker.internal`；远程机器填真实 IP/域名 |
| 3 | 能访问 Redis | 与 API 服务器同一个 Redis 实例 |
| 4 | 本地有执行镜像 | `claude-code-env:v2`（可用 `docker images` 确认；镜像 digest 会记录到 task_attempts 用于复现） |
| 5 | LLM API 密钥 | `ANTHROPIC_API_KEY`（或 `STEPFUN_API_KEY`），由 worker.env 透传进 Job 容器 |

## 接入步骤

1. 拷贝配置模板并填写：

   ```bash
   cp worker.env.example worker.env
   # 编辑 worker.env：REDIS_URL / DATABASE_URL / ANTHROPIC_API_KEY
   ```

2. 构建 Worker 镜像（只需要一次）：

   ```bash
   docker build -f backend/Dockerfile.worker -t infinity-agent-worker:latest .
   ```

3. 启动 Worker，两种方式任选：

   **方式 A：单机直接 docker run（"填个地址就能跑"）**

   ```bash
   docker run -d --name worker-$(hostname) \
     --env-file worker.env \
     -e WORKER_ID=worker-$(hostname) \
     -v /var/run/docker.sock:/var/run/docker.sock \
     infinity-agent-worker:latest \
     python -m backend.code_agent.worker.consumer worker-$(hostname)
   ```

   **方式 B：docker compose（本机整套：Redis + 两个 Worker + Outbox）**

   ```bash
   docker compose -f docker-compose.local.yml --env-file worker.env up -d
   ```

## 验证接入成功

```bash
# 1. Worker 日志应出现 "Connected to Redis" / claim 日志
docker logs worker-$(hostname) --tail 20

# 2. API 侧确认 Worker 存活（需要 Redis 可达；设置了 TASK_API_TOKEN 时需带 key）
curl -H "X-API-Key: <TASK_API_TOKEN>" http://<api-host>:8000/api/worker/health
```

## 生产部署安全清单（必须）

| # | 配置 | 说明 |
|---|------|------|
| 1 | `TASK_API_TOKEN` | **必须设置**。未设置时整个 Task API（含 worker/outbox 端点）对任何能访问服务器的人开放。前端需用相同的 `NEXT_PUBLIC_TASK_API_TOKEN` 构建 |
| 2 | `REDIS_PASSWORD` | **必须设置**。Redis 默认无密码，局域网内任何人可读写任务流。设置后 `REDIS_URL` 要写成 `redis://:密码@host:6379/0` |
| 3 | PostgreSQL 访问控制 | 不要对公网开放 5450 端口；远程 Worker 建议走内网/VPN |
| 4 | `ANTHROPIC_API_KEY` | 只写进 worker.env（已 gitignore），永远不要进镜像或代码 |


## 常见问题

- **容器内连不上数据库**：`localhost` 在容器里指向容器自己。宿主机上的
  PostgreSQL 请用 `host.docker.internal:<端口>`；Linux 宿主机需要
  `--add-host=host.docker.internal:host-gateway`。
- **Job 容器拉不起来**：确认宿主机存在 `claude-code-env:v2` 镜像，
  Worker 挂载的 docker.sock 有权限访问。
- **任务一直 queued**：检查 Outbox Publisher 是否在运行
  （API 进程自带；compose 里有独立的 outbox-publisher 兜底），
  以及 Redis 是否可达。
- **密钥不生效**：确认 worker.env 里设置了 `ANTHROPIC_API_KEY`，
  Worker 会把 `ANTHROPIC_*` 前缀的环境变量透传进 Job 容器。
