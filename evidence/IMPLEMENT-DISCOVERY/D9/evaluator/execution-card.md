# D9 — Feasibility Evaluator

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS (policy and failure-path implementation; live provider evaluation not required for deterministic MVP)

`feasibility-v1` consumes bounded Paper Profile, Dataset Profile, coverage, and
an environment summary. The normalized result carries `hard_gate`, coverage,
execution confidence, scientific fit, missing requirements, risks,
recommended, reason, and provenance.

Automatic admission requires `hard_gate=pass`, coverage at least 0.60,
confidence at least 60, and the explicit auto-execute flag. Missing required
capabilities cannot be overruled by a high score. Malformed, timeout, and
provider failures remain retryable and do not create Tasks.
