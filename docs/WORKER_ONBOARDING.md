# Worker 接入与执行说明

> 目标合同：`ADR_D1_REDIS_WORKER_RUNTIME_2026-08-20.md`
> 当前状态：本文下方PostgreSQL配置示例已失效。Worker v2 API、zhangbot Redis Relay和
> GHCR镜像完成前，本文件不能作为正式安装说明。续作见`D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`。

## 1. 一个统一集群

平台服务器、管理员电脑和学生电脑上的 Worker 都加入同一个公共集群：

```text
PostgreSQL：Task/Attempt/Worker/Event/Artifact 唯一事实源
Redis：任务通知、Consumer Group、事件和心跳
Server API：两项输入下载、Artifact 上传/下载
Docker Worker：容器内直接运行 Claude Code
```

没有个人 Worker Pool，也没有学生/管理员 Worker 信任等级。每台机器只有独立身份和
credential，执行协议与能力完全相同。

## 2. 谁负责什么

超级管理员提供不进入 Git 的基础配置包：

```dotenv
WORKER_IMAGE=ghcr.io/<repository-owner>/infinity-agent-worker@sha256:<verified-digest>
WORKER_IMAGE_DIGEST=<pinned-digest>
WORKER_PROTOCOL_VERSION=<current-version>

WORKER_DATABASE_URL=<admin-issued-per-worker-database-url>
WORKER_REDIS_URL=<admin-issued-per-worker-redis-acl-url>
REDIS_NAMESPACE=<admin-configured-public-namespace>
WORKER_CONTROL_PLANE_URL=<admin-provided-central-api>

ANTHROPIC_BASE_URL=<admin-provided-base-url>
ANTHROPIC_MODEL=<admin-provided-model>
ANTHROPIC_API_KEY=<admin-issued-per-worker-key>
ANTHROPIC_AUTH_TOKEN=
```

普通用户/学生不能在网页中编辑这些地址和密钥。他们在任务中心只做：

1. 点击“创建”；
2. 得到服务端生成的 Worker ID 和持久 credential；
3. 在本机 Secret 文件补入：

```dotenv
WORKER_ID=<server-generated-worker-id>
WORKER_CREDENTIAL=<persistent-worker-credential>
WORKER_INSTANCE_ID=<stable-local-instance-id>
```

4. 查看该 credential 所在 Worker 的在线、ready、协议、任务和错误状态。

这里的“管理员提供”是指值和权限由管理员控制。学生拥有本机 Docker 管理权限时可以读取
容器 Secret，因此管理员必须提供 Worker 级、可撤销、最小权限的数据库/Redis/Provider
凭证，不能提供全局管理员密码或全局 Provider Key。同一集群不等于共用同一密码。

## 3. 一键启动目标

最终发布完成后，Windows PowerShell 和 Mac/Linux 使用同一 Compose 文件。概念命令为：

```text
准备超级管理员提供的 base env
加入本次生成的 Worker ID/credential
拉取固定 digest 的 GHCR 镜像
docker compose up -d worker
```

当前仓库还没有完成 GHCR Worker image workflow，不能把文档中的占位镜像名当成已经可
拉取的成品。实施完成后必须把 `<repository-owner>` 和 digest 替换为真实值。

## 4. Worker 启动检查

Worker 必须在领取任务前检查：

- Worker ID/credential；
- protocol version/image digest；
- PostgreSQL；
- Redis；
- Server/Artifact API；
- Claude Code CLI；
- Anthropic Base URL/model/key。

任一必需依赖不可用时显示 `not_ready/degraded`，不参与任务领取。不能只因为 heartbeat
成功就在网页显示可用。

## 5. 任务执行

```text
Redis task hint
→ PostgreSQL CAS claim + Attempt/lease/fencing
→ 下载 Method Document + Dataset Snapshot
→ 25MB 与 SHA-256 校验
→ 固定 Goal-Driven Prompt
→ 容器内非 root Claude Code
→ ZIP + checksum
→ streaming/multipart 上传
→ 服务端 finalize
→ PostgreSQL 原子 succeeded/published
→ 清空 spec/input/work/output/logs/archive
→ 继续等待下一任务
```

容器不安装 Docker CLI，不挂 Docker Socket，不使用 Docker-in-Docker，不启动本地
PostgreSQL/Redis，也不启动独立 Verifier。

## 6. 凭证规则

- 同一公共 Namespace 可创建任意数量 Worker；
- 每次点击“创建”都产生新 Worker ID 和新 credential；
- 同一 credential 只能有一个 active instance；
- credential 持久有效，容器重启后继续使用；
- 轮换后旧 credential 立即失效；
- 撤销后不能连接、领取、续租、上传或 finalize；
- `created_by` 只决定用户能否查看 credential 状态，不限制 Worker 任务来源；
- 普通用户不能通过 API 修改 Namespace、Pool、数据库、Redis、Provider 或任务范围。

## 7. 验收

正式交付必须完成：

- 学生不填写 Namespace/地址，只触发服务器签发 credential；
- 学生和管理员 Worker 进入同一公共 Pool；
- 第 3、4、N 个 Worker 正常加入；
- 旧协议 Worker 显示 incompatible 且不能领取；
- Case 2 和 Case 3 由真实 Docker/Claude Code 完成；
- Artifact 可下载且 checksum 一致；
- 每个任务后 Worker 目录为空且容器继续在线；
- 日志、Artifact、响应和镜像不包含平台 Secret 或 credential。
