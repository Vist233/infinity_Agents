# CHECKPOINT IMPLEMENT-20260820-D1 / C5R / redis-acl-authorization-blocked-20260820

- baseline/current candidate: `cloudflare-deploy@3c6cbae` before this evidence-only card.
- status: **BLOCKED — explicit Redis ACL authorization required**.
- cause: Relay `/v1/hints` has a known HTTP 503 because the zhangbot Redis `api` ACL lacks the fixed `infinity-public:*` key permission and required script permission.
- not performed: ACL changes, credential reads/writes/rotation, Redis restart/stop, Relay redeploy, D1/R2 mutation, Case 2 rerun, or Case 3 creation.
- required authorization before resuming: permit the minimum ACL change only for the `api` user and fixed `infinity-public:*` Relay contract; preserve all unrelated ACL rules/credentials and do not restart unrelated services.
- This authorization-blocked checkpoint is superseded by `../redis-acl-recovery-20260820/` after the owner authorized the minimal ACL change and all listed recovery gates passed.
- next independent card: C6 browser acceptance.
