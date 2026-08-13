# Cloudflare Deploy 公共 Worker 池运行说明

本分支的 Cloudflare Edge Worker 是控制面，不在 Edge Runtime 中运行 Docker 或
Claude Code。公共执行面是两台长期运行的 Docker Worker，通过 HTTPS 连接
`https://infinity.zhangyvjing.com`。

## 1. 创建公共注册

使用超级用户登录任务中心，打开“公共执行 Workers”卡片，点击“补齐两个公共
Worker”。系统会在 D1 的 `public-default` 池中创建两个独立注册：

- Namespace 固定为 `infinity-public`；
- Worker ID 由服务端生成；
- 两个 Worker 使用不同的持久 credential；
- credential 的摘要和加密副本保存到 D1；
- credential 恢复、轮换、撤销都会写入 `worker_admin_events`；
- credential 只复制到受限的执行服务器配置，不提交 Git。

公共池管理 API 只接受服务端验证出的超级用户角色。普通用户的 Worker 列表不
会返回公共注册，普通用户也没有公共 Worker 的任务列表接口。

## 2. 两个执行实例

在执行服务器准备两个本机可读的 env 文件：

```text
CONTROL_BASE_URL=https://infinity.zhangyvjing.com
WORKER_ID=<公共 Worker A 的服务端生成 ID>
WORKER_NAMESPACE=infinity-public
WORKER_CREDENTIAL=<公共 Worker A 的持久 credential>
WORKER_INSTANCE_ID=public-worker-a
WORKER_REDIS_REQUIRED=0
ANTHROPIC_BASE_URL=<本机 Claude Code 配置>
ANTHROPIC_MODEL=<本机 Claude Code 配置>
ANTHROPIC_AUTH_TOKEN=<本机 Claude Code 配置>
```

Worker B 使用另一套 Worker ID、credential 和 `WORKER_INSTANCE_ID`。模型相关
变量由管理员按本机环境填写；不要把真实值写入此文档或仓库。Worker 启动时会
强制检查 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`，以及
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 至少一个。

Compose 将这两个 env 文件标记为可选，因此全新目录可以先执行 `docker compose
config` 或 `docker compose build`。真正启动前仍必须创建并填写它们；如果缺少
Worker ID、Namespace、credential 或 Claude 配置，容器会安全退出，不会使用占位符
连接控制面。`verifier` 默认使用 Compose profile 关闭；本轮公共 Worker 不需要
启动它。

启动现有的两 Worker compose：

```sh
docker compose -f docker-compose.cloudflare-workers.yml up -d --build worker-a worker-b
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-a worker-b
```

这两个容器只访问 Cloudflare HTTPS 控制面和模型 Provider。默认不要求 Redis，
也不连接 D1、PostgreSQL、R2 parent credential 或 Cloudflare Account API。

## 3. 调度规则

每个任务使用 `owner_then_public`：

1. 任务创建者自己的在线空闲 Worker 先获得 offer；
2. 创建者 Worker 忙碌或离线时，公共 Worker 才能领取；
3. 公共 Worker 可以处理所有用户的排队任务，但只收到已经领取的 Attempt；
4. 浏览器任务列表、任务详情、事件和 Artifact 下载仍按 `created_by` 隔离；
5. 用户 Worker 的 Poll 查询始终限制在自己的 `owner_user_id`；
6. offer 接受、任务租约和 fencing epoch 在 D1 中再次检查，防止重复执行。

## 4. 轮换与故障处理

- 轮换公共 credential 会立即断开旧 session；
- 两个公共 Worker 使用不同 credential，不能共用同一 Worker ID；
- 容器停止后，session 租约过期，注册本身仍保留；
- 删除或撤销 Worker 前，先确认对应容器已停止；
- 公共 Worker 只能被超级用户恢复、轮换和撤销；
- 结果仍按现有 Artifact/验证链路上传，公共 Worker 不拥有发布验证权限。

## 5. 发布顺序

在 `cloudflare-deploy` 分支依次执行：

```sh
cd frontend
CLOUDFLARE_EXPORT=1 npm run build

cd ../cloudflare-worker
npm run check
npm test
npx wrangler d1 migrations apply infinity-agents-db --remote
npx wrangler deploy
```

线上迁移完成后，再从超级用户页面创建两个公共注册并启动两个容器。不要在
迁移前启动依赖新 `worker_kind`、`pool_id` 或 `dispatch_policy` 字段的 Worker。
