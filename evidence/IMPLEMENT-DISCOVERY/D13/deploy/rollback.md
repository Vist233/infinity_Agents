Rollback plan:

1. Set `DISCOVERY_AUTO_EXECUTE=false` and `DISCOVERY_LITERATURE_ENABLED=false`.
2. Roll back the Edge code version to the last known-good deployment.
3. Stop/recreate only the isolated `infinity-discovery-processor` Compose
   project with the prior pinned image; leave Worker v2 containers untouched.
4. Keep additive migrations 0023/0024 in place; do not drop Discovery tables.
5. Recheck `/health`, D1 session expiry/revocation, Paper/Collection auth
   boundaries, and existing Worker v2 sessions.
