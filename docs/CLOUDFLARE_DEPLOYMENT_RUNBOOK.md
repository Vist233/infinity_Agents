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
  binding，也不接受浏览器或学生 Worker 的连接。
- 创建任务不是固定页面表单：Analysis 的 `request_task_creation` 工具发出
  短期 confirmation，前端把卡片挂在对应消息下；用户提交后再以同一
  confirmation 的幂等键创建 queued Task，并恢复 Agent 的后续回复。

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
能按“最近登录用户”或用户数量猜测。`WORKER_VERIFIER_TOKEN` 在独立验证器
上线前保持未配置；这样 Worker 只能把结果放入 R2 quarantine，不能自行把
结果提升为用户可见的 `published` Artifact。

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
3. 首页可见 `Analysis`、`任务执行中心`、`性状提取`，不再出现旧的
   `PaperAgent` 标签或旧的“发送给 PaperAgent”文案。
4. 错误 enrollment token 不落盘；真实 enrollment 只允许一次，之后用
   `health`、`poll`、revoke 和 replay rejection 验证完整生命周期。
5. `ss -ltn` 在 `zhangbot` 上只允许 Redis loopback 监听；Cloudflare Worker
   源码和构建产物不得出现 Redis/Docker/6379 直连能力。

## macOS / Windows Worker 加入

由管理员在已登录的浏览器中创建短期一次性 enrollment token，然后在目标
机器运行：

```sh
cd cloudflare-worker
export WORKER_ENROLLMENT_TOKEN='一次性凭证'
node worker-client.mjs enroll --control-url https://infinity.zhangyvjing.com
node worker-client.mjs health
node worker-client.mjs poll
```

Windows 使用同一 Node 18+ 客户端和 HTTPS 控制面，把配置文件 ACL 限定给
Worker 服务账号；不安装 Wrangler，不配置 Cloudflare account/API token，
也不配置 D1、R2、Redis、Queue 或 Provider secret。客户端只保存可撤销的
opaque Worker credential 和本机私钥。

## Redis 与后续 Relay

`zhangbot` 上的 Redis 仅由本机用户级 systemd 服务运行，使用 loopback、
ACL、AOF、内存上限和 `noeviction`。当前 Cloudflare Worker 不直连 Redis。
只有在 Task Relay 和 Cloudflare Tunnel、Access service-auth、D1 outbox
重放/幂等验收都完成后，才允许接入 Redis hint；Relay 不能提供 raw Redis
command、任务事实、用户身份或 Provider secret。
