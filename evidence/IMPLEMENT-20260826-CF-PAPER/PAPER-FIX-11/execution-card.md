# PAPER-FIX-11 — Retry continuation and runtime-failure fencing

Reactivate the original continuation only through the audited timeout-retry
path, and map every Processor post-grant unclassified exception to the fenced
`PAPER_PROCESSOR_RUNTIME_ERROR` failure operation. No remote action occurs.
