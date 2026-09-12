# D3 — Paper Profile Compiler and document gate

Date: 2026-09-12 (Asia/Shanghai)
Status: CONDITIONAL PASS

Implemented `paper-profile-v1`, deterministic document classification, bounded
profile compilation, evidence locators, strict normalization, and the optional
JSON-only Moonshot adapter. Paper text is treated as untrusted data and cannot
override the compiler goal.

The production paper smoke used the deterministic compiler and reached
`scientific_paper`, `profiled`, and five analysis modules with a persisted
profile and overview. A live external model-provider call was not enabled;
the model adapter remains covered by local contract tests.
