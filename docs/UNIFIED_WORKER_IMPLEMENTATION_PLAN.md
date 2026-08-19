# Infinity Agents 统一 Worker 集群实施与验收计划

> 版本：v1.0
> 日期：2026-08-19
> 权威架构：`ADR_UNIFIED_WORKER_RUNTIME_2026-08-19.md`
> 现状报告：`WORKER_ARCHITECTURE_GAP_REPORT_2026-08-19.md`

## 0. 最终目标

交付一个可发布到 GHCR、可在平台服务器和学生/管理员 Mac、Windows、Linux 电脑长期
运行的统一 Worker 镜像。超级管理员维护中央 PostgreSQL、Redis、Server API、Provider
和公共地址，并控制服务器端凭证签发；普通用户触发服务器生成 Worker credential 后，
使用管理员提供的部署配置启动容器。

```text
领取 Task
→ 下载 Method + Dataset
→ 固定 Goal-Driven Claude Code 执行
→ 上传 Artifact
→ 原子完成 Task
→ 清空本地目录
→ 等待下一 Task
```

## 1. 实施规则

- 只实现 ADR 中的一套统一 Worker 轨道；
- 不恢复 Chat Agent；
- 不引入独立 Verifier；
- 不使用 Docker-in-Docker 或 Docker Socket；
- 不把 D1 和 PostgreSQL双写为 Task 事实；
- 不动现有远程旧 Worker 的 credential、容器和注册记录；
- 通过协议门禁阻止旧 Worker 领取新任务；
- Method/Dataset 各自保持 25MB；
- Case 2、Case 3 是发布阻断测试；
- 每阶段提交必须可独立回滚。
- 不按学生/管理员区分 Worker 信任等级；
- 普通用户只能触发服务器签发 credential 和查看对应 Worker 状态；
- 只有超级管理员能配置公共地址、Namespace、数据库、Redis、Provider 和调度策略。

## 2. 阶段 P0：仓库与基线收敛

### 工作

1. 以 `cloudflare-deploy` 为当前部署分支；
2. 推送本地尚未进入 GitHub 的有效提交；
3. 清理失效 worktree 元数据，不删除用户文件；
4. 记录并隔离其他 Agent 的 dirty files；
5. 建立部署清单：Git SHA、Cloudflare version、image digest、schema；
6. 把旧 Dockerfile/runtime 标为 deprecated，暂不删除。

### 验收

- 本地 `cloudflare-deploy` 与 `origin/cloudflare-deploy` 指向同一 SHA；
- GitHub 可检出当前线上功能代码；
- 用户已有未提交修改未进入本轮 commit；
- Secret scan 无命中。

## 3. 阶段 P1：PostgreSQL 唯一事实源

### 工作

1. 冻结 Task、Attempt、Worker、Event、Artifact schema；
2. Cloudflare Task API 改为调用中央 PostgreSQL-backed API；
3. 停止 D1 Task/Attempt/Artifact 新写入；
4. 制定 D1 → PostgreSQL 一次性迁移或保留只读历史策略；
5. 禁止无协议双写；
6. 每条用户查询强制 owner/project；
7. Worker 使用 NOBYPASSRLS 的窄权限角色或受控存储过程。

### 验收

- 新 Task 只在 PostgreSQL 产生一份；
- Alice/Bob 猜 ID 不可见；
- D1 与 PostgreSQL 不出现同一 Task 的双主写；
- Task 创建、idempotency 和 Outbox 是一个事务。

## 4. 阶段 P2：Redis 通知与恢复

### 工作

1. Outbox Publisher 把 opaque task hint 写入 Redis Stream；
2. Redis ACL 限制 Namespace、Stream、Consumer Group 和 presence；
3. Worker Redis 不可达时标为 not-ready；
4. 重投由 PostgreSQL CAS 去重；
5. Reaper 使用独立数据库角色；
6. Redis 清空后根据 PostgreSQL Outbox 重建。

### 验收

- Redis 停止时 Task 保留在 PostgreSQL；
- Redis 恢复后任务自动继续；
- 重复 hint 不产生第二个 active Attempt；
- Worker 不能读取其他 Namespace；
- Worker 页面区分 online 和 ready。

## 5. 阶段 P3：Worker 协议和公共池

### 工作

1. connect 请求增加 `protocol_version/runtime_capability/image_digest`；
2. 服务端保存活动 Session 的兼容信息；
3. poll 和 accept 都强制检查能力；
4. 一个 credential 只允许一个 active instance；
5. 同一 Namespace 可创建任意数量 Worker；
6. 公共 Pool 与普通用户 owner 解耦；
7. 调度检查公共 pool、protocol、readiness、任务状态和 CAS lease；
8. 旧协议 Worker 返回 incompatible，不发 Offer。
9. 创建请求不接受 Namespace、Pool、地址、Provider 或信任等级；这些值由管理员配置注入。
10. `created_by` 只控制谁能查看该 credential 对应的 Worker 状态，不限制 Worker 可领取任务。
11. 服务端为每个 Worker 生成/绑定独立的窄权限 PostgreSQL、Redis ACL 和 Provider 身份；
12. 撤销 Worker credential 时同步撤销这些机器身份，不把全局管理 Secret 发到用户机器。

### 验收

- 创建第 3、4、N 个 Worker 成功；
- ID/credential 全部唯一；
- 同 credential 第二实例被拒绝；
- 旧 Windows Worker 在线但拿不到测试 Task；
- 新 Worker 能领取；
- 同一 Task 同时只有一个 lease。
- 学生与管理员生成的 Worker 使用同一协议、同一 Pool 和相同执行能力；
- 学生无法通过创建接口改变集群配置。
- 泄露一个 Worker 的本机 Secret 不能冒充其他 Worker，也不能取得数据库/Redis 管理权限；
- 撤销 credential 后，该 Worker 的数据库、Redis 和 Provider 访问一并失效。

## 6. 阶段 P4：唯一 Docker Worker 镜像

### 工作

1. 选择一个生产 Dockerfile；
2. 镜像包含 Node、Python、Claude Code、Worker Supervisor、Redis/PG client；
3. 删除生产镜像中的 Docker CLI；
4. 不挂 Docker Socket；
5. Claude 使用独立非 root UID；
6. 一个参数化 Compose service 支持任意 Worker；
7. 启动 preflight 检查超级管理员签发的 Worker 级 Claude、PG、Redis、API 和本机 credential；
8. 容器使用 `unless-stopped` 并循环执行。

### 验收

- `claude --version` 成功；
- `docker` 命令不存在；
- 容器无 Docker Socket；
- 镜像无密钥；
- 任一必需依赖不可达时不领取任务；
- 完成一次任务后进程不退出。

## 7. 阶段 P5：统一 Goal-Driven Runtime

### 工作

1. 以 ADR 定义的完整固定提示词替换简化 Prompt；
2. 只维护一个 Prompt 模块和一个版本号；
3. goal 写入冻结 `task_spec.json`；
4. Method 和 Dataset 作为不可信数据；
5. Claude 只能写 work/output/logs；
6. 支持取消、超时和失租终止；
7. 本机 Provider secret 只进入 Claude 子进程所需 Anthropic 变量；
8. Worker PG/Redis/credential 不进入 Claude 环境。

### 验收

- Prompt snapshot；
- Prompt 注入 canary 不改变任务目标；
- Claude 可执行 shell、Python/R 和依赖安装；
- 失租后进程停止；
- Worker secret 不出现在 Claude env、日志或 Artifact；
- 非零 exit/timeout 有明确 failure stage。

## 8. 阶段 P6：两文件和 Artifact 数据面

### 工作

1. Task Center 和 Analysis 都冻结 Method + Dataset；
2. 每个文件 25MB 上限；
3. Attempt 下载使用精确资源 URL；
4. size/hash 不匹配立即失败；
5. output 只接受普通文件；
6. 小 Artifact 流式上传；
7. 大 Artifact multipart；
8. finalize 校验 lease/fencing/object/size/hash/manifest/ZIP；
9. 原子发布 Task/Attempt/Artifact；
10. finally 清理所有本地文件。

### 验收

- 25MB 内成功，超过拒绝；
- 错误 hash 拒绝；
- symlink/FIFO/device 拒绝；
- 30MB 以上结果覆盖 multipart；
- 下载 checksum 一致；
- 成功、失败、取消、失租后目录均为空。

## 9. 阶段 P7：Task Center 与详情页

### 工作

1. 修复静态 `preview` Task ID；
2. 详情页从真实 URL 解析 ID；
3. Task Center 保留新建任务、刷新、任务列表；
4. 详情页左侧列表持续存在；
5. 直接创建使用 `agent_confirmation=false`；
6. 默认 Task 名称取 Method 文件名；
7. Worker 管理默认折叠；
8. 创建按钮始终为“创建”；
9. 显示 ready/incompatible/online；
10. 未登录时左下角不显示用户区。

### 验收

- 不请求 `/api/tasks/preview`；
- 已失败 Task 显示真实失败原因；
- 新建任务不经过 Agent 确认；
- 任意数量 Worker 可创建；
- 桌面和手机布局通过。

## 10. 阶段 P8：GHCR 发布

### 工作

1. 新增 Worker image GitHub Actions；
2. 构建 amd64/arm64；
3. 运行容器 smoke 和 secret scan；
4. 生成 SBOM；
5. 推送 `ghcr.io/<owner>/infinity-agent-worker:v1`；
6. 推送 Git SHA tag；
7. 生产配置 pin digest；
8. Windows 一键启动只需要超级管理员提供的基础配置、用户触发服务器签发的 credential 和 Compose。

### 验收

- Windows/Mac 均能 pull；
- digest 与部署清单一致；
- 不需要源码 build；
- 重启复用持久 credential；
- 第二台机器使用新 ID/credential 即可加入。

## 11. 阶段 P9：Case 2 / Case 3

### Case 2

- 94 条序列；
- GC/长度统计；
- 可解析 Newick；
- 图片、脚本、依赖、日志、报告；
- Artifact 上传/下载/hash；
- Worker 清理并继续在线。

### Case 3

- matrix/barcode/gene 对齐；
- QC、cluster、marker；
- UMAP、h5ad、日志、报告；
- multipart 路径（若结果超过阈值）；
- Artifact 下载/hash；
- Worker 清理并继续在线。

### 硬门槛

两个 Case 必须从网页创建，并由新协议 Docker Worker 真实执行。不得使用 Fixture Executor、手工输出、数据库改状态或旧 `docker_runtime.py` 冒充结果。

## 12. 阶段 P10：审查、推送和部署

1. 后端 review：状态机、RLS、Redis、Worker protocol、Artifact；
2. 前端 review：Task Center、真实 URL、登录、手机布局；
3. Docker review：镜像、Prompt、secret、清理、循环；
4. 修复后重跑所有 Gate；
5. commit 只包含本目标文件；
6. push `cloudflare-deploy`；
7. 确认远程 SHA；
8. 发布 GHCR digest；
9. 迁移 PostgreSQL/Redis；
10. 部署 Cloudflare；
11. 线上再跑 Task URL、Case 2、Case 3；
12. 保存证据和回滚版本。

## 13. 完成定义

```text
GitHub cloudflare-deploy = 线上源码
PostgreSQL 是唯一 Task 事实源
Redis 可重建且参与任务通知
旧协议 Worker 无法领取
GHCR 镜像可一键启动
固定 Goal-Driven Prompt 实际执行
无 Docker-in-Docker / Docker Socket / Verifier
Case 2 PASS
Case 3 PASS
Artifact 可下载且 hash 一致
每次任务后 Worker 清空并继续在线
Task 详情不再出现 preview/Not Found
```

任何一项未满足，本轮不得标记完成。
