# Infinity Agents Cloudflare 交接

> 最后更新：2026-08-10
> 当前分支：cloudflare-deploy
> 当前代码提交：f2c98fb complete worker artifact verification and downloads
> 生产 Worker：infinity-agents-edge
> 生产入口：https://infinity.zhangyvjing.com

这份文档是当前 Cloudflare 版本的操作交接，不是旧 FastAPI/PostgreSQL 本地版本的交接。完整组件职责和数据流见
[docs/CLOUDFLARE_WORKER_ARCHITECTURE.md](docs/CLOUDFLARE_WORKER_ARCHITECTURE.md)。

## 0. 本轮范围

本轮按最新要求处理：

- 不启动浏览器验收 Subagent。
- 不启动代码审查 Subagent。
- 只由主 Agent 做全局静态检查、线上只读检查和本地运行状态核对。
- 交接文档记录当前真实实现，不把一次性验收写成部署前置条件。

需要区分两个概念：本轮省略的是验收 Subagent；当前代码里已有的 Artifact 完整性发布边界仍然存在。执行 Worker 先把结果放进 R2 quarantine，当前分支的独立结果发布服务检查 ZIP 的大小、SHA-256、CRC、路径和符号链接后，再将 Artifact 发布为网页可下载的 published 状态。它不是对话 Agent，也不是本轮新增的验收工作。

## 1. 当前状态

| 项目 | 当前状态 |
|---|---|
| Cloudflare Worker | infinity-agents-edge，线上健康 |
| 最新线上版本 | fdd9f34a-5d58-40eb-94fc-2bd422d7b2cb |
| D1 | infinity-agents-db，ID 9ee9ec94-cb42-40b5-8372-681c7b57c105 |
| R2 | infinity-agents-resources |
| 本地执行 Worker | worker-a、worker-b 两个容器 |
| 本地结果发布服务 | 当前 Compose 中的 verifier 容器 |
| Redis | 继续使用 zhangbot 上的现有 Redis；不启动新的 Redis 容器 |
| Docker 边界 | Worker 容器不挂载宿主机 Docker socket，不在容器中启动 Docker |
| Provider | Claude Code 直接在 Worker 容器中执行，配置来自本机环境变量 |
| 主工作树 | /Users/zhangyvjing/Code/infinity_Agents 有用户未提交修改，不要用破坏性命令覆盖 |

线上只读检查结果：

- /health 返回 status=ok，service=infinity-agents-edge。
- /image-judge/healthz 返回 ok=true。
- /code-agent/ 返回 HTTP 200。
- D1 中 Case 2：succeeded，Artifact published，大小 37,325 字节。
- D1 中 Case 3：succeeded，Artifact published，大小 32,218,769 字节；该大小走 R2 Multipart 上传路径。
- 当前本地容器只挂载各自的输入/输出 named volume，没有 /var/run/docker.sock。

## 2. 系统边界

| 组件 | 负责什么 | 不负责什么 |
|---|---|---|
| 浏览器 | OIDC 登录、Analysis 对话、Task Center、Image Judge 页面 | 不拿 D1/R2/Redis/Provider 主凭证 |
| Cloudflare Edge Worker | API、会话、任务状态、Worker 注册、D1/R2 读写 | 不直接连接 zhangbot Redis，不执行 Claude Code |
| D1 | 用户、任务、Attempt、Worker 注册、事件、Artifact 元数据 | 不保存 Artifact 二进制 |
| R2 | 执行文档、数据集、结果 ZIP | 不作为浏览器公开桶；下载必须经过鉴权 API |
| 本地 Docker Worker A/B | 连接控制面、领取任务、下载输入、执行 Claude Code、上传结果 | 不把 Provider/Redis 密钥上传到 Cloudflare |
| zhangbot Redis | 本地 Worker 的现有远程 Redis 依赖和健康检查 | 不被 Cloudflare Worker 当作公网 Binding |
| 结果发布服务 | 检查 quarantine ZIP 并将其发布为 published | 不执行 Claude Code，不拿 Worker 凭证，不拿 Redis/Provider 凭证 |

当前不采用的方式：

- 不使用一次性 Token 作为新 Worker 的长期连接凭证。
- 不把 D1 当成 PostgreSQL 直连地址。
- 不把 Redis 暴露给 Cloudflare Worker。
- 不在 Docker Worker 里再启动 Docker。
- 不依赖 WiFi 专用链路；控制面使用 HTTPS，Redis 由本机 SSH 端口转发访问。
- 不把任务结果长期保留在本地 Docker；上传完成后清理输入、输出和 ZIP 临时文件。

## 3. 用户和 Worker 身份模型

### 3.1 创建 Worker

登录用户在 Task Center 的添加 Worker 卡中只填写 Namespace：

1. 浏览器通过当前 OIDC 会话调用 POST /api/worker-enrollments。
2. Cloudflare 生成新的 worker_id 和长期 bearer credential。
3. D1 保存 credential 的 SHA-256 摘要，并保存加密副本。
4. 原始 credential 只在创建/重新生成时返回给当前用户。
5. 同一 Namespace 可以创建多个 Worker；每个 Worker 都有不同的 ID 和凭证。
6. 同一个凭证同时只能有一个活动的反向握手实例。

### 3.2 信任等级

信任等级从已验证的账号权限生成，不能由浏览器提交：

- superuser：owner_trusted。
- 普通用户和学生：institution_trusted。
- 代码中保留的 student_untrusted 仅是兼容分支，当前账号映射不会把普通学生降为该等级。

### 3.3 连接状态

长期 credential 不因机器暂时关闭而失效。机器启动后：

1. 使用 credential 调用 POST /api/worker/v1/connect。
2. D1 创建或更新该 Worker 的短期 session lease。
3. Worker 定期调用 heartbeat。
4. 停机后 session lease 过期，下一次启动重新握手即可。
5. 如果另一台机器误用同一个 credential，返回 WORKER_ALREADY_CONNECTED；应为另一台机器创建新的 Worker ID/credential。

## 4. 完整任务流程

### 4.1 创建任务

1. 用户在 Analysis 对话中提出任务，或在 Task Center 直接点击新建任务。
2. Analysis 入口可以通过确认卡继续对话，使用普通任务路径。
3. Task Center 是直接创建入口，使用 /api/tasks/direct，设置 agent_confirmation=false，不要求 Agent 再次确认。
4. 浏览器上传执行文档和数据集：
   - 执行文档进入 R2，并在 D1 写入 method source 元数据。
   - 数据集进入 R2，并在 D1 写入 dataset snapshot 元数据。
5. 浏览器创建并冻结 TaskSpec。
6. Cloudflare 在 D1 创建 queued 任务和幂等记录。
7. 任务详情和实时事件通过 D1/SSE 返回浏览器。

任务的核心区分是执行文档；数据集只是本次任务的输入，不在前端做“一次性打包后不可复用”的限制。

### 4.2 Worker 领取任务

1. Worker connect 建立反向握手。
2. Worker 发送 heartbeat，然后 poll。
3. Cloudflare 从 D1 找到属于该用户、可由该信任等级执行的 queued 任务。
4. Cloudflare 创建短期 offer。
5. Worker 调用 offers/:offer_id/accept。
6. Cloudflare 用 worker_id + namespace + fencing_epoch + lease 原子认领任务。
7. 旧 Worker 或过期 Attempt 后续回写会被 fencing 条件拒绝。

### 4.3 容器内执行

1. Worker 在自己的 named volume 创建任务目录。
2. Attempt heartbeat 在资源下载前建立并持续发送，避免大输入下载期间租约失效。
3. Worker 只通过 Attempt 专属 HTTPS URL 下载执行文档和数据集。
4. Worker 在同一个容器内直接调用 Claude Code CLI：
   - 使用本机传入的 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY。
   - 使用本机的 ANTHROPIC_BASE_URL 和 ANTHROPIC_MODEL。
   - 使用 Goal-Driven 执行文档完成任务。
   - 不调用宿主 Docker，不启动嵌套 Docker。
5. 任务输出写入本地临时输出目录。

### 4.4 结果上传

1. Worker 将输出目录打包成 task_id-artifacts.zip。
2. Worker 对完整 ZIP 计算 SHA-256。
3. 不超过 20 MB：走单请求上传。
4. 超过 20 MB：走 R2 Multipart，默认每片 8 MB；当前总大小上限为 2 GB。
5. Cloudflare 检查 Attempt fencing、文件大小、R2 对象头和 checksum。
6. Artifact 先记录为 quarantine，避免未完成/损坏对象被网页下载。

### 4.5 结果发布和下载

1. 当前结果发布服务从 verifier-only API 读取待发布 Artifact。
2. 它在自己的临时 volume 中下载 ZIP，检查文件大小、SHA-256、ZIP 可读性和 CRC、空包、重复成员、绝对路径、.. 路径和符号链接。
3. 检查通过后调用发布 API。
4. Cloudflare 在一个 D1 事务批次中将 Task 置为 succeeded，写入 result_artifact_id，将 Attempt 置为 succeeded，将 Artifact 置为 kind=result、status=published，并写入 task_succeeded 事件。
5. Task Center 收到终态事件后，读取 /api/tasks/:id/artifacts。
6. 用户点击 Download result，请求 /api/artifacts/:artifact_id。
7. Cloudflare 校验当前用户拥有该任务后，从 R2 流式返回 ZIP。
8. 发布服务清理自己的临时 ZIP；执行 Worker 清理本地输入、输出和归档文件。

## 5. 状态机

~~~text
Task:
queued
  -> claimed
  -> running
  -> running + artifact quarantine
  -> succeeded

Attempt:
claimed -> running -> succeeded
                    -> failed / expired / cancelled

Artifact:
uploading -> quarantine -> published
                    -> 保留为 quarantine，等待发布或故障处理
~~~

故障路径：

- Worker 心跳失败或容器退出：lease 过期后 D1 重新排队或将任务置为 timeout。
- Attempt fencing 失败：旧 Worker 不得继续上传、完成或回写状态。
- Claude Code 失败：Worker 调用 fail，由服务端决定失败记录和后续重试。
- Artifact 上传不完整：不能进入 published，网页不会显示下载链接。
- 结果发布服务暂时停止：任务保持中间状态；恢复后继续处理，不需要重新执行 Claude Code。
- R2/D1 不可用：API 返回明确错误，不把失败伪装成成功。

## 6. 本地 Mac 上启动两个 Worker

所有本地凭证文件只放在当前机器，建议权限为 600。不要提交 Git。

### 6.1 创建两个持久注册

在网页中重复两次：

1. 登录 https://infinity.zhangyvjing.com/code-agent/。
2. 展开添加 Worker。
3. 填同一个 Namespace，分别提交两次。
4. 记录两组不同的 Worker ID 和 credential。
5. 不要把 credential 发到聊天、截图或提交到仓库。

### 6.2 准备配置

~~~sh
cd /path/to/infinity_Agents
cp worker.cloudflare.env.example worker-a.cloudflare.env
cp worker.cloudflare.env.example worker-b.cloudflare.env
chmod 600 worker-a.cloudflare.env worker-b.cloudflare.env
~~~

分别填写 WORKER_ID、WORKER_NAMESPACE、WORKER_CREDENTIAL、WORKER_INSTANCE_ID 和 CONTROL_BASE_URL。A/B 的 instance id 必须不同。

不要在文件中复制陌生的 Claude Code 配置。启动脚本通过交互式 zsh 读取本机已有的 Provider 环境变量，并将原值传给两个容器。

### 6.3 启动

~~~sh
zsh -ic 'bash scripts/run_local_cloudflare_workers.sh'
~~~

脚本会：

1. 检查本机 SSH 隧道 16379 -> zhangbot:127.0.0.1:6379，没有时建立隧道。
2. 通过 SSH 读取 zhangbot 上现有 Redis 的两个 ACL 配置，不打印密码。
3. 给 A/B 生成分别带 ACL 的本地 Redis URL。
4. 删除同名旧容器后启动 worker-a 和 worker-b。
5. 如果当前目录有本机可读的 verifier.cloudflare.env，同时启动当前分支的结果发布服务。

查看状态：

~~~sh
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-a worker-b
~~~

确认 A/B 都 connected、各自只有输入/输出 named volume，并且没有 /var/run/docker.sock。新建任务后应出现 accepted、执行、上传和清理日志。

停止本地服务：

~~~sh
docker compose -f docker-compose.cloudflare-workers.yml stop worker-a worker-b verifier
~~~

停止不会撤销 D1 中的 Worker 注册；重新启动时使用相同 credential 即可重新握手。

## 7. 常用客户端操作

如果只需要测试连接，而不运行 Docker Worker，可使用 Node 18+ 客户端：

~~~sh
export INFINITY_WORKER_CREDENTIAL='从任务中心复制的持久 credential'
node cloudflare-worker/worker-client.mjs configure \
  --control-url https://infinity.zhangyvjing.com \
  --worker-id '<Worker ID>' \
  --namespace '<Namespace>'
node cloudflare-worker/worker-client.mjs connect
node cloudflare-worker/worker-client.mjs health
node cloudflare-worker/worker-client.mjs poll
~~~

客户端配置保存到用户目录下的 ~/.infinity-agents/worker.json，文件权限为用户可读写；不要将该文件提交。

## 8. Cloudflare 发布操作

在独立工作树中发布，避免覆盖主工作树中的用户修改：

~~~sh
git switch cloudflare-deploy
git pull --ff-only origin cloudflare-deploy

cd frontend
npm ci
npm run build

cd ../cloudflare-worker
npm ci
npm run check
npm test
npx wrangler d1 migrations apply infinity-agents-db --remote
npx wrangler d1 migrations apply image-judge-db --remote
npx wrangler deploy
~~~

发布前可做不改变线上状态的预检：

~~~sh
npx wrangler deploy --dry-run
~~~

生产 Secret 只通过 Wrangler 交互式配置；不写入代码、前端 bundle、.env 或 Git。任何 Secret 变更都要单独记录，不能把值写入本文件。

发布后只读检查：

~~~sh
curl -fsS https://infinity.zhangyvjing.com/health
curl -fsS https://infinity.zhangyvjing.com/image-judge/healthz
curl -fsSI https://infinity.zhangyvjing.com/code-agent/
~~~

D1 只读核对示例：

~~~sh
npx wrangler d1 execute infinity-agents-db --remote --command \
  "SELECT task_id, status, result_artifact_id FROM tasks ORDER BY created_at DESC LIMIT 10"
~~~

## 9. 测试与全局检查顺序

本轮不启动 Subagent；后续需要人工执行时，按下面顺序：

1. 静态检查：git diff --check、TypeScript check、Python import/pytest。
2. Compose 检查：只验证服务和变量，不把包含 Secret 的 docker compose config 输出到日志。
3. Cloudflare 健康端点。
4. 登录后检查 Analysis、Task Center、Image Judge 三个入口。
5. 创建一条小任务，观察 queued -> claimed -> running -> succeeded。
6. 检查 Artifact 列表和下载响应。
7. 再测大于 20 MB 的结果，确认 Multipart。
8. 最后检查本地 Worker 清理和容器是否按预期回收。

已完成的当前分支测试证据：

- Cloudflare Worker TypeScript check + Vitest：35 tests passed。
- 前端 typecheck + unit：30 tests passed，production build 成功。
- Python Cloudflare Worker/Claude runtime/Docker runtime targeted tests：6 passed。
- Case 2 和 Case 3 已在真实线上控制面完成，D1 状态为 succeeded，Artifact 为 published。
- 本次文档改动完成后仍需重新执行 git diff --check；文档改动不影响运行时代码。

## 10. 故障排查

### Worker 一直 WORKER_ALREADY_CONNECTED

同一个 credential 已有活动 session。停止旧机器或容器，等待 session lease 过期，再启动；不要复制同一 credential 到第二台机器。第二台机器应在 Task Center 新建一个 Worker 注册。

### Worker WORKER_SESSION_REQUIRED

Worker 尚未成功 connect，或本地配置中的 WORKER_ID、namespace、credential 不匹配。确认三者来自同一条 D1 注册记录。

### Redis 检查失败

确认 SSH 到 zhangbot 可用、Redis 仍监听 loopback、本机 16379 没有被其他进程占用。不要启动新的 Redis 容器覆盖现有服务。

### 任务一直 queued

依次检查 Worker 是否 connected 和持续 heartbeat、Worker 用户是否与任务创建者一致、Task 信任等级是否允许当前 Worker、Worker 是否因为 Redis 必需检查失败而退出，以及 poll 是否返回 offer。

### 任务处于中间状态但没有下载

当前分支需要结果发布服务把 quarantine Artifact 提升为 published。检查 verifier 容器日志、控制面 verifier token 配置和 R2 对象是否存在。不要重新执行任务或手工把 D1 状态改成 succeeded。

### 大文件上传失败

确认 ZIP 不超过 TASK_ARTIFACT_MAX_BYTES，Multipart parts 从 1 连续，非最后分片为 8 MB，R2 object head 大小等于预期，且 Worker 的 Attempt lease 在整个上传期间持续 heartbeat。

## 11. 相关文件

- docs/CLOUDFLARE_WORKER_ARCHITECTURE.md：组件、数据流、状态、边界和设计解释。
- docs/CLOUDFLARE_DEPLOYMENT_RUNBOOK.md：Cloudflare 发布手册。
- docs/WORKER_ONBOARDING.md：新机器加入清单。
- docker-compose.cloudflare-workers.yml：两个本地 Worker 和当前结果发布服务。
- scripts/run_local_cloudflare_workers.sh：SSH 隧道、Redis ACL 和本地启动入口。
- cloudflare-worker/src/worker-control.ts：Worker 控制面、租约、上传和发布 API。
- backend/code_agent/worker/cloudflare_worker.py：本地 Worker 主循环和 Claude Code 执行。
- backend/code_agent/verifier_service.py：当前分支的结果发布服务。
