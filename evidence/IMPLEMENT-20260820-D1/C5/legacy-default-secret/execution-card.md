# Execution Card — C5 / legacy-default-secret

唯一可观察结果：历史验收 Compose 不再提供公开的 Worker A/B Redis 默认密码，
并且仍能通过 Compose 配置解析。

范围：只修改 `docker-compose.acceptance.yml`；该文件属于旧 PostgreSQL 验收资料，
不参与当前 D1 Worker 生产启动。

