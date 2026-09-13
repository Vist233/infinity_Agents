# Artifact scanner repair — 2026-09-13

Status: BLOCKED — the first offline repair was exercised by one fresh live
Task, which still failed at the completion-metadata scan. A second narrow
offline repair is now complete and still requires one fresh live Task to close
the Claude/Artifact gate.

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

## Post-repair live validation and confirmed scanner mechanism

The Worker image containing commit `1862a8a` and the refreshed r4 compose
configuration was exercised once with the distinct evaluated match
`4a2a16cd-2f7a-4397-b06b-1a7733bac017`. Its Task was
`discovery-task-4a2a16cd-2f7a-4397-b06b-1a7733bac017`; its sole Attempt was
`3f23b26e-9d11-4cf0-8b28-330d0bfcf4ba`. The Attempt was claimed at
`2026-09-13 08:39:20` Asia/Shanghai, renewed normally for approximately 46
minutes, and then ended in `task_failed` / `worker_execution_failed` with the
same sanitized message `agent_completion.json contains credential-like
content`. The authenticated UI and D1 both showed no Artifact. No retry or
duplicate Task was created.

The failed Attempt tree was removed by the Worker before retention, so the
exact completion field/value is still not recoverable and this evidence does
not classify that original value as a real secret. The mechanism is nevertheless
reproducible locally: the generic detector scans the serialized JSON bytes,
while a safe summary such as `token: "not applicable"` is represented with
JSON-escaped quotes (`token: \\\"not applicable\\\"`). The placeholder grammar
accepts the decoded phrase but not that escaped representation, producing the
same credential-like rejection. This is a confirmed false-positive path in the
detector; it is not a claim about the deleted live payload.

The second repair adds a completion-specific boundary. `agent_completion.json`
is size-bounded and parsed with duplicate-key rejection; credential-labelled
fields are allowed only when their values are null, empty, an empty JSON
container, or an explicit bounded non-secret placeholder. Every decoded string
value is still passed through the generic detector, so a real token in a
summary or credential field remains rejected. The archive validator applies
the same decoded check after upload, preserving defense in depth.

The offline artifact/security regression subset now passes 39 tests, including
escaped safe summaries, explicit empty credential-labelled fields, escaped
credential rejection, and direct credential-field rejection. This second repair
has not been deployed or used to claim a live pass; one additional fresh
scoped Task is required only after the branch and Worker image are synchronized.
