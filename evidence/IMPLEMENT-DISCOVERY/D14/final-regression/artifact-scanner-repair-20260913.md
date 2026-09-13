# Artifact scanner repair — 2026-09-13

Status: CONDITIONAL — the controlled r6 public-data validation passed the
Claude/Artifact/download gate, but the earlier evaluated-match Task still has
no Artifact and its exact completion payload was not retained. No further
Discovery Task is authorized by this evidence record.

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

This repair was not treated as a live success claim based on offline tests
alone. After the branch push and Worker image refresh, the distinct evaluated
match Tasks below were retained as failed validation records. A later
controlled public-data Task on the deployed diagnostic image supplied the
independent live Claude/Artifact/download evidence recorded at the end of this
document; it does not replace the failed evaluated-match result.

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
was deployed to the compatible r5 Worker image below, but the live validation
still failed with the same sanitized error and no Artifact; this record does
not claim that the failure was a false positive or a real credential finding.

## Final r5 validation Task

After the second repair was pushed, the Windows Workers were synchronized to
the uniquely tagged compatible image
`infinity-agents-worker:2026.09.13-r5-compat`, digest
`sha256:0a9c5ad4eecab27fd5f9ccedd85f5b81992a821796134409e01714041e588ce2`.
The image records scanner source revision `0cd4e6f` and r4 base digest
`sha256:9aa76ec21071427671311a5dc8a4bb3e9992336d4e6c0e9eca64c5efacb64b6a`;
the compatibility base was retained because the running Workers require the
pre-existing DNS allowlist runtime change.

One remaining evaluated match was selected exactly once through the
authenticated UI: `fd2bad8e-a28e-473a-93fb-4bd0bd207790`. It materialized
Task `discovery-task-fd2bad8e-a28e-473a-93fb-4bd0bd207790` with Attempt
`6e176f72-043c-44a3-b22c-f5c43d52102d`. The Task was created at
`2026-09-13 10:06:48` Asia/Shanghai and reached `task_failed` at
`2026-09-13 10:10:57` Asia/Shanghai, with 1/3 Attempts. A bounded D1 read
confirmed the failed Task and Attempt, `result_artifact_id=null`, the same
sanitized error, and `changes=0`/`rows_written=0`. The authenticated UI
displayed the sanitized error `agent_completion.json contains credential-like
content`; no Artifact was published, no retry was clicked, and no duplicate
Task was created.

The compatible r5 image passed a network-free synthetic check that accepts the
escaped safe placeholder case and rejects a credential-labelled value. The
live Task nonetheless failed at the same boundary. Because the Worker deletes
the Attempt tree before retention, the payload and exact matching field/value
remain unavailable. Under the bounded stop rule, this is the terminal
scanner-validation result: the branch and image are synchronized, but the live
Claude/Artifact gate is still BLOCKED and no additional Task is created.

## Deployed-version proof and diagnostic follow-on

Before investigating the identical failure further, bounded read-only checks
were taken on the Windows host. Both Worker containers resolved to
`infinity-agents-worker:2026.09.13-r5-compat`; Worker-1 resolved the image to
digest
`sha256:0a9c5ad4eecab27fd5f9ccedd85f5b81992a821796134409e01714041e588ce2`.
Inside the running Worker-1 container, `backend/security.py` had SHA-256
`4ea02da5325033e30fbd605c0e23155c8b2c04bc635841eba0c9a082244a83e0` and
`claude_runtime.py` had SHA-256
`efb1243ec6ac9d6f6a31a18d15e5c207549a302e3fbf1b03798cfff8e6b71a83`. The
runtime hash exactly matches the file at commit `1862a8a`; the security hash
matches the tested working-tree file, whose only difference from the scanner
repair at `0cd4e6f` is the pre-existing explicit DNS allowlist hunk. The
container reports Claude Code `2.1.226`; the metadata-only and secret-exclusion
prompt markers are present, as are the completion parser, size-bound, and
duplicate-key markers. `backend/app.py` is not in this Worker image by design,
so the relevant live boundary is the Worker-side `ArtifactCollector`.

No Worker environment, raw log, completion payload, or secret was read. This
proves the failed Task did run the repaired r5 Worker-side scanner and the
`1862a8a` runtime; it does not prove whether the removed completion payload
contained a real credential or an as-yet-uncovered false-positive form.

The follow-on repair introduces scanner policy version
`artifact-secret-scan-v3` diagnostics. Rejections emit at most 64 process-local
warnings containing only fixed `rule` and `category` labels (for example,
`completion_metadata`/`credential_field` or
`completion_metadata`/`generic_secret_assignment`); values, field names,
paths, and payloads are not logged. Local deterministic coverage now checks
the pattern and structured-field categories, absence of rejected values from
telemetry, and the event cap. The broad credential patterns and true-secret
rejections are unchanged.

The diagnostic image was then transferred and deployed to both Windows
Workers under the unique tag
`infinity-agents-worker:2026.09.13-r6-diagnostics`. Its digest is
`sha256:ae0b3e18a61f1d0ba1de56204f18d5a359b45021cf232cb889316735b6bbfc27`,
with source revision `0b80e1a` and scanner marker
`artifact-secret-scan-v3`. Both Worker containers were recreated without
dependencies and verified running with restart count 0; the Discovery
Processor was not changed.

## r6 controlled public-data validation

Before the run, a bounded D1 read found zero active Tasks, zero active
Attempts, zero open uploads on active Attempts, zero pending outbox rows, and
zero writes to the result table. A minimal method and the public UCI red-wine
ZIP were used; they contain no credentials, environment reads, or private
inputs. One fresh scoped Task was created once through the authenticated UI:
`b73a3306-590d-442f-a76e-55f0008a9a86`, with sole Attempt
`5352cdfb-4efa-4948-91b7-9e2642655631` and Worker
`public-worker-16dab622-4e3b-4212-bb09-0ed738c45314`. It was created at
`2026-09-13 11:43:49` Asia/Shanghai, claimed at `11:43:50`, and succeeded at
`11:45:55`.

D1 reported exactly one published Artifact for that Attempt:
`d7a03fe6-eed4-4aec-b0b6-f71d03a624f5`, named `result.zip`,
`kind=result_archive`, `file_size_bytes=9625`,
`checksum_sha256=7c2e955b6e6a18abd4fce48fa82b0edcd339eef2be9a19b6665ae44401db5ece`,
`status=published`, and `release_state=published`. Its manifest listed only
the expected metadata/report files and no raw payload. The authenticated Task
Center displayed exactly one Artifact; clicking its `查看` link emitted the
browser download, whose local size and SHA-256 matched those D1 values
exactly. No Artifact contents were read or exported.

This closes the Claude/Artifact/download gate for the controlled public-data
path and demonstrates that the deployed v3 scanner can accept safe completion
metadata while preserving the offline credential rejection tests. It does
not reinterpret either prior sanitized failure, recover their deleted
payloads, or prove the evaluated-match Discovery result. The four selected
Discovery Tasks and this one diagnostic Task are retained; no retry, duplicate
Task, flag change, Literature Watcher round, Kimi call, or cleanup followed.
