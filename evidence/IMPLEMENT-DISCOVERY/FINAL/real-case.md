Real production shadow case:

- Paper `f26a1816-34c0-4f0a-939a-b4504d544977`; Paper Resource
  `e10aac13-021f-4903-a074-bfc27f7206c1`; ready/scientific_paper; 5 modules;
  7 pages/2 images; PDF SHA-256
  `f5292f3a0d211db5604177312acc86a43980871326e8c6e2d565a0dcaeafd6cf`.
- Collection `eee1539e-3db6-4117-922b-2c8088131a3a`; ready; red CSV;
  1599 rows/12 columns/11 features; target `quality`; no missing values; source
  SHA-256 `4a402cf041b025d4566d954c3b9ba8635a3a8a01e039005d97d6a710278cf05e`.
- Match `c34f251b-dfbd-4fae-985d-3ff6c0ea6342`; evaluated; hard gate pass;
  coverage 1.0; confidence 100; scientific fit 100; evaluator
  `feasibility-v1`; recommended true.

At the read-only preflight `DISCOVERY_AUTO_EXECUTE=false` and
`created_task_id=null`; the later explicitly scoped live button test is
recorded below. This preflight row was not used to claim a successful Task.

Post-rollout disposable collection shadow:

- Collection `175fc3e5-06f0-4338-bde8-0eb7051ee5e6`; name `Shadow UCI Wine
  Quality`; ready; source `infinity-discovery-live-wine-shadow.zip`;
  `dataset-profile-v1`; SHA-256
  `cdcd8ac23924a64e599ebdddf2b88a25c43ad039b606e6fd2b60cd4afbddfa87`;
  red/white CSVs profiled as 1599/4898 rows and 12 columns.
- Match `bd74d122-d7fe-4479-90fd-c1bbc12d262f`; evaluated; hard gate pass;
  coverage 1.0; execution confidence 100; scientific fit 100; evaluator
  `feasibility-v1`; `created_task_id=null` because auto-execute is disabled.

The original public arXiv PDF followed the duplicate-by-content path. A
different public BERT PDF created disposable paper
`8272108e-5475-41f8-b18d-0c3bb00ad62d`, whose Paper Processor resource
`b7ea841f-97a3-40e7-8953-8474696fcb3e` terminated with
`PAPER_PROCESSOR_RUNTIME_ERROR`; no task or artifact was created.

Paper Processor remediation retry:

- Release `344a93d` / reviewed runtime commit
  `62e5b7fe4c5a35345c7bc41886ea8ae3e9928228` was activated on zhangbot.
- Fresh public arXiv ResNet PDF 1512.03385 (SHA-256
  `1e0651b6810ecba34a3dbc5b5b0209226f889004607c1f203540a48d64e5a93a`)
  created paper `91422e01-f892-4573-89cb-8d5a8e25bdbd`, resource
  `25023afd-ad2f-4b97-b11f-bdc4066e597e`, and attempt
  `fb6bc0cf-4f78-48f4-ac42-f1dce22a2620`. D1 confirmed paper `profiled`,
  profile version `paper-profile-v1`, resource `ready`, attempt `succeeded`,
  12 pages, and 0 images. No Task or Artifact was created.

Scoped live Task gate:

- Task `discovery-task-c34f251b-dfbd-4fae-985d-3ff6c0ea6342` was materialized
  exactly once for the primary match, with one idempotency row and one queued
  event. Task Center rendered it. Three fenced Worker Attempts were claimed,
  but all leases expired before a Claude terminal event or Artifact; final D1
  status was `failed`, `attempt_count=3`, with
  `Worker lease expired; maximum attempts reached`.
- No duplicate Task and no Artifact were created. See
  `D14/final-regression/gated-live-run-20260912.md` for the complete event,
  resource, and hash record.

The deployed configuration intentionally remains `DISCOVERY_AUTO_EXECUTE=false`.
The real matches remain evaluated shadow opportunities with
`created_task_id=null`; the one Task above was created through the explicit
scoped action, not scheduled fanout. The final preflight found six eligible
rows, and the global switch must not be enabled for a one-row test without a
scoped selection. See `evidence/IMPLEMENT-DISCOVERY/FINAL/remaining-gates.md`.

Recovery gate: PASS for Redis/Relay fallback. Only the confirmed user-scoped
Redis unit was stopped briefly. Relay health and hints returned 503, while D1
Task state and Worker leases continued; the same single Task remained fenced.
Redis was restarted, Relay health/hints returned 200, and no duplicate
Task/Attempt appeared. The selected Task's successful Claude/Artifact path
remains open because the Worker leases expired.
