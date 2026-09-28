# Cloudflare Deploy：前端单独托管迁移设计与执行计划

> 状态：本 worktree 已完成前端收口与仓库侧 Worker 发布停用，待审阅；本文件只记录盘点结果、边界和迁移顺序，不表示已经部署或删除线上资源。
> 盘点基线：`cloudflare-deploy` HEAD `6932165`（`ci: consolidate checks and disable package workflows`）。

## 1. 目标与不可混淆的边界

目标产品只暴露三个一级区域：

1. 任务执行；
2. 论文检查与查看；
3. Trait Agent（已确认就是当前 ImageJudge 页面，保留其入口和下载按钮）。

Paper Chat / Analysis 对话条、对话入口和对应前端体验下线。任务执行和论文检查/查看的数据、执行全部在用户本地；云端静态站点只部署一个前端，不再把 Cloudflare Worker 当作静态站点的 API/认证/数据层。

“只部署前端”不等于“功能可以只在浏览器完成”。任务创建和结果下载需要服务端状态、文件存储、鉴权和执行 Worker；论文解析需要 PDF Processor、对象存储和结构化结果存储；Trait Agent 需要模型代理或明确的用户自带密钥方案。当前仓库没有一个已经同时满足三者、且不依赖 Cloudflare Worker 的统一公网 API，因此在后端位置和认证/CORS 合同确认前，不能声称已有可工作的纯前端线上架构。

## 2. 当前实现盘点（可复核路径）

### 2.1 页面、导航和请求

| 产品区域 | 当前页面/入口 | 当前浏览器请求 | 当前真实服务位置 |
| --- | --- | --- | --- |
| Analysis / Paper Chat | Legacy source remains for audit; no public route imports `ChatWorkspace` | No requests from the current public routes | Historical `cloudflare-worker/src/index.ts` routes remain outside the static product |
| 任务执行 | `frontend/app/task-center/page.tsx` → `frontend/app/code-agent/page.tsx` | `/api/me`、项目/方法/数据上传、`/api/task*`、`/api/artifacts/*`、Worker 管理接口 | `cloudflare-worker/src/tasks.ts`；D1 + R2；`backend/code_agent/worker/consumer_v2.py` 执行容器和 Redis Relay |
| 论文检查与查看 | `frontend/app/papers/page.tsx`、`frontend/app/papers/[paperId]/page.tsx` | `/api/discovery/papers*` | `cloudflare-worker/src/discovery.ts`；D1/R2；`backend/discovery/` 和 `backend/Dockerfile.discovery-processor` |
| Data Collections（旧入口） | `frontend/app/data-collections/*` | No current data request; list/detail URLs redirect to `/papers/` | Historical Discovery capability; not a cloud product area in this worktree |
| Trait Agent / ImageJudge | `frontend/app/image-judge/page.tsx` | 当前页面提供静态示例和 GitHub 下载链接；已确认它就是保留的 Trait Agent 入口 | 当前网页仍不是在线推理客户端；桌面客户端走 `image-judge/apps/worker` 或主 Edge 的 `/image-judge/api/v1/evaluate`，本地算法/Agent 在 `agent/traitAgent.py` 和 `image-judge/apps/desktop/` |

当前 `frontend/lib/runtime-config.ts` 在本地构建中默认使用相对 API 路径；静态构建将 `NEXT_PUBLIC_STATIC_FRONTEND=1` 注入，并在没有显式 HTTPS API origin 时阻止这些业务请求。静态托管不再依赖 Cloudflare Edge 的同源 `/auth/*` 或 `/api/*`。

### 2.2 当前 Cloudflare 部署路径

- `cloudflare-worker/wrangler.jsonc` 和 `image-judge/apps/worker/wrangler.jsonc` 仍保留历史绑定，标注为回滚/审计配置；它们不是当前静态前端的发布目标。
- `cloudflare-worker/src/index.ts` 及其历史路由仍在仓库中，但当前静态产品不加载它们；本次未删除线上 Worker、D1、R2、KV、Durable Object 或 secrets。
- 两个 Worker package 的默认 `deploy` npm script 已移除，避免把本次静态前端工作误当成 Worker 发布。
- `cloudflare-worker/migrations-infinity/*` 是历史 Infinity Edge D1 迁移；`cloudflare-worker/migrations/*` 是历史 ImageJudge 相关 D1 迁移。
- `docker-compose.cloudflare-workers.yml` 中的 `worker-b` 是调用 Cloudflare Edge 的 Docker 执行 Worker，不是 Cloudflare Worker 本身；任务执行替代方案确定前不能误删。
- 当前 `.github/workflows/python-checks.yml` 的 `Code Checks` 已包含前端 lint/typecheck/unit/build/E2E 和 Python 检查；本迁移不恢复已禁用的镜像/打包工作流，也不新增部署动作。

## 3. 纯前端仍需的服务合同

### 3.1 推荐的目标拓扑（本地业务运行时 + 云端静态入口）

```text
云端静态前端（Pages/CDN/对象存储等任一静态托管）
       ├── 任务执行入口说明 ───────┐
       ├── 论文检查/查看入口说明 ───┼─> 用户本地应用/本地 API + 本地数据库/文件 + 本地执行器
       └── Trait Agent 页面/下载按钮   │
                                     └─> GitHub Release 的现有 ImageJudge 桌面资产
```

这次澄清后，云端页面不应默认尝试从 `https://infinity...` 跨源访问用户电脑上的 `http://localhost`。HTTPS 页面访问本机 HTTP 服务会受到 mixed-content / Local Network Access 约束；即使浏览器允许 loopback 请求，也仍然是跨源请求，当前前端的 cookie + `credentials: include` + CSRF 合同还要求本地服务配置精确 CORS、凭证和预检响应。MDN 对 [mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)、[Local Network Access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) 和 [credentialed CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) 的约束均适用于这条链路。

因此云端 Task/Papers 页面在没有明确的 HTTPS API origin 时只显示“请启动并打开本地应用”的说明，不显示假数据、不轮询云端同源 `/api/*`，也不宣称已经完成本地任务。若以后提供稳定的外部 API，可通过显式构建配置接入，但 `NEXT_PUBLIC_API_BASE` 只能解决“请求发往哪个 origin”，不能自动提供 API、认证、CORS、文件存储或异步处理。

### 3.2 三个保留区域的后端最低位置

**任务执行**：本地应用/本地 API 至少要提供与 `frontend/lib/api/tasks.ts` 相容的鉴权和接口：项目、方法上传、Dataset 上传、Task 创建/列表/详情/事件/重试/取消、Artifact 下载；还要有本地 PostgreSQL/等价事实库、对象存储和执行 Worker。当前 FastAPI 有一部分 `/api/tasks*`，但它没有被证明与 Cloudflare 版的 `/api/tasks/direct`、资源合同和前端全部响应字段兼容；它属于正在进行的本地移植候选，不能在本 worktree 中代替 main 的迁移结果。

**论文检查与查看**：本地应用/本地 API 至少要有 `frontend/lib/api/discovery.ts` 对应的论文上传、列表、详情、删除和状态/结构化 Profile 接口，并保留 PDF magic-byte/大小/用户归属检查、文件存储和异步 Processor。当前本地 FastAPI 的会话论文接口（`/api/sessions/{id}/uploads/papers`）属于旧 Paper Chat 合同，不等价于 `/api/discovery/papers*`；如果本地移植尚未提供 Discovery 合同，云端静态页面只能提供本地应用说明。

**Trait Agent**：已确认保留当前 ImageJudge 页面和下载入口，不把静态示例误报成网页在线推理。当前 `frontend/app/image-judge/page.tsx` 没有真实推理请求；`agent/traitAgent.py` 是本地 Python Agent；`image-judge/apps/worker` 是独立 Cloudflare 模型代理且面向桌面客户端。后续若要把 Trait Agent 做成网页推理，仍需另行确认本地/外部 API、输入/输出 schema、鉴权、配额、图片大小与隐私边界。

### 3.3 已确认与仍待确认

已确认：

1. Trait Agent 就是当前 ImageJudge 页面；保留入口和下载按钮。
2. 任务执行、论文检查/查看的数据和执行在用户本地，不在 Cloudflare 运行。
3. ImageJudge 下载按钮指向现有 GitHub Release；本地不再承担打包。
4. 本地入口默认指向 `http://localhost:3000/task-center/`，可用 `NEXT_PUBLIC_LOCAL_APP_URL` 覆盖。

仍待确认/需要实现：

1. 任务与论文本地 API 是否完全采用 `frontend/lib/api/tasks.ts`、`frontend/lib/api/discovery.ts` 的现有响应合同。

## 4. Cloudflare Worker 停用与后续删除清单

### 本次已停用

- `cloudflare-worker/package.json` 和 `image-judge/apps/worker/package.json` 不再提供默认 `deploy` script。
- `cloudflare-worker/README.md` 与 `docs/CLOUDFLARE_DEPLOYMENT_RUNBOOK.md` 已改为静态前端/回滚说明，不再给出 Worker 发布步骤。
- `wrangler.jsonc` 文件保留为可恢复配置，但明确标注为历史配置；本 worktree 未运行 Wrangler、远程迁移、secret/DNS/route 变更。

### 后续经授权才可删除的历史代码与资源

- `cloudflare-worker/src/index.ts` 及其 Edge 路由/绑定实现：`auth.ts`、`chat.ts`、`sessions.ts`、`tasks.ts`、`discovery*.ts`、`paper*.ts`、`worker-v2.ts`、`outbox-relay.ts`、`lease-recovery.ts`、`settings.ts`、`image-judge.ts` 和相关支持模块。
- `cloudflare-worker/wrangler.jsonc`、`cloudflare-worker/package*.json`、`cloudflare-worker/tsconfig.json`、`vitest.config.ts`、`test/*`。
- `cloudflare-worker/migrations/*` 与 `migrations-infinity/*`，但只在确认没有其他线上消费者且完成数据/回滚留存后处理。
- `image-judge/apps/worker/*` 及其 Wrangler/D1/KV/DO 配置：Trait Agent 已确认是 ImageJudge，但当前页面只提供桌面下载；只有在桌面客户端改用本地/其他模型服务、且不再需要云端模型代理后才处理。当前阶段保留 GitHub Release 资产和下载按钮，不删除线上发布物。
- `worker.cloudflare.env.example`、`scripts/run_local_cloudflare_workers.sh`、根 README、`frontend/README.md`、`HANDOFF.md` 和 Cloudflare runbook 中指向 Edge API/部署的段落；改为真实的新 API/静态托管说明。

### 不应随 Edge 一起误删的组件

- `backend/code_agent/worker/*`、`backend/Dockerfile.worker` 和任务执行协议：它们是执行任务的 Docker Worker，除非新任务后端明确替代。
- `backend/paper_processor/*`、`backend/discovery/*` 和对应 Docker Processor：它们是外部后端处理器候选，不是 Cloudflare Worker；只有在新论文服务完成接管后再清理。
- `.github/workflows/python-checks.yml`：保留已合并的 `Code Checks`，不恢复镜像/打包工作流。

线上 D1、R2、KV、Durable Object、Worker、DNS/路由和 secrets 在本计划阶段均不删除、不变更、不部署。

## 5. 执行顺序

1. **冻结本地入口合同**：记录本地应用的启动方式、默认地址和 Task/Paper API 合同；云端页面先只做本地说明，不假设 HTTPS 页面能访问 localhost。
2. **前端收口（本次完成）**：根路径不再进入 ChatWorkspace；导航仅显示任务、论文和 ImageJudge/Trait Agent；Data Collections 和独立 Downloads 深链回到受支持区域。任务/论文在云端 origin 且没有显式 API 时展示本地运行时说明。
3. **本地 API 适配层**：让本地应用实现 `tasks.ts` 和 `discovery.ts` 所需合同；若将来选择外部 HTTPS API，再单独验证 CORS/CSRF、上传/下载、分页和异步状态。
4. **本地后端先行迁移**：先完成任务 → 论文的纯本地 PostgreSQL/文件/执行器闭环；用合成数据验证用户隔离、对象权限、失败/重试/取消和结果校验。不要把本地处理器伪装成静态前端能力。
5. **云端只验证入口（本次完成）**：验证三个页面能清楚说明本地运行边界；验证 ImageJudge 下载按钮指向现有 Release 资产。任务/Paper 的真实闭环在本机应用中验收，不在云端静态页面上伪造成功。
6. **历史 Chat 合同清理（后续授权项）**：本次已删除不再被公共路由引用的 ChatWorkspace、Composer、SessionList、消息面板和 Paper Chat confirmation UI；仍未被本次产品收口要求删除的旧 hooks/API/测试与服务路由保留作迁移审计材料。后续若要清理这些合同，需先确认没有其他客户端流量，再单独删除/停用并验证请求日志。
7. **Cloudflare 发布停用（本次完成仓库侧）**：移除默认 Worker deploy scripts，保留可恢复配置；线上 Worker、域名、路由和资源未切换或删除，后续清理仍需单独授权。

## 6. 验证、回退与当前可验收范围

### 当前本 worktree 可做的验证

- 前端 `npm run lint`、`npm run typecheck`、`npm run test:unit`、`npm run build`；另用 `CLOUDFLARE_EXPORT=1 npm run build` 检查静态产物。
- 静态产物/源代码检查：`/` 不再导入 ChatWorkspace，导航只有三个按钮，且没有 Analysis/Data Collections 一级按钮；在云端 origin 没有显式 API 时，Task/Papers 页面只展示本地应用说明，不发同源 `/api/*` 轮询；检查无意外 `/api/chat` 请求。
- 入口检查：`/data-collections` 和 `/downloads` 在静态产物中是 HTML redirect，分别进入 `/papers/` 和 `/image-judge/`；本地提示默认提供 `http://localhost:3000/task-center/` 按钮，可由 `NEXT_PUBLIC_LOCAL_APP_URL` 覆盖。
- Release 链接检查：当前 GitHub latest release 为 [`imagejudge-v0.2.0`](https://github.com/Vist233/infinity_Agents/releases/tag/imagejudge-v0.2.0)，已核对其提供 `ImageJudge-windows-x64.zip` 和 `ImageJudge_0.2.0_amd64.deb`；当前没有 macOS 资产，因此不保留一个会返回 404 的 macOS 直链。
- 现有 `Code Checks` 工作流保持不变。

### 后端就绪后的验收

- 未登录访问只得到明确的登录/401，不因跨域失败而无限 loading。
- 本地 Task：上传方法和 Dataset、创建 direct task、轮询/事件、重试/取消、Artifact 下载；用户 A 不能读用户 B 的任务/论文/图片。
- 本地 Paper：上传合法/伪造 PDF、处理状态、Profile/证据渲染、失败重试和删除；大文件和对象权限按限制验证。
- Trait/ImageJudge：验证下载资产、桌面端本地运行和已有模型代理/本地 BYOK 的边界；不在浏览器或日志暴露模型密钥。
- 静态托管下的 API origin、Cookie/SameSite 或 bearer、CORS、CSRF、缓存和 `Content-Disposition` 均实测。

### 回退

切换前保留旧静态资产、旧 Edge Worker 的最后可用 Git SHA、Wrangler 配置和数据备份；若新 API 或任一核心闭环失败，把域名/静态入口切回旧资产与旧 API 路径即可。不要通过手工改任务状态或删除 D1/R2 数据制造“通过”。

## 7. 本次变更的边界

本 worktree 完成第 5 步骤 2、仓库侧 Worker 发布停用、显式本地运行时提示和已核对的 Release 链接更新；不部署、不推送、不删除线上资源，不修改 main worktree，也不把云端静态页面宣称为能够直接执行本地任务/论文处理。
