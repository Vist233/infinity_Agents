# D10 — Opportunity to existing Task

Date: 2026-09-11 (Asia/Shanghai)
Status: CONDITIONAL PASS (materialization implemented; real Worker execution gate pending)

Discovery materialization reuses the existing Task Center tables and trusted
Task creation function. It freezes a Method Markdown object in R2 and points
the Dataset resource at the Data Collection's immutable source object; it does
not create a second business-data copy.

The idempotency key is
`discovery:{match_id}:{paper_profile_version}:{dataset_profile_version}`.
The hard gate, coverage, confidence, paper/collection status, and version
checks are enforced before materialization. Duplicate retries resolve to the
same Task.
