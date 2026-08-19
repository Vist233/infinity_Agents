# Infinity Agents Worker 架构简报

> 日期：2026-08-19
> 这是详细报告 `WORKER_ARCHITECTURE_GAP_REPORT_2026-08-19.md` 的决策摘要。

## 现在是什么问题

当前不是一个问题，而是三套 Worker 架构混在一起：

1. 本地代码使用 PostgreSQL + Redis，Worker 容器内直接运行 Claude Code，但仍有 Verifier 和旧执行器；
2. 线上 Cloudflare 版使用 D1 + R2 + HTTPS Control API，Redis 只做 PING，Worker 不连接 PostgreSQL；
3. 旧 Windows Worker 和新 Mac Worker 没有协议隔离，都能竞争同一个公共池任务。

因此 Case 2 出现了两个独立故障：

- 页面把静态壳 `preview` 当成 Task ID，所以真实任务存在却显示 `Task not found`；
- 旧 Windows Worker 抢走任务并失败，应该测试的 Mac Worker 3 根本没有执行它。

当前本机 Worker 容器虽然在线，但 Redis 隧道连接失败，而且被配置成“失败也继续”。它实际通过 HTTPS 从 Cloudflare 领取任务，不是你要求的 PostgreSQL/Redis 直连 Worker。

另外，本地 Cloudflare 部署代码比 GitHub 的 `cloudflare-deploy` 多 35 个未推送提交。线上版本无法从 GitHub 同名分支重复构建。

## 你现在要的架构

你要的是平台服务器、管理员电脑和学生电脑全部使用下面这套单一架构：

```text
PostgreSQL：唯一任务事实源
Redis：任务通知、事件、心跳
服务器：Method/Dataset 下载和 Artifact 上传
Docker Worker：长期运行，一个容器一个 Worker 身份
Claude Code：每个任务在该容器内启动一次，使用固定 Goal-Driven Prompt
```

每个任务严格执行：

```text
Redis 收到任务
→ PostgreSQL 原子领取和建立 lease
→ 下载执行文档 + 数据集两个文件
→ 校验 25MB 上限和 SHA-256
→ 容器内直接运行 Claude Code
→ 结果 ZIP + checksum
→ 大文件流式/分片上传服务器
→ PostgreSQL 原子标记成功
→ 清空本地所有任务文件
→ 容器继续等待下一任务
```

不在 Docker 里面启动 Docker，不挂 Docker Socket，不使用独立 Verifier。取消 Verifier 不等于取消 lease、checksum、manifest 和上传完整性检查。

Worker 可以创建任意数量；所有 Worker 使用超级管理员配置的同一公共 Namespace/Pool，
每个 Worker 有不同 ID 和持久 credential。凭证由服务器按超级管理员维护的策略统一
签发；普通用户只能触发签发并查看对应 Worker 状态，不能修改数据库、Redis、API、
Provider、Namespace 或调度配置。一个
credential 同时只能连接一个实例。旧协议 Worker 即使在线，也不能领取新协议任务。

同一集群不等于所有机器共用一套管理员密码。学生控制自己的 Docker 主机时能够读取容器
Secret，所以每个 Worker 必须获得独立、最小权限、可撤销的 PostgreSQL/Redis/Provider
机器凭证；这些凭证仍由超级管理员控制的服务统一签发。

## 为什么之前一直失败

- 没有先确定 PostgreSQL/D1、Redis、Provider、Verifier 的唯一合同；
- 多套 Dockerfile、Runtime 和 Compose 同时存在；
- 服务端没有强制 Worker 协议版本；
- 测试大量验证 Mock 和局部函数，没有真实跑网页到 Artifact 的完整链路；
- Case 2/3 的旧测试走的不是线上 Worker Runtime；
- 部署发生在推送 GitHub 之前；
- 文档仍保留已被你后续决定推翻的旧设计。

## 应该按什么顺序改

1. 写当前生效 ADR：所有 Worker 进入同一 PostgreSQL/Redis 集群、无 Worker 信任分级、无 Verifier、固定 Goal-Driven Prompt。
2. 统一成一个 Worker Dockerfile 和一个 Runtime，删除生产嵌套 Docker 路径。
3. 把 Cloudflare 版的完整 Goal-Driven Prompt 合并进 PostgreSQL/Redis Direct Worker。
4. 增加 Worker protocol/capability 强制门禁，让旧 Worker 不能抢任务。
5. 修复 Task 详情页 `preview` ID。
6. 完成 streaming/multipart Artifact 上传和任务后清理。
7. 增加 GHCR 构建发布，生成 `ghcr.io/<owner>/infinity-agent-worker:v1` 和固定 digest。
8. 用同一新 Worker 真实跑 Case 2、Case 3，验证网页下载、checksum、清理和继续在线。
9. 通过后推送 `cloudflare-deploy`，再部署 Cloudflare，记录 Git SHA、Cloudflare version、镜像 digest 和数据库 revision。

完整报告见 `docs/WORKER_ARCHITECTURE_GAP_REPORT_2026-08-19.md`。
