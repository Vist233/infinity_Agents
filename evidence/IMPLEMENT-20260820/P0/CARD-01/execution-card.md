# EXEC-P0-01: 收敛唯一生产 Worker 入口

## Control

- run_id: IMPLEMENT-20260820
- primary executor: Codex / GPT-5
- stage: P0
- baseline commit: 4ec22503cf204eee1f56f686d02a0f51b7abd88
- risk: R2

## One outcome

生产 Compose 与镜像只启动 `backend.code_agent.worker.consumer`，统一使用
`backend/Dockerfile.worker`；完整 Goal-Driven Prompt 使用
`backend/code_agent/worker/claude_runtime.py`。旧 Direct Prompt、旧 Dockerfile
和旧 Cloudflare Worker 入口不再被生产配置引用。

## Scope

- 生产实现：Worker Dockerfile、Compose、executor/runtime 入口
- 测试：唯一 Runtime 的单元与 Goal-Driven Prompt 测试
- 外部系统：none

## Explicit non-goals

- 本卡不修改线上 Cloudflare、PostgreSQL、Redis 或 GHCR。
- 本卡保留旧 Cloudflare/Docker runtime 文件作为迁移测试材料，并明确标记为 legacy；
  后续卡在真实 Case 通过后再做有目标的清理。

## Frozen invariants

- 不使用 Docker-in-Docker 或 Docker Socket。
- Attempt-scoped Model Gateway 仍是 Claude 子进程唯一模型能力来源。
- Worker 控制凭证、Redis、PostgreSQL 和长期 Provider 密钥不能进入 Claude 环境。
- 生产默认 executor 必须是唯一 direct runtime；fixture 仅限 acceptance。
