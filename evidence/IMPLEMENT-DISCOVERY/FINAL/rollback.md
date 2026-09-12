Rollback:

- keep `DISCOVERY_AUTO_EXECUTE=false` and `DISCOVERY_LITERATURE_ENABLED=false`;
- roll back Edge to the prior code version if Discovery causes regressions;
- roll back only the pinned isolated Discovery Processor image/Compose project;
- leave existing Worker v2 containers, images, Task Center, and Redis Relay
  untouched;
- retain additive migrations 0023/0024; do not drop or rewrite D1 facts;
- recheck Edge health, auth negatives, Processor session expiry, R2 access, and
  active Worker v2 sessions after rollback.
