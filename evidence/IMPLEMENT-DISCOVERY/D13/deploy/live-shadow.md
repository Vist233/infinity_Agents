Live authenticated browser shadow (2026-09-12, Chrome; public fixtures only)

- `/data-collections/`: uploaded `infinity-discovery-live-wine-shadow.zip`
  (the public UCI Wine Quality red/white files plus an empty README entry to
  avoid the already-existing content hash). Collection
  `175fc3e5-06f0-4338-bde8-0eb7051ee5e6` reached `ready` and rendered
  `dataset-profile-v1`, 2 CSV files, 1,599/4,898 rows, 12 columns, 22
  features, target `quality`, and no missing values.
- The same collection detail rendered an evaluated match to paper
  `f26a1816-34c0-4f0a-939a-b4504d544977`: match
  `bd74d122-d7fe-4479-90fd-c1bbc12d262f`, status `evaluated`, coverage `100%`.
  Read-only D1 confirmed hard gate `pass`, confidence `100`, scientific fit
  `100`, evaluator `feasibility-v1`, and `created_task_id=null`.
- `/papers/`: the original public arXiv PDF was recognized as a duplicate of
  the existing ready paper. A different public BERT PDF persisted as paper
  `8272108e-5475-41f8-b18d-0c3bb00ad62d`; its Paper Processor attempt
  `06cd4207-2179-4e8e-bc6e-8ef74fc6e9a5` terminated with
  `PAPER_PROCESSOR_RUNTIME_ERROR` / `Paper Processor rejected the resource`.
  The lifecycle fix in `89668c7` now synchronizes this terminal resource
  failure to `paper_catalog` for future failures; this pre-fix disposable row
  remains pending deletion confirmation.
- After the safe-failure Processor release `344a93d` (reviewed runtime commit
  `62e5b7fe4c5a35345c7bc41886ea8ae3e9928228`), a fresh public arXiv ResNet
  PDF (`1512.03385`, SHA-256
  `1e0651b6810ecba34a3dbc5b5b0209226f889004607c1f203540a48d64e5a93a`)
  completed the same path: paper
  `91422e01-f892-4573-89cb-8d5a8e25bdbd`, resource
  `25023afd-ad2f-4b97-b11f-bdc4066e597e`, and attempt
  `fb6bc0cf-4f78-48f4-ac42-f1dce22a2620` are respectively `profiled`, `ready`,
  and `succeeded`; the resource produced `paper-profile-v1`, 12 pages, and 0
  images. This is the successful equivalent retry for the historical BERT
  failure.
- No Task Center or Artifact was created because
  `DISCOVERY_AUTO_EXECUTE=false`.
