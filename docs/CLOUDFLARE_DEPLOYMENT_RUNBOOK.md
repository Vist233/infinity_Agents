# Cloudflare 部署执行手册

本文件是`cloudflare-deploy`分支的操作手册；当前架构和阶段门槛以
[`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`](./ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)
和[`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`](./D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md)
为准。主线`main`不包含Cloudflare Worker的发布产物和生产绑定。

## 发布边界

- 公网入口只有 `https://infinity.zhangyvjing.com`。
- Worker 名称固定为 `infinity-agents-edge`，不创建或覆盖其他 Worker。
- `frontend/out` 是静态资源；`cloudflare-worker/src/index.ts` 是动态入口。
- Infinity Agents 的浏览器产品使用 Analysis/Coding 命名；ImageJudge 继续使用
  独立的 `/image-judge/*` 命名空间、D1、KV 和 Durable Object。
- Cloudflare D1是Task/Attempt/Worker/Event/Outbox/Artifact metadata唯一事实源；R2保存
  Method、Dataset和Artifact文件；ssh zhangbot Redis只负责可重建hint、presence和实时事件。
  Docker Worker通过持久credential调用Cloudflare Worker HTTPS API访问D1/R2。
- 任务中心提供直接创建任务卡，使用与 Agent confirmation 卡相同的
  TaskSpec/Task 上传与幂等路径，并将 `agent_confirmation=false`；Analysis
  对话中的 confirmation 卡仍保留为聊天入口。
- Worker 注册卡默认折叠；Namespace、Pool、数据库、Redis、Provider 和公网地址均由
  超级管理员冻结。每次创建由服务端生成新的 Worker ID 和持久 credential，并保证同一
  credential 同时只能占用一个活动握手会话。所有 Worker 使用同一公共执行策略，不存在
  `general/full` 或 `trusted/student` 执行等级。
- 公共执行池固定为 `public-default` / `infinity-public`，可按需创建任意数量的独立持久
  Worker；普通用户只能触发服务器签发 credential 和查看该 Worker 状态，不能修改集群
  配置。Docker 执行实例在 Cloudflare Edge 外部运行，Edge 只提供控制面。
- 当前D1旧任务/注册实现仍包含trust分级，新的Worker v2 API和zhangbot Redis Relay尚未
  完成。因此发布步骤保持阻断；旧PostgreSQL Case 2/3只证明Docker/Claude Runtime可复用，
  不等于D1目标通过。
- 公共池的两 Worker 配置和验收步骤见 [`CLOUDFLARE_PUBLIC_WORKER_POOL.md`](./CLOUDFLARE_PUBLIC_WORKER_POOL.md)。

## 每次发布

```sh
# 当前门禁：D1 canonical schema、Worker v2 API、zhangbot Redis Relay和D1/R2/Redis
# Case 2/3尚未完成时，不执行以下部署命令。
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
控制面使用D1条件更新和batch验证当前Attempt、lease、fencing和R2对象后发布Artifact。

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
4. 新Worker注册不让普通用户提交Namespace或基础设施字段；服务端使用固定
   `infinity-public`/`public-default`生成Worker ID和持久credential。同一Namespace下应能创建
   任意多个不同 Worker ID；同一凭证的第二个活动实例必须返回
   `WORKER_ALREADY_CONNECTED`。旧`/api/worker/v1/*`只做410兼容回归，执行只走v2。
5. 普通用户可触发签发任意数量Worker并查看自己触发签发的状态，但不能查看其他credential
   明文。全部兼容Worker进入同一公共Pool并可领取任何用户Task；浏览器用户仍只能查看自己的Task。
6. `ss -ltn` 在 `zhangbot` 上只允许 Redis loopback 监听；Cloudflare Worker
   源码和构建产物不得出现 Redis/Docker/6379 直连能力。

## macOS / Windows Worker 加入

目标机器运行统一Docker Worker镜像。超级管理员提供Redis、Cloudflare Worker API、Namespace、
Worker ID、持久 credential 和本地 Provider 配置；普通用户不能自行填写这些
中心地址或全局密钥。

```sh
export WORKER_IMAGE='infinity-agent-worker@sha256:<已核验 digest>'
export WORKER_ID='<服务器签发的 Worker ID>'
export WORKER_CREDENTIAL='<服务器签发的持久 credential>'
export WORKER_CONTROL_BASE_URL='https://infinity.zhangyvjing.com/api/worker/v2'
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

`zhangbot`上的Redis继续由本机用户级systemd服务运行，使用ACL、AOF、内存上限和
`noeviction`。Cloudflare Worker不能直接使用普通TCP Redis，因此只通过受认证的最小HTTPS
Relay把D1 Outbox的opaque hint幂等写入Redis。Docker Worker使用窄ACL消费Stream并写
presence。Relay不能提供raw Redis command、任务事实、用户身份、Method/Dataset、
Artifact或Provider secret。
