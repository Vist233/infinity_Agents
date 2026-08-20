# Cloudflare 收口后 main 纯本地 PostgreSQL 实施计划

> 状态：`NOT_STARTED`。只有 `cloudflare-deploy` 的 C7 完成后才能执行。
> 来源：最终 Cloudflare 产品/UI/Worker合同，不以旧 `main` 或 `origin/main` 为实现基线。

## 1. 目标

将完成后的 Cloudflare 版本裁剪成一个可一键启动的纯本地版本并提交到 `main`：

```text
Browser / Next frontend
  -> local FastAPI application
  -> PostgreSQL (唯一 Task/Attempt/Worker/Event/Artifact metadata 事实源)
  -> local filesystem object store (Method/Dataset/Artifact 文件)
  -> local Redis (只做 hint/presence/realtime，可丢失重建)
  -> Docker Worker v2 -> Claude Code -> Artifact upload
```

本地版不是 Cloudflare 与 PostgreSQL 双模式，也不是把旧 PostgreSQL 代码重新启用。它继承最终
产品合同，重新实现唯一的本地数据面和控制面。

## 2. 进入条件

以下全部满足前不得切换或改写 `main`：

1. `cloudflare-deploy` C7 checkpoint 完成；
2. Cloudflare 最终线上版本、GHCR digest、rollback commit 和未完成风险已记录；
3. `cloudflare-deploy` 工作区干净并已推送；
4. Case 2 真实成功证据保留；Case 3 明确记录为 `DEFERRED_BY_OWNER`；
5. 为最终 Cloudflare commit 和改造前 `main` 建立可恢复标签/引用；
6. 只读盘点 `main`、`origin/main` 与最终 Cloudflare 树的差异。

当前 `main` 明显落后于 Cloudflare 产品树；`origin/main` 还包含恢复 Chat Agent 的提交。禁止盲目
merge `origin/main` 或把 Chat Agent、旧导航、旧 Worker协议带回产品。

## 3. 必须继承的产品合同

- 导航只有 Analysis、Task Center、ImageJudge；
- Task Center直接创建任务，并保留用户 Worker与超级管理员公共 Worker管理；
- 没有 Chat Agent；
- 所有 Worker属于同一公共执行集群，可跨用户领取任务；浏览器用户仍只能查看自己的任务；
- Worker数量不限；一份持久 credential只允许一个 active instance；
- Method和Dataset单项上限25 MiB；
- 唯一 `backend/Dockerfile.worker`、唯一 Claude Runtime、固定 Goal-Driven Prompt；
- 无 Docker-in-Docker、Docker Socket、独立 Verifier或第二任务容器；
- lease、fencing、幂等、multipart、SHA-256、manifest、ZIP与任务后清理合同保持不变；
- Worker只调用固定Worker v2 API，不获得PostgreSQL管理员连接或任意SQL能力。

## 4. main 要移除的 Cloudflare 活跃依赖

仅在对应本地能力通过后删除活跃入口：

- D1 binding和D1 migrations；
- R2 binding和Wrangler R2上传/下载路径；
- Cloudflare Worker路由和静态Assets部署；
- Wrangler部署、Cloudflare专用Secrets和Quick/Named Tunnel要求；
- zhangbot Relay与远程Redis依赖；
- Cloudflare专用登录回调、配额或环境探测中本地版不需要的部分；
- Cloudflare部署文档、脚本和CI不得继续作为 `main` 默认启动路径。

Cloudflare历史文件可在迁移卡中暂时保留为参考，但最终 `main` 的构建、测试、Compose和运行时
不得加载它们。禁止使用环境开关保留D1/PostgreSQL两条生产路径。

## 5. 顺序实施

### L0：冻结与树迁移设计

- 记录最终Cloudflare commit、当前`main`、`origin/main`和差异；
- 标记每个顶层组件为keep、port、delete；
- 建立安全标签和回滚说明；
- 以最终Cloudflare树作为产品基线，只挑选经过审查的本地独有资产，禁止普通merge。

Gate：能解释每个活跃入口归属，没有Chat Agent，没有两个Task/Worker数据面。

### L1：PostgreSQL唯一事实源

- 建立Task、Attempt、Worker、Session、Event、Outbox、Artifact和multipart PostgreSQL migration；
- 使用事务、行锁/条件更新实现claim、lease、fencing与幂等；
- 使用服务端权限检查和必要RLS保证浏览器隔离，Worker claim不按Task创建者过滤；
- 不复用旧表而不验证schema和状态机。

Gate：空库迁移、升级迁移、并发claim、过期lease、Alice/Bob隔离、跨用户Worker领取和事务回滚测试通过。

### L2：本地Worker v2 API与文件对象层

- 在本地FastAPI提供与Cloudflare版本等价的connect、heartbeat、poll、accept、renew、input、
  artifact start/part/complete、fail和cancelled；
- Method、Dataset、Artifact保存到受控本地对象目录，数据库只保存键、大小、hash和发布状态；
- 防止路径穿越、symlink、越权下载、越权上传和旧lease finalize。

Gate：同一Worker镜像无需Cloudflare凭证即可运行；大Artifact分片、hash、ZIP、清理和重启恢复通过。

### L3：本地Redis协调

- Compose启动独立Redis，密码必须显式生成/提供且无默认值；
- Redis只保存可重建hint、presence和实时事件；
- Redis停止时Worker回退PostgreSQL poll，恢复后Outbox幂等重放；
- 不保留zhangbot或Tunnel依赖。

Gate：Redis清空/停止不丢Task、Attempt或Artifact，不产生双Attempt，Redis无输入文件或Secret。

### L4：本地前端、认证和Task Center

- 保持当前三入口、登录态、Task列表、直接创建、Worker管理、Artifact下载和移动端布局；
- API使用本地同源反向代理；提供明确的本地管理员/bootstrap流程；
- 删除Cloudflare专用前端运行配置，不能恢复Chat Agent或preview假Task。

Gate：unit、typecheck、lint、build和桌面/移动端Playwright通过；Alice/Bob任务隔离和未登录页面通过。

### L5：一键本地部署

- 提供唯一 `docker-compose.local.yml` 与显式 `.env.local.example`；
- 一次启动PostgreSQL、Redis、API、frontend和任意数量Worker；
- migration、healthcheck、持久卷、备份/恢复、日志和停止说明完整；
- Worker的Claude provider配置只进入Worker，不进入前端、日志或Artifact。

Gate：干净机器复制env、填写Secret、一次build/up后可创建Worker和Task；停止/重启后状态与Artifact仍在。

### L6：真实本地验收

- 使用当前Case 2 Method/Dataset跑完整本地链路；
- 验证Task、Attempt、Worker、Artifact、1份发布结果、hash、94序列/Newick和清理；
- Case 3继续标记`DEFERRED_BY_OWNER`，除非用户重新要求执行；
- 执行取消、失租、重复credential、错误hash、路径穿越、跨用户读取和Redis恢复负例。

Gate：没有手工改PostgreSQL、mock、Fixture Executor或旧Cloudflare服务参与。

### L7：main最终审查与发布

- 全量后端、前端、Worker、Compose和浏览器测试在同一commit通过；
- 一个只读Reviewer检查双实现、权限、Secret、文件边界、Worker运行时和Chat Agent回归；
- 主Agent修复后重跑；
- 更新README、LOCAL_DEVELOPMENT、HANDOFF和checkpoint；
- 只提交并推送`main`，不反向合并到`cloudflare-deploy`。

Gate：`main`只有一个本地PostgreSQL生产路径、工作区干净、无P0/P1、回滚引用明确。

## 6. 每卡证据

写入 `evidence/IMPLEMENT-LOCAL-PG/<stage>/<card>/`：execution-card、baseline、测试与退出码、
diff摘要、Secret扫描和checkpoint。任何skip、客户端拦截、容器在线或模型自述都不能当作通过。
