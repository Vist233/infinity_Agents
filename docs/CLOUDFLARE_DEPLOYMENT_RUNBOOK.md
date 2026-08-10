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

## 每次发布

```sh
git switch cloudflare-deploy
git pull --ff-only origin cloudflare-deploy

cd frontend
npm ci
npm run build

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
npx wrangler secret put WORKER_ENROLLMENT_ADMIN_USER_IDS
npx wrangler secret put IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET
npx wrangler secret put IMAGE_JUDGE_TOKEN_SIGNING_SECRET
npx wrangler secret put IMAGE_JUDGE_DASHSCOPE_API_KEY
```

`WORKER_ENROLLMENT_ADMIN_USER_IDS` 只能填写明确批准的 Zhang Auth `sub`，不
能按“最近登录用户”或用户数量猜测。`WORKER_VERIFIER_TOKEN` 只配置在独立
验证器已启动的情况下；执行 Worker 不会收到这个 Secret，只能把结果放入
R2 quarantine，验证器校验后才提升为用户可见的 `published` Artifact。验证器
未运行时，不应把执行 Worker 直接配置成发布者。

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
4. 新 Worker 注册只提交 Namespace；持久 credential 原文不落盘到 D1，之后用
   `connect`、`heartbeat`、`health`、`poll` 和 revoke 验证生命周期。同一
   Namespace 下应能创建第二个不同 Worker ID；同一凭证的第二个活动实例必须
   返回 `WORKER_ALREADY_CONNECTED`；旧版一次性 enrollment 仅做兼容回归。
5. `ss -ltn` 在 `zhangbot` 上只允许 Redis loopback 监听；Cloudflare Worker
   源码和构建产物不得出现 Redis/Docker/6379 直连能力。

## macOS / Windows Worker 加入

由已登录用户在任务中心的“添加 Worker”卡创建持久注册，然后在目标机器运行：

```sh
cd cloudflare-worker
export INFINITY_WORKER_CREDENTIAL='任务中心返回的持久凭证'
node worker-client.mjs configure \
  --control-url https://infinity.zhangyvjing.com \
  --worker-id '<任务中心返回的 Worker ID>' \
  --namespace '<任务中心填写的 Namespace>'
node worker-client.mjs connect
node worker-client.mjs health
node worker-client.mjs poll
```

Windows 使用同一 Node 18+ 客户端和 HTTPS 控制面，把配置文件 ACL 限定给
Worker 服务账号；不安装 Wrangler，不配置 Cloudflare account/API token。若
运行本地 Docker Worker，则在本地配置文件中增加远程 `REDIS_URL`、Provider
key、Base URL 和 Model，不把这些值上传到 Cloudflare。

## Redis 与后续 Relay

`zhangbot` 上的 Redis 继续由本机用户级 systemd 服务运行，使用 loopback、
ACL、AOF、内存上限和 `noeviction`。Cloudflare D1 Worker 不直接绑定 Redis；
用户自有 Docker Worker 只在本地使用已配置的安全 Redis 地址做健康检查和任务
运行配套。Relay 不能提供 raw Redis command、任务事实、用户身份或 Provider
secret。
