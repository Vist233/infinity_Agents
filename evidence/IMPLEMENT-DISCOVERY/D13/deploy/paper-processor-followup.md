Paper Processor follow-up (2026-09-12, zhangbot)

- Reviewed runtime commit: `62e5b7fe4c5a35345c7bc41886ea8ae3e9928228`
  (`fix: classify paper processor failures safely`). Release directory and
  active `current` symlink: `344a93d`. Source artifact hash:
  `c694aeb5a8ae6e9a476bce2c7791a80937e632544777d31d0fe0acb9de34a7e8`.
  Pinned dependency lock hash:
  `e7b669892e0e5790179ee84dedd106d04ac40005ca49943059d2ee585f63ff97`.
- The Python 3.10 virtualenv installed the hashed dependency lock
  successfully. The user systemd service passed `systemd-analyze --user
  verify`, restarted onto the release, remained active, and reported
  `NRestarts=0`; the bounded `MemoryHigh=512M`, `MemoryMax=768M`,
  `TasksMax=32`, `Restart=on-failure`, and `KillMode=control-group` settings
  remained in force. No secret values were included in the release record.
- The historical BERT attempt reached `finalizing` after source download,
  PDF extraction, and object publication had completed, then returned the
  old generic `PAPER_PROCESSOR_RUNTIME_ERROR`. The exact remote response was
  unavailable because the pre-fix runtime intentionally discarded protocol
  bodies. The new release reports only bounded stage/family diagnostics and
  never stores a response body or traceback.
- Equivalent post-release retry: public arXiv ResNet 1512.03385, paper
  `91422e01-f892-4573-89cb-8d5a8e25bdbd`, resource
  `25023afd-ad2f-4b97-b11f-bdc4066e597e`, attempt
  `fb6bc0cf-4f78-48f4-ac42-f1dce22a2620`; `paper_catalog=profiled`,
  `paper_resources=ready`, `paper_processing_attempts=succeeded`,
  `paper-profile-v1`, 12 pages, 0 images. This demonstrates that the current
  release accepts a new public PDF end to end; the BERT failure is retained as
  a historical paper-specific/transient incident, not claimed as reproduced.
