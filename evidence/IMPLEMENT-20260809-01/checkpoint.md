# CHECKPOINT IMPLEMENT-20260809-01 / S0 / revision-03

- primary executor / resolved model ID: current Codex runtime / exact ID unavailable to workspace
- repository baseline: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- current commit: unchanged; worktree contains only the scoped S0 patches and user-provided untracked docs
- completed cards: `EXEC-S0-01`, `EXEC-S0-02`, `EXEC-S0-03`, `EXEC-S0-04`, `EXEC-S0-05`, `EXEC-S0-06`, `EXEC-S0-07`
- current product behavior: frontend lint/type/unit/build checks are green; backend non-integration baseline is green; real regression tests no longer use a machine-specific path or accept `error` as success; Redis streams and short-lived keys can be scoped per acceptance run; an isolated acceptance compose runs PostgreSQL/Redis/API/frontend on loopback ports; the positive preflight proves zero Tasks/Outbox/stream entries before Workers; all three scientific fixtures have redacted relative contracts and tree hashes
- migrations applied: none
- tests run with exit codes: recorded under both card evidence directories
- failed/skipped tests: integration regression skips when `GOAL_DRIVEN_FIXTURE_ROOT` is unset; no test failure in completed cards
- DB/Redis/Docker/browser state: isolated acceptance PostgreSQL and password-protected Redis are healthy; API and host-built Next frontend are running on loopback ports; Outbox and Workers were not started; existing development services were left untouched
- evidence paths: `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-01/`, `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-02/`, `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-03/`, `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-04/`, `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-05/`, `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-06/`, and `evidence/IMPLEMENT-20260809-01/S0/EXEC-S0-07/`
- known risks and unresolved conflicts: the acceptance compose still exposes the Docker Socket to Workers if they are later enabled; ACL/DB roles/controlled Executor are not implemented; existing product remains at the pre-L1 security baseline; no real provider-backed model execution was attempted
- rollback point: revert the scoped code/config/script patches and remove only
  the acceptance project plus ignored local workspace when cleanup is approved
- next exact card: `EXEC-S0-08` — with explicit approval, start Outbox/Workers and run a deterministic task submission/queue observation using a controlled local Executor or a documented provider-backed fixture
- external state touched: isolated local acceptance containers and ignored workspace only; existing local containers and external services were not changed
- secrets/data exposure: none observed; changed-file scans clean

## revision-04 / local MVP and single-model runbook closure

- backend regression: `238 passed, 1 skipped, 3 deselected`; focused provider, security, task API, verifier, artifact, auth, streaming, and symlink-boundary checks are green
- frontend verification: lint, typecheck, unit tests (`28 passed`), and production build are green
- ImageJudge verification: `49 passed`; trait definitions/observations are versioned and the 500-image batch path is covered
- acceptance path: isolated PostgreSQL/Redis/API/frontend stack on loopback; cookie-authenticated Alice/Bob checks, project-scoped opaque resources, task-spec freeze, atomic submit plus idempotency, namespace-scoped worker processing, verifier rejection, successful artifacts, and artifact ZIP integrity were exercised
- controlled scientific cases: three local fixture cases completed successfully through Task → Outbox → Worker → Verifier → Artifact; five additional independent tasks completed sequentially as a short soak
- artifact boundary: public artifact metadata no longer returns a storage path; archive collection rejects symlink/hardlink/special-file escape and applies deterministic timestamps
- provider boundary: one configurable OpenAI-compatible analysis provider and one configurable Anthropic-compatible coding provider are defined; credentials are excluded from logs and worker inheritance
- not claimed as live proof: external OIDC callback, database-native RLS enforcement, a real provider-backed Claude/Coding gateway run, non-developer browser walkthrough, and the required overnight soak. These require credentials/infra or a scheduled long-running environment not present in this local run
- current state: the acceptance services remain available for follow-up local checks; the controlled fixture worker is the only worker mode exercised in this run

## revision-05 / all local stages after S0

- added real local checks for PKCE-shaped dev OIDC, CSRF, encrypted Provider profiles, OpenAI-compatible Analysis and Anthropic-compatible Coding spies, atomic Task submission, idempotency, unique Worker Redis ACLs, Worker enrollment/revocation, expired-Lease recovery, Artifact download integrity, frontend production build, and ImageJudge’s 500-input batch
- the acceptance Worker has no host Docker Socket mount; its Job runtime receives only Attempt-scoped Claude environment names when configured, never long-lived Provider/DB/Redis/OIDC credentials
- scripts/rls_roles.sql and docs/DB_SECURITY_RUNBOOK.md now define the dedicated non-owner NOBYPASSRLS API/Worker roles, composite project references, forced RLS policies, and explicit request-context contract; the script was applied and exercised successfully on an isolated clean database, while the already-dirty acceptance DB remains unchanged
- detailed stage-by-stage status and exact non-claims are in evidence/IMPLEMENT-20260809-01/complete-local-verification.md
