# Execution Card P5 / CARD-01 — enforce Goal-Driven runtime failure stages

## Result

The single platform-owned Goal-Driven Prompt now defines exact marker paths
under the attempt `logs/` directory. The direct Claude runtime checks those
markers before accepting exit code zero, bounds marker reads to 8KB, rejects
invalid marker payloads, and emits stable failure codes for marker, startup,
timeout, cancellation, runtime, and non-zero-exit failures. Marker contents are
never copied into the error message.

## Modified files

- `backend/code_agent/worker/claude_runtime.py`
- `tests/test_claude_runtime.py`

## Verification

- `pytest -q tests/test_claude_runtime.py tests/test_goal_driven_cases.py tests/test_unified_runtime_command.py tests/test_security.py` — **27 passed**, exit 0.
- `pytest -q` — **304 passed, 45 skipped**, exit 0.
- `python -m compileall -q backend tests` — exit 0.
- `git diff --check` — exit 0.
- Read-only review by Sagan: marker content is not exposed, zero-exit cannot override a marker, startup/timeout/cancel/runtime/non-zero paths have explicit failure codes; bounded read was then tightened to 8193 bytes.

## Boundary

No task state is changed by the prompt or by Claude's natural-language output.
The existing executor still owns output validation, Artifact publication, and
Task/Attempt finalization.

## External systems

PostgreSQL, Redis, Docker, Cloudflare, and remote repositories were not
modified.
