# Infinity Agents Cloudflare / Worker 架构解析

> **状态：Superseded。** 本文的“中央PostgreSQL执行面”已经被
> [`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`](./ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md)
> 替代。当前D1是唯一事实源，R2保存文件，zhangbot Redis经HTTPS Relay提供通知，Docker
> Worker使用Worker v2 HTTPS API。本文仅保留为迁移历史。

> 更新：2026-08-20
>
> 本文不再描述当前冻结目标。

## 1. 结论

Infinity Agents 由两个边界组成：

1. Cloudflare Edge：静态页面、登录、Cookie/CSRF、ImageJudge 入口和浏览器公网边界；
2. 中央执行面：PostgreSQL、Redis、中央 API、对象/Artifact 存储和长期 Docker Worker。

Cloudflare Edge 不运行 Docker、Claude Code、Verifier，也不持有 Worker 的数据库/Redis
父凭证。PostgreSQL 是 Task、Attempt、Worker、Event、Artifact 的唯一事实源；Redis
只负责任务通知、presence 和事件加速。所有 Worker（管理员机器、公共机器、学生机器）
进入同一个公共集群，不区分可信/不可信执行等级。

```text
浏览器
  │ OIDC Cookie + CSRF
  ▼
Cloudflare Edge ───── 静态页面 / 登录 / ImageJudge / 浏览器 API
  │
  │ 已批准的中央 API 服务认证（P7 待完成）
  ▼
中央 API
  ├─ PostgreSQL：Task / Attempt / Worker / Event / Artifact 事实
  ├─ Redis：opaque task hint / presence / event
  └─ Artifact store：输入与结果的流式存储
                │
                ▼
       长期 Docker Worker（每容器一个 ID + credential）
       ├─ claim + lease + fencing
       ├─ Method + Dataset
       ├─ Goal-Driven Claude Code
       ├─ 单文件/Multipart Artifact 上传
       ├─ checksum/manifest/finalize
       └─ 清理当前任务目录并等待下一任务
```

## 2. Cloudflare Edge 的实际边界

`cloudflare-worker/src/index.ts` 负责：

- `/health`、OIDC 登录回调、opaque session Cookie、CSRF；
- 浏览器 Analysis/Task Center API 的边缘入口；
- `/image-judge/*` 隔离入口；
- 静态 Next 资源和真实 Task ID 动态路由壳；
- 对旧 Worker 协议的明确拒绝。

所有 `/api/worker/v1/*` 请求返回：

```text
410 LEGACY_WORKER_PROTOCOL_DISABLED
```

这条 410 是迁移门禁，不是 Worker 的新连接协议。仓库已经删除了旧的
`worker-control.ts`、Node `worker-client.mjs` 和对应测试；旧 D1 migration 及 410
回归测试保留，用于防止旧客户端重新领取任务。

## 3. Task Center 与事实源

Task Center 直接创建任务时：

```text
POST /api/tasks
agent_confirmation=false
submission_source=task_center
```

Analysis 对话的确认卡和 Task Center 的直接创建都必须最终进入同一个中央 Task
合同。每个任务只有两个输入类型：`Method` 与 `Dataset`，每项上限 25 MB。任务名默认
来自执行文档名称，不能把浏览器显示或 Chat 消息当成任务事实。

当前 Cloudflare bundle 仍保留 `src/tasks.ts` 的 D1 handler 作为迁移期间的兼容代码；
它不是目标事实源。P7 尚未拿到已批准的固定中央 API 地址和服务到服务认证断言，因此
不能现在删除它，也不能宣称 Cloudflare 已经完成 PostgreSQL 代理切换。上线门禁是：

- Edge 路由把浏览器请求转发到中央 API；
- Edge 不把浏览器 bearer 或数据库密钥冒充服务身份；
- 新 Task/Attempt/Artifact 只在 PostgreSQL 产生事实；
- D1 不再写入新的 Task 事实。

## 4. Worker 身份与权限

超级管理员统一签发并提供：

- PostgreSQL 地址和每个 Worker 的最小数据库权限；
- Redis 地址、ACL 和共享 Namespace；
- 中央 API/Artifact 地址；
- Provider Base URL、Model 和按机器/Attempt 的密钥策略；
- 服务器生成的 Worker ID 与持久 credential。

普通用户只能触发服务器签发 credential、复制自己被授权的 credential、检查绑定
Worker 状态；不能提交数据库、Redis、公网 API、Provider、Namespace 或调度范围。

规则：

- 同一 Namespace 可以创建任意多个 Worker；
- 每个 credential 对应一个 Worker ID；
- 一个 credential 同时只允许一个 active instance；
- 停止容器只使 session/lease 过期，不删除持久注册；
- 轮换或撤销立即阻止握手、claim、续租、上传和 finalize；
- 不向机器分发全局管理员密钥；
- Worker 所在机器的所有者可能读取容器 Secret，因此“同一集群”不等于“共享全局密码”。

## 5. 统一 Docker Worker 执行流

镜像唯一入口是 `backend/Dockerfile.worker`。容器内直接运行 Claude Code，不安装
Docker CLI、不启动 Docker daemon、不挂载 `/var/run/docker.sock`。固定流程：

```text
PostgreSQL Outbox → Redis hint
→ Worker authenticate/reverse handshake
→ Redis consume + PostgreSQL CAS claim
→ 下载当前 Attempt 的 Method + Dataset
→ 固定 Goal-Driven 平台提示词 + 用户任务输入
→ Claude Code 在容器内执行
→ 结果收集、路径/大小/manifest 检查
→ 单请求或 Multipart 流式上传
→ lease/fencing/checksum/manifest/finalize
→ 删除 input/work/output/log 临时目录
→ 保留中心 Artifact，Worker 继续等待
```

没有独立 Verifier 服务。Worker 内的确定性文件和归档安全检查只负责数据面不变量；
科学结果是否满足 Method 中的验收条件由任务结果和用户/后续科学审查判断，不能由
模型自报“完成”替代 Artifact 事实。

## 6. 镜像与 Compose 约束

生产/公共启动文件 `docker-compose.cloudflare-workers.yml` 是 image-only：

```sh
docker compose --env-file worker-b.cloudflare.env \
  -f docker-compose.cloudflare-workers.yml config
docker compose --env-file worker-b.cloudflare.env \
  -f docker-compose.cloudflare-workers.yml up -d worker-b
```

`WORKER_IMAGE` 必须是本地已核验 tag 或不可变 GHCR digest；Compose 不在启动时隐式
构建源码。`scripts/run_local_cloudflare_workers.sh` 只负责可选的 zhangbot Redis
SSH 隧道和调用这份 image-only Compose，不再加载旧的 HTTPS control client。

镜像 CI 检查：

- linux/amd64 与 linux/arm64 构建；
- Claude Code 版本检查；
- 无 Docker socket/CLI 边界检查；
- SBOM/provenance 构建检查；
- 仅构建验证，不自动发布 GHCR。

## 7. Artifact 与大文件

中心 API/Artifact 层必须支持：

- 小结果单请求上传；
- 大结果按固定 part size 流式分片；
- part 编号连续、总大小和 SHA-256 一致；
- 当前 Attempt、lease token、fencing epoch 和 manifest 一致；
- finalize 成功后才可下载；
- 上传失败或 lease 失效时不发布孤儿 Artifact；
- Worker 只清理本机任务目录，不清除中心任务事实。

## 8. 当前发布门禁

已完成并有证据：

- 旧 Edge Worker 协议返回 410；
- Task detail 使用真实浏览器 Task ID；
- Artifact Multipart 的 PG 状态、大小、SHA、ZIP、manifest、lease/fencing 检查；
- Worker image 本地 amd64/arm64 构建和运行边界；
- 旧 Cloudflare Worker control/client 代码清理。

尚未完成：

- P7：固定的 Edge → 中央 API 服务认证与路由代理；
- P9：真实中央 PostgreSQL + Redis + 新 Docker Worker + Claude Code 执行 Case 2/3；
- P10：最终只读审查；
- GHCR 推送和 Cloudflare 部署。

在 P7/P9/P10 通过前，不能把线上 `infinity.zhangyvjing.com` 或已有旧容器的状态
写成新架构的通过证据，也不能删除现有线上数据或旧运行容器。
