# D0 checkpoint

Status: CONDITIONAL PASS — baseline memory ceiling corrected in independent checkpoint

Validated:
- existing Edge health and public route reachability;
- authorized SSH/Tunnel reachability and current Windows Docker state;
- existing Cloudflare Worker tests and typecheck;
- existing frontend unit/type/lint/build checks;
- isolated existing Paper Processor smoke and regression checks;
- combined targeted Python regression after the separately supplied memory-budget fix:
  25 passed, 3 skipped.

The initial combined run exposed an environment-sensitive RSS failure at the
old 192 MiB Paper Processor test default. The independent checkpoint
`ea2c243` raised the default to 512 MiB while retaining the 768 MiB hard
ceiling. The targeted combined regression then passed; the condition is kept
in the evidence because the fix was not part of the original D0 code change.

Commit SHA: no D0 commit created. The worktree was already dirty and this
evidence is intentionally left uncommitted until the first Discovery
checkpoint commit can include only Discovery files.

Next gate: D1 additive schema using migration `0023_discovery_catalog.sql`.
