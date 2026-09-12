# Paper Discovery + Data Collections — final summary

Status: BLOCKED — the D0-D14 implementation and rollout are evidenced, but the
required live execution gates are not complete and no final pass is claimed.
The authorized live gate materialized exactly one Task and passed the Redis
poll-fallback check, but the selected Task exhausted three Worker leases
without a Claude terminal event or Artifact. Literature and live-model gates
remain unrun; see `FINAL/remaining-gates.md` and
`D14/final-regression/gated-live-run-20260912.md`.

The authorized follow-up selected one distinct match exactly once after the
scanner/lease hardening. Its first Attempt reached the accept/spec/input
boundary, then the D1 write path became unavailable: renew returned 500,
session refresh returned 401, and both repaired Worker connects returned 503.
The follow-up Task remains unfinalized and has no Artifact; see
`D14/final-regression/gated-live-followup-20260913.md`. This does not close the
Claude/Artifact gate.

Delivered:

- additive D1 Discovery catalog and fenced Processor leases;
- fenced output pointers with stale-output cleanup and deletion safety;
- authenticated Papers and Data Collections APIs and DeepWiki-style pages;
- bounded Paper Profile Compiler/document gate;
- safe Dataset Inspector with comma/tab/semicolon detection;
- bounded, strict capability contracts and versioned feasibility evaluation;
- server-recomputed match coverage and hard execution threshold gates;
- idempotent reuse of existing Task Center materialization;
- bounded opt-in arXiv/Europe PMC watcher with leases, retries, and quota;
- isolated Windows Discovery Processor over fixed HTTPS control routes;
- real public arXiv paper + UCI red-wine shadow case verified in production;
  a fresh UCI derivative also completed inspection and matching after rollout.
- the dedicated Paper Processor safe-failure release `344a93d` (runtime commit
  `62e5b7fe4c5a35345c7bc41886ea8ae3e9928228`) deployed to zhangbot; a fresh
  public ResNet PDF then completed Paper Profile compilation end to end;
- Paper Processor failure propagation fixed in `89668c7`, deployed as Edge
  Version `9941f714-eee6-46bc-8163-968107d8874f`.

The current Edge vars intentionally keep `DISCOVERY_AUTO_EXECUTE=false` and
`DISCOVERY_LITERATURE_ENABLED=false`; only the two explicitly selected,
distinct live test Tasks exist, with no duplicate Task or fabricated Artifact.
Remote D1 migrations 0025-0027 are applied, and the final migration listing is
clean. The current Edge deployment is
`9d898d5d-9753-4e14-bf0f-1fb25c829127`. Both isolated Windows Workers are
running with restart count 0 on the local r3 image digest
`sha256:1ac359bfc2a9336d9ee82dbe37b0115b666e6ebd5f9f8ac28674a52c4c2e5227`.
The isolated Windows Discovery Processor is running with restart count 0 and digest
`sha256:2bb2a1c1171e28e646006d185a2fc9bab3fb190b3aa1b0778e04194087147496`.

The live selected Task was visible in Task Center but failed after three
lease-expired Attempts; it has no Artifact and no duplicate Task was created.
An existing published Task's authenticated download was independently verified
at 1,234,445 bytes with SHA-256
`1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`.
A bounded Redis-only outage showed Relay hints/health returning 503 while
D1/Worker leases continued; Redis and Relay recovered to 200. No Worker v2
container was stopped.
