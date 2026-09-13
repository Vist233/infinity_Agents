# Artifact scanner repair — 2026-09-13

Status: offline repair complete; one fresh live Task is required to validate
the Worker image and close the Claude/Artifact gate.

## Evidence boundary

The failed live Task exposed only the sanitized error
`agent_completion.json contains credential-like content`. The Worker removes
the Attempt working tree after failure, and no Artifact or manifest was
published. Therefore the exact field/value that matched is not recoverable
from the retained evidence. This record does not claim that the original
match was a real credential or a false positive.

The source path is deterministic: Claude is instructed to write
`agent_completion.json`; `executor_v2` calls `ArtifactCollector.collect`; the
collector scans every regular output file with the shared secret detector;
the resulting `SecurityBoundaryError` is recorded as the sanitized
`worker_execution_failed` message. No raw output, provider credential, or
response body was exported.

## Minimal repair

The generic detector still rejects credential-shaped values, including
`token: do-not-publish-this`, `sk-...`/`pk-...` tokens, provider environment
assignments, and database connection URLs. The non-secret exception is limited
to explicit placeholder/status values: null/empty values, empty JSON
containers, none/N/A/unknown/missing/unset/redacted-style markers, and
bounded “not applicable/available/used/configured/required” forms, including
their common quoting or bracket wrappers. A suffix attached to a placeholder
continues to fail closed.

The platform prompt now defines `agent_completion.json` as metadata only:
task identifiers, status, relative output paths, and scientific summary. It
explicitly forbids provider configuration, environment variables, API keys,
tokens, passwords, secrets, authorization data, and copied command output.

## Offline verification

The regression suite covers the historical negative metadata wording, wrapped
and empty non-secret completion metadata, an attached-suffix rejection, and a
real credential-shaped rejection. The Claude runtime test asserts that the
metadata-only contract is present in the generated prompt. The existing
successful reference completion schema remains compatible with the collector.

This repair is not a live success claim. After the branch push and Worker
image refresh, exactly one distinct scoped Task may be created; its own Claude
terminal event, single published Artifact, and UI download hash/size must be
verified before any later gate is considered.
