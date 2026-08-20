# Execution Card C5R — Redis Relay recovery

## Observable result

The authorized, minimal Redis ACL correction restored the Relay hint path without turning Redis into a task state source. A running v2 Docker Worker continued to poll D1 while Redis was briefly unavailable; after recovery, D1 Outbox replay published all pending hints exactly once and did not create a duplicate Task Attempt.

## Scope and boundary

- Branch baseline: `cloudflare-deploy@975457a0e7e8242bb34ff7d0e67f260425a148e4`.
- Worker under observation: public Worker B, using the v2 HTTPS control plane.
- Redis remains loopback-only on zhangbot. The Relay remains its only external surface.
- The ACL change was restricted to the Relay `api` principal: add the fixed `infinity-public:*` key pattern and the scripting capability required by its idempotent Lua operation. Existing credentials were preserved; unrelated users and services were not changed.
- Case 2 stays frozen as PASS. Case 3 remains `DEFERRED_BY_OWNER` and was not created.

## Production configuration correction

The deployed Edge Worker had the scheduled Outbox handler in source but lacked the production `REDIS_RELAY_URL` secret. The existing relay URL was safely supplied from the running Worker configuration to Cloudflare Secrets without printing or recording the value. The Edge Worker was then deployed as version `09680075-63b3-41cf-8254-cfcf21772272`, with the one-minute cron trigger active.

## Gate result

PASS. Detailed commands, exit states, and metadata-only observations are recorded in the sibling evidence files.
