# Paper Discovery + Data Collections — final summary

Status: BLOCKED — the D0-D14 implementation and rollout are evidenced, and a
controlled r6 public-data Task passed the Claude/Artifact/download gate, but
the evaluated-match Artifact gate and later Literature/live-model gates remain
open; no overall final pass is claimed.
The authorized live gate materialized exactly one Task and passed the Redis
poll-fallback check, but the selected Task exhausted three Worker leases
without a Claude terminal event or Artifact. Literature and live-model gates
remain unrun; see `FINAL/remaining-gates.md` and
`D14/final-regression/gated-live-run-20260912.md`.

The authorized follow-up selected one distinct match exactly once after the
scanner/lease hardening. Its first Attempt reached the accept/spec/input
boundary, then the D1 write path became unavailable: renew returned 500,
session refresh returned 401, and both repaired Worker connects returned 503.
After the user-confirmed availability reset, the same existing Task was
allowed to recover normally; it reached three Attempts and terminally failed
with the sanitized `agent_completion.json contains credential-like content`
error and no Artifact. See
`D14/final-regression/gated-live-followup-20260913.md`. This does not close the
Claude/Artifact gate. The retained evidence identifies only the output file;
the Worker cleaned the failed Attempt tree before any raw completion payload
was retained. The narrow offline scanner repair and prompt contract are
recorded in `D14/final-regression/artifact-scanner-repair-20260913.md`.

The first post-repair Worker image was then exercised once with a second
distinct evaluated match. Its sole Attempt renewed normally for about 46
minutes but terminally failed with the same sanitized
`agent_completion.json contains credential-like content` error and no
Artifact. The failed completion payload was cleaned before retention. A second
offline repair parsed completion JSON before scanning decoded values and kept
real credential-field rejection. It was synchronized to a compatible r5 image
and exercised by one final distinct match; that Task again failed at the same
boundary with no Artifact, so this remains a blocked live result rather than a
false-positive or credential finding.

The v3 diagnostic image was then deployed to both Windows Workers as
`infinity-agents-worker:2026.09.13-r6-diagnostics`, digest
`sha256:ae0b3e18a61f1d0ba1de56204f18d5a359b45021cf232cb889316735b6bbfc27`.
One fresh scoped public-data Task
`b73a3306-590d-442f-a76e-55f0008a9a86` succeeded with sole Attempt
`5352cdfb-4efa-4948-91b7-9e2642655631` and exactly one published Artifact.
D1 recorded `result.zip` at 9,625 bytes with SHA-256
`7c2e955b6e6a18abd4fce48fa82b0edcd339eef2be9a19b6665ae44401db5ece`; an
authenticated UI download independently matched both values. This is a
controlled public-data gate pass, not a replacement for the failed
evaluated-match Task.

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
`DISCOVERY_LITERATURE_ENABLED=false`; the four explicitly selected Discovery
Tasks plus one scoped public-data diagnostic Task are retained, with no
duplicate Task or fabricated Artifact.
Remote D1 migrations 0025-0027 are applied, and the final migration listing is
clean. The current Edge deployment is
`9d898d5d-9753-4e14-bf0f-1fb25c829127`. Both isolated Windows Workers are
running with restart count 0 on the diagnostic r6 image digest
`sha256:ae0b3e18a61f1d0ba1de56204f18d5a359b45021cf232cb889316735b6bbfc27`.
The isolated Windows Discovery Processor is running with restart count 0 and digest
`sha256:2bb2a1c1171e28e646006d185a2fc9bab3fb190b3aa1b0778e04194087147496`.

After the follow-up observation, an offline-only hardening pass added bounded
auth behavior for D1 write failures and reinforced the Discovery evidence,
task-read, immutable-source, and deletion gates. It passed the TypeScript
check, the full Edge suite (32 files / 199 tests), and the relevant Python
artifact/security suite (34 tests). It was not live-deployed or used to
reinterpret the blocked Task result; see
`D14/final-regression/auth-discovery-hardening-20260913.md`.
The fresh status-only Windows container inspection is recorded in
`D14/final-regression/windows-processor-status-20260913.md`.

The four selected live Discovery Tasks and one scoped diagnostic Task were
retained without duplicates. The follow-up
Task was visible in Task Center and terminally failed after three Attempts
once normal D1 writes recovered; it has no Artifact and no duplicate Task was
created. The final compatible r5 validation Task also terminally failed with no
Artifact after the image was synchronized; its payload was cleaned before
retention, so the exact scanner match remains unproven. The later r6
public-data diagnostic Task succeeded and its authenticated download matched
the D1 size and SHA-256; no further Task is created under the stop rule.
An existing published Task's authenticated download was independently verified
at 1,234,445 bytes with SHA-256
`1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`.
A bounded Redis-only outage showed Relay hints/health returning 503 while
D1/Worker leases continued; Redis and Relay recovered to 200. No Worker v2
container was stopped.
