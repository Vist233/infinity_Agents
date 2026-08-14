# 公共 Worker 集群实施计划

## 目标

建立一个真正属于 Infinity Agents 平台的公共 Worker 集群，而不是绑定某个学生账号的个人 Worker。

公共机器上运行两个长期 Worker：

```text
公共 Worker Namespace
├─ Worker A：服务端生成 ID + 独立持久 credential
└─ Worker B：服务端生成 ID + 独立持久 credential
```

用户只在公共机器本地填写 Claude Code 的：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_MODEL
ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
```

这些模型配置不进入网页、不进入平台数据库、不进入 Worker credential，也不写入 Git。

## 为什么之前没有完成

当前实现把 Worker 注册和任务领取都设计成了“当前登录用户的个人 Worker”：

1. `worker_registrations.user_id` 是必填的个人所有者字段；
2. Worker 创建接口从当前登录用户生成注册记录；
3. Worker 列表、credential 恢复、轮换、撤销都按当前用户过滤；
4. Worker `poll` 查询条件是 `tasks.created_by = Worker.user_id`；
5. 同一个 Namespace 只代表个人账号下的复用范围，不代表公共集群；
6. 前端页面的文案也写成了“为当前账户创建 Worker”。

因此，之前即使填写同一个 Namespace，创建出来的仍然是个人 Worker，不能执行其他用户的任务。此前生成的 Windows 部署包建立在这个错误假设上，必须删除，不能继续使用。

## 实施顺序

### 1. 建立平台公共 Worker 身份

新增平台级公共 Worker 配置/服务主体，至少包括：

- `pool_id` 或 `worker_group_id`：公共集群唯一 ID；
- `namespace`：平台级公共 Namespace，不能由普通用户随意创建；
- `status`：active、draining、revoked；
- `allowed_task_classes`：公共 Worker 可以领取的任务类型；
- `trust_level`：由平台配置和服务端权限决定，客户端不能自报；
- `created_at`、`updated_at`、审计事件。

公共 Namespace 的所有权不再使用普通用户 `user_id` 表示。若需要记录创建人，只保留审计字段，不把创建人作为任务访问边界。

### 2. 改造公共 Worker 注册

新增仅限平台管理员/部署操作使用的公共 Worker 注册接口：

```text
POST /api/admin/worker-pools/{pool_id}/workers
```

每次调用：

- 由服务端生成唯一 Worker ID；
- 由服务端生成独立持久 credential；
- credential 明文只在创建响应中返回一次，数据库保存 hash + 加密副本；
- 两个 Worker 使用同一公共 Namespace，但绝不共用 Worker ID 或 credential；
- 信任等级由服务端生成；
- 普通学生不能调用该接口，不能创建公共 Worker，不能读取公共 credential。

公共机器使用同一个公共 Namespace 和两组独立凭证：

```text
WORKER_NAMESPACE=<platform public namespace>
WORKER_ID_A=<server generated>
WORKER_CREDENTIAL_A=<persistent credential>
WORKER_ID_B=<server generated>
WORKER_CREDENTIAL_B=<persistent credential>
```

### 3. 改造 Worker 认证上下文

认证后 Worker context 至少包含：

```text
worker_id
pool_id
namespace
trust_level
allowed_task_classes
```

Worker 请求不得从浏览器用户 session 推导身份。公共 Worker 只通过自己的持久 credential 认证。

### 4. 改造任务可见性和领取

任务领取不能再使用：

```sql
t.created_by = worker.user_id
```

改为服务端授权判断：

```text
task.status = queued
AND task.task_class 属于公共 Worker allowed_task_classes
AND task.project/task 的执行策略允许公共集群
AND task 没有有效 offer 或 lease
```

任务的创建者仍然保留在 `created_by`，用于用户任务列表和审计；它不再限制公共 Worker 领取。

建议新增明确字段：

```text
tasks.execution_scope = public_pool | owner_only | named_pool
tasks.worker_pool_id = NULL | <public pool id>
```

默认策略：

- `public_pool`：公共 Worker 可领取；
- `owner_only`：只允许用户自己的受信 Worker；
- `named_pool`：只允许指定公共/机构 Worker Pool。

没有明确 scope 的旧任务必须迁移为安全默认值，不能自动扩大为公共可见。

### 5. 任务数据安全边界

公共机器属于受信执行域，但仍然不能获得数据库、Redis 或 Cloudflare parent credential。

服务端按 Attempt 下发精确资源：

- 只下发该任务允许的数据；
- 每次资源访问绑定 `task_id + attempt_id + fencing_epoch`；
- Artifact 上传进入 quarantine；
- Verifier 发布后用户才能下载最终 Artifact；
- Worker 不能自己把任务改成最终 succeeded。

### 6. 前端调整

普通用户页面不显示“创建公共 Worker”。

管理员/平台运维入口显示：

- 公共 Worker Pool；
- 公共 Namespace；
- Worker A/B 的服务端 ID；
- 在线状态和最近心跳；
- 信任等级；
- 创建、轮换、撤销操作；
- credential 仅在受控创建/轮换响应中显示。

普通用户只看到“公共集群可用/不可用”，不能看到或复制公共 credential。

### 7. 公共机器 Docker 部署

只有公共 Worker 注册接口和数据库迁移完成后，才生成部署配置：

- 两个 Worker 容器；
- 不启动本地 Redis/PostgreSQL；
- 不挂 Docker Socket；
- 不使用 Docker-in-Docker；
- Claude Code 直接在容器内执行；
- 两个容器分别注入自己的 credential；
- Claude 三项配置由机器管理员本地填写；
- 容器重启后复用同一 credential 和 instance_id。

### 8. 验收顺序

1. 管理员创建公共 Worker Pool；
2. 创建 Worker A/B；
3. A/B 使用同一 Namespace、不同 ID、不同 credential 成功 connect；
4. 普通用户创建一个 `public_pool` 测试任务；
5. A 或 B 能看到并领取该任务；
6. 另一个 Worker 不能重复领取同一任务；
7. 任务执行、心跳、Artifact 上传和 verifier 发布完成；
8. 普通用户可以下载结果；
9. `owner_only` 任务不能被公共 Worker 领取；
10. 撤销一个 credential 后，该 Worker 不能 reconnect；
11. 重启容器后仍能使用原 credential 恢复；
12. 日志、Artifact、响应中没有模型 Key 或 Worker credential。

## 当前禁止操作

- 不要从普通用户的“添加 Worker”页面创建公共 Worker；
- 不要把 Namespace 写成 `infinity` 就认为它是公共 Namespace；
- 不要让两个容器共用 credential；
- 不要把 `created_by = 当前 Worker 用户` 改成一个更宽的临时 SQL 条件；
- 不要把所有旧任务无条件开放给公共 Worker；
- 不要继续使用旧的个人 Worker Windows 部署包。
