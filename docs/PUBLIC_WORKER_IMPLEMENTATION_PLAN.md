# 统一公共 Worker 集群实施规则

> 更新：2026-08-20
> 权威架构：`ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md`
> 本文替代旧的个人 Worker、可信/不可信 Worker 和固定 A/B Worker 设计。

## 1. 目标

Infinity Agents 只有一个公共 Worker 集群。平台服务器、管理员电脑和学生电脑上的全部
Worker 都：

- 使用同一 Worker 镜像和协议；
- 连接超级管理员提供的同一 PostgreSQL、Redis 和 Server API；
- 进入同一公共 Namespace/Pool；
- 使用相同 Goal-Driven Prompt 和任务执行能力；
- 竞争同一类可执行任务；
- 通过独立 credential、Session、lease 和 fencing 保证唯一性。

不存在个人私有 Worker Pool，也不存在 general/full、trusted/student 两类 Worker。

## 2. 管理权限

### 超级管理员

超级管理员统一配置和提供：

- PostgreSQL 地址、数据库、TLS 和 Worker 角色策略；
- Redis 地址、TLS、ACL、Namespace 和 Consumer Group；
- Server API、Artifact API、Cloudflare 公网地址；
- Worker image、protocol version 和公共 Pool；
- `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、API Key/Auth Token；
- 任务调度、并发、租约和 Artifact 限制。

### 普通用户和学生

credential 由服务器依据超级管理员维护的策略统一签发。普通用户/学生只能：

1. 点击“创建”，请求服务端生成一个新的 Worker ID 和持久 credential；
2. 复制本次 credential；
3. 查看该 credential 所在 Worker 的连接、ready、协议、任务和错误状态。

普通用户/学生不能在创建请求中提交或修改：

- Namespace/Pool；
- PostgreSQL/Redis/API 地址；
- Provider/model/key；
- Worker 信任等级；
- 任务范围或 dispatch policy；
- 公共密钥和平台 Secret。

credential 的 `created_by` 只用于审计和控制谁能查看这条 credential 的状态，不把该
Worker 变成创建者的私有执行节点。

普通用户没有配置权，不等于能够对机器所有者隐藏容器中的 Secret。超级管理员必须为每个
Worker 提供独立、窄权限、可撤销的数据库身份、Redis ACL identity 和 Provider token，
禁止把全局管理员密码或全局 Provider Key 分发到学生控制的主机。所有这些身份仍连接同一
PostgreSQL/Redis 集群，不构成第二套 Worker 架构。

## 3. 创建和凭证

每次创建必须：

- 服务端生成唯一 Worker ID；
- 服务端生成独立、持久、可轮换、可撤销的 credential；
- 使用超级管理员冻结的 Namespace/Pool；
- credential 明文只在创建/取回的受控响应中显示；
- 数据库保存 hash 和必要的加密副本；
- 不设两个 Worker 上限；
- 创建按钮始终为“创建”；
- 同一 Namespace 可创建任意数量 Worker；
- 同一个 credential 同时只允许一个 active instance。

用户只需为每个容器触发一次 credential 签发。第二、第三或第 N 个 Worker 都走相同流程，
不能复制其他 Worker credential。

## 4. Worker 认证上下文

服务端认证后上下文至少包含：

```text
worker_id
credential_id
public_pool_id
namespace
protocol_version
runtime_capability
image_digest
session_id
ready_state
```

不包含由客户端自报的 trust level、owner task scope 或 Provider 配置。Worker 的
PostgreSQL 身份和 Redis ACL 由中央签发服务按照超级管理员配置的集群策略生成。

## 5. 任务领取

所有 Worker 从同一 Redis Stream/Consumer Group 获得 opaque task hint，再回 PostgreSQL
进行最终 CAS claim。领取条件至少包括：

```text
Task.status = queued
Worker credential/session = active
Worker ready_state = ready
Worker protocol/runtime = compatible
Task 没有有效 lease
CAS claim 成功
```

任务创建者不限制哪个 Worker 可以领取。另一个 Worker 即使收到重复 Redis hint，也必须
在 PostgreSQL CAS 失败后停止，不能产生第二个 active Attempt。

旧协议 Worker 可以保持注册记录和在线状态，但必须显示 incompatible，不能获得或接受新
协议任务。

## 6. Worker 本地配置

超级管理员提供一份不进入 Git 的基础配置包，包含：

```text
DATABASE_URL / per-Worker database identity
REDIS_URL / per-Worker Redis ACL identity
REDIS_NAMESPACE
SERVER_API_BASE_URL
ARTIFACT_API_BASE_URL
ANTHROPIC_BASE_URL
ANTHROPIC_MODEL
ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN（per-Worker、可撤销）
WORKER_IMAGE / image digest
WORKER_PROTOCOL_VERSION
```

普通用户只补入自己在网页生成的：

```text
WORKER_ID
WORKER_CREDENTIAL
WORKER_INSTANCE_ID
```

基础配置和 credential 都是本地 Secret，不进入网页 Local Storage、Git、镜像或 Artifact。
机器所有者可读取本机 Docker Secret，因此这些值必须是 Worker 级最小权限凭证，不能是
全局管理凭证。

## 7. Docker 运行

- 一个长期容器对应一个 Worker ID；
- 容器内直接运行 Claude Code；
- 不安装 Docker CLI；
- 不挂 Docker Socket；
- 不使用 Docker-in-Docker；
- 不启动本地 PostgreSQL 或 Redis；
- 完成任务后上传 Artifact、清空任务目录、继续轮询；
- 容器重启后复用同一持久 credential；
- Claude Code 使用超级管理员提供的 Provider 配置；普通用户不能在产品页面修改。

## 8. Task 和 Artifact

每个 Task 的业务输入只有：

1. Method Document；
2. Dataset Snapshot。

两者各自保持 25MB 上限。Worker 下载后校验 size/hash，使用平台固定 Goal-Driven Prompt
执行。结果小文件流式上传，大文件 multipart 上传。

不使用独立 Verifier。服务端 finalize 仍必须验证 current Attempt、lease、fencing、对象
存在、大小、checksum、manifest 和 ZIP 基础完整性，然后原子发布 Artifact。

## 9. 前端

Worker 卡只要求用户点击“创建”，不要求填写 Namespace 或基础设施配置。创建后显示：

- Worker 序号和 ID；
- credential 取回/复制、轮换、撤销；
- 在线/离线；
- ready/degraded/incompatible；
- protocol/image version；
- 当前 Task 和最近错误。

普通用户只能看到自己触发签发的 credential 状态和公开集群摘要，不能看到其他 credential
明文或平台基础 Secret。超级管理员可查看整个公共集群。

## 10. 验收

1. 超级管理员配置一次公共 PostgreSQL/Redis/API/Provider；
2. 学生点击“创建”，不填写 Namespace 或地址；
3. 服务端返回唯一 Worker ID 和持久 credential；
4. 学生用管理员基础配置 + 自己 credential 启动容器；
5. Worker 进入同一公共 Pool 并显示 ready；
6. 管理员和学生触发服务器签发的 Worker 执行能力相同；
7. 创建第 3、4、N 个 Worker 均成功；
8. 同一 credential 第二实例被拒绝；
9. 旧协议 Worker 无法领取；
10. Case 2、Case 3 完成并下载 Artifact；
11. 每个任务后本地目录清空，Worker 继续在线；
12. 用户不能通过 API body 修改 Namespace、Pool、地址、Provider 或信任等级；
13. 日志、响应和 Artifact 不泄露平台 Secret 或 credential。

## 11. 禁止事项

- 不把创建人作为任务领取 owner 边界；
- 不创建学生专用或管理员专用 Worker Pool；
- 不接受客户端自报 trust level；
- 不让普通用户填写 Namespace、数据库、Redis、Provider 或公网地址；
- 不限制最多两个 Worker；
- 不共用 credential；
- 不恢复 D1-only/HTTPS-only 学生 Worker 旁路；
- 不使用 Docker-in-Docker、Docker Socket 或独立 Verifier。
