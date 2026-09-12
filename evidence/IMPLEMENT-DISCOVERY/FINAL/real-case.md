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

`DISCOVERY_AUTO_EXECUTE=false`, so `created_task_id=null`; no Task, Attempt,
Artifact, or Redis-outage recovery claim is made.

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
