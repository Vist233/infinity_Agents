# Worker 新机器接入清单

当前 Cloudflare 版本以 Cloudflare D1/R2 控制面和 `zhangbot` 上的现有 Redis
为中心。浏览器只创建持久 Worker 注册；真正运行的 Docker Worker 在用户的
Mac 或 Windows 上启动，并通过 HTTPS 反向握手加入集群。

## 在任务中心创建注册

1. 打开 `https://infinity.zhangyvjing.com/code-agent/`。
2. 展开右侧“添加 Worker”；默认保持折叠。
3. 只填写 Namespace 并提交。Namespace 是可复用工作范围，同一范围可以添加
   多个不同的 Worker ID。
4. 页面返回服务器生成的 Worker ID 和持久凭证。凭证可复制、可由所有者重新
   生成；D1 保存凭证摘要和加密副本，不保存明文。

信任级别由登录权限生成：只有 superuser 是 `owner_trusted`，普通用户和学生
都是 `institution_trusted`。一个凭证只绑定一个 Worker ID；同一凭证同时只能
有一个活动实例。停止机器后会话租约过期，凭证本身不会失效。

## macOS / Windows 的轻量客户端

Node 18+ 客户端只用于连接、健康检查和控制面轮询：

```sh
export INFINITY_WORKER_CREDENTIAL='从任务中心复制的持久凭证'
node cloudflare-worker/worker-client.mjs configure \
  --control-url https://infinity.zhangyvjing.com \
  --worker-id '<任务中心返回的 Worker ID>' \
  --namespace '<任务中心填写的 Namespace>'
node cloudflare-worker/worker-client.mjs connect
node cloudflare-worker/worker-client.mjs health
node cloudflare-worker/worker-client.mjs poll
```

`connect` 会生成并保存本机 `instance_id` 和会话 ID。第二台机器误用同一
凭证时会收到 `WORKER_ALREADY_CONNECTED`，必须使用另一个 Worker ID/凭证。

## Docker Worker（本地执行）

Docker Worker 使用 `worker.cloudflare.env.example` 创建两个本地配置文件，分别
填入两个 Worker 的 ID、持久凭证和不同的 `WORKER_INSTANCE_ID`，然后启动：

```sh
cp worker.cloudflare.env.example worker-a.cloudflare.env
cp worker.cloudflare.env.example worker-b.cloudflare.env
docker compose -f docker-compose.cloudflare-workers.yml up -d --build
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-a worker-b
```

这套 compose 为两个 Worker 各自创建独立的输入和输出 named volume，并按任务
子目录挂载到实际执行容器；不要把两个 Worker 改成共享同一个 volume，也不要
删掉 `/var/run/docker.sock` 挂载，否则 Worker 无法启动本地任务执行器。

配置含义：

- `CONTROL_BASE_URL` 是 Cloudflare Worker 控制/API 地址，不是 D1 的直接 SQL
  地址；本地 Worker 不直接连接 D1。
- `REDIS_URL` 指向现有远程 Redis，`WORKER_REDIS_REQUIRED=1` 时 Redis 不通就
  不会加入集群；这套 compose 不会再启动一个本地 Redis。
- `WORKER_CREDENTIAL` 是 Worker API 凭证，不是 Cloudflare Account API Token。
- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、
  `ANTHROPIC_MODEL` 只保存在本地 env 文件，并只传给本地执行容器；不会上传
  到 D1、浏览器、日志或 Cloudflare 控制面。

配置文件只允许本机 Worker 服务账号读取。不要提交 Git，也不要把这些值写入
前端设置或聊天内容。

## 连接状态和故障判断

- `Registered / Not connected yet`：D1 注册成功，但本地 Worker 尚未握手。
- `Online`：握手成功并持续发送心跳。
- `WORKER_ALREADY_CONNECTED`：同一凭证已有活动实例，使用另一个 Worker ID。
- `WORKER_SESSION_LOST`：会话租约过期，Worker 会重新握手；凭证无需更换。
- 迁移前创建、无法恢复明文的旧记录，在任务中心点击“重新生成并复制”，
  不会改变 Worker ID。

## 安全边界

- Worker 只用 HTTPS 控制 API 访问 Cloudflare D1/R2 任务资源。
- Redis 密码、Provider key 和数据库连接信息只在本地 Worker 配置中存在。
- Worker finalize 后结果仍是 `verification_pending`，不能自行提升为用户可见的
  `succeeded`。
- `/api/worker/v1/enroll` 及 `enroll` 命令仅为旧客户端兼容保留，不用于新的
  持久 Worker。
