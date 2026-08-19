# Cloudflare 部署执行手册

本文件是 `cloudflare-deploy` 分支的操作手册；架构取舍和阶段门槛以
[`CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md`](./CLOUDFLARE_REMOTE_DEPLOYMENT_PLAN.md)
为准。主线 `main` 不包含 Cloudflare Worker 的发布产物和生产绑定。

## 发布边界

- 公网入口只有 `https://infinity.zhangyvjing.com`。
- Worker 名称固定为 `infinity-agents-edge`，不创建或覆盖其他 Worker。
- `frontend/out` 是静态资源；`cloudflare-worker/src/index.ts` 是动态入口。
- Infinity Agents 的浏览器产品使用 Analysis/Coding 命名；ImageJudge 继续使用
  独立的 `/image-judge/*` 命名空间、D1、KV 和 Durable Object。
- D1 是任务事实源，R2 保存资源和隔离中的 Artifact；Redis 不作为 Cloudflare
  binding。用户自有 Docker Worker 可以通过本地配置访问现有远程 Redis。
- 任务中心提供直接创建任务卡，使用与 Agent confirmation 卡相同的
  TaskSpec/Task 上传与幂等路径，并将 `agent_confirmation=false`；Analysis
  对话中的 confirmation 卡仍保留为聊天入口。
- Worker 注册卡默认折叠，只填写 Namespace。Namespace 可以被同一用户的多台
  Worker 复用；每台 Worker ID 和长期凭证由服务端生成并写入 D1（只存凭证摘要）。
  只有 superuser 映射到 `owner_trusted`，普通用户和学生映射到
  `institution_trusted`。每个 Worker 凭证同时只能占用一个反向握手会话。
- 公共执行池固定为 `public-default` / `infinity-public`，由超级用户页面创建
  可按需创建的独立持久 Worker；任务采用“创建者自有 Worker 优先，公共 Worker 回退”。
  Docker 执行实例在 Cloudflare Edge 外部运行，Edge 只提供控制面。
- 公共池的两 Worker 配置和验收步骤见 [`CLOUDFLARE_PUBLIC_WORKER_POOL.md`](./CLOUDFLARE_PUBLIC_WORKER_POOL.md)。

## 每次发布

```sh
git switch cloudflare-deploy
git pull --ff-only origin cloudflare-deploy

cd frontend
npm ci
CLOUDFLARE_EXPORT=1 npm run build

cd ../cloudflare-worker
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply infinity-agents-db --remote
npx wrangler d1 migrations apply image-judge-db --remote
npx wrangler deploy
```

`wrangler deploy --dry-run` 必须先显示预期的 `infinity-agents-edge`、两个
D1、ImageJudge 的 KV/DO、R2 和 Assets 绑定；若出现其他 Worker 名称、未知
数据库、公开 Redis/Queue/Provider binding，应停止发布并修正配置。

## Secret 与权限

Secret 通过 Wrangler 交互式输入，不写入代码、`.env`、前端变量或日志：

```sh
npx wrangler secret put STEPFUN_API_KEY
npx wrangler secret put ZHANG_AUTH_CLIENT_SECRET
npx wrangler secret put WORKER_CREDENTIAL_ENCRYPTION_KEY
npx wrangler secret put IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET
npx wrangler secret put IMAGE_JUDGE_TOKEN_SIGNING_SECRET
npx wrangler secret put IMAGE_JUDGE_DASHSCOPE_API_KEY
```

公共 Worker 管理权限只根据服务端验证出的 Zhang Auth superuser 角色判断，
不从浏览器字段或可配置的用户 ID 列表推导。当前不部署 verifier；执行 Worker
只能发布自己持有有效租约、fencing epoch、checksum 和 manifest 绑定的 Artifact，
控制面在同一 D1 batch 中将 Task、Attempt 和 Artifact 原子地标记为 succeeded/published。

## 发布后验收

```sh
curl -fsS https://infinity.zhangyvjing.com/health
curl -fsS https://infinity.zhangyvjing.com/image-judge/healthz
curl -fsSI https://infinity.zhangyvjing.com/
curl -fsSI https://infinity.zhangyvjing.com/code-agent/
curl -fsSI https://infinity.zhangyvjing.com/code-agent/tasks/
curl -fsSI https://infinity.zhangyvjing.com/image-judge/
```

还要确认：

1. `/auth/login?return_to=/code-agent` 返回 OIDC 302，使用 PKCE，Cookie 为
   HttpOnly；不打印 state、nonce、code 或 verifier。
2. 未登录的 `POST /api/chat`、ImageJudge evaluate 和 Worker poll 都返回
   401；Worker 认证响应带 `WWW-Authenticate: Bearer`。
3. 首页可见 `Analysis`、`任务执行中心`、`Image Judge`，不再出现旧的
   `PaperAgent` 标签或旧的“发送给 PaperAgent”文案。
4. 新 Worker 注册只提交 Namespace；持久 credential 原文不落盘到 D1，之后由
   中央 PostgreSQL/Redis Worker 协议验证生命周期。同一 Namespace 下应能创建
   任意多个不同 Worker ID；同一凭证的第二个活动实例必须返回
   `WORKER_ALREADY_CONNECTED`。旧 `/api/worker/v1/*` 只做 410 兼容回归。
5. 超级用户公共 Worker 卡每次点击“创建”都能新增一个注册，没有两台上限；普通用户
   看不到公共 Worker ID、credential 或其他用户任务。用户 Worker 空闲时优先
   领取自己的任务，忙碌/离线时公共 Worker 才能回退领取。
6. `ss -ltn` 在 `zhangbot` 上只允许 Redis loopback 监听；Cloudflare Worker
   源码和构建产物不得出现 Redis/Docker/6379 直连能力。

## macOS / Windows Worker 加入

目标机器运行统一 Docker Worker 镜像，不再运行 Cloudflare Edge 的旧
HTTPS poll 客户端。超级管理员提供 PostgreSQL、Redis、中央 API、Namespace、
Worker ID、持久 credential 和本地 Provider 配置；普通用户不能自行填写这些
中心地址或全局密钥。

```sh
export WORKER_IMAGE='infinity-agent-worker@sha256:<已核验 digest>'
export WORKER_ID='<服务器签发的 Worker ID>'
export WORKER_CREDENTIAL='<服务器签发的持久 credential>'
export WORKER_DATABASE_URL='<管理员提供的 TLS PostgreSQL URL>'
export WORKER_REDIS_URL='<管理员提供的 Redis URL>'
export REDIS_NAMESPACE='<管理员提供的 Namespace>'
docker compose -f docker-compose.cloudflare-workers.yml up -d worker-b
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

Windows 使用 Docker Desktop 和同一 Compose 文件，将这些变量放入只允许
Worker 服务账号读取的本地 env 文件；不安装 Wrangler，不配置 Cloudflare
account/API token，不运行旧的 Node HTTPS 控制客户端。Provider key、Base URL
和 Model 只留在本机 Worker env 中。

## Redis 与后续 Relay

`zhangbot` 上的 Redis 继续由本机用户级 systemd 服务运行，使用 loopback、
ACL、AOF、内存上限和 `noeviction`。Cloudflare D1 Worker 不直接绑定 Redis；
用户自有 Docker Worker 只在本地使用已配置的安全 Redis 地址做健康检查和任务
运行配套。Relay 不能提供 raw Redis command、任务事实、用户身份或 Provider
secret。
