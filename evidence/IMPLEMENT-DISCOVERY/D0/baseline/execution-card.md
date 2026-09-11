# D0 — Freeze production baseline

Date: 2026-09-11 (Asia/Shanghai)
Status: CONDITIONAL PASS — baseline memory correction verified

Scope was read-only. No deployment, D1 mutation, credential read, secret
value inspection, or source change was performed for this card.

The Discovery migration number in the supplied execution plan is stale: the
current repository already contains migrations through `0022`. This is
recorded for the next card; no migration was added during D0.

The initial combined Python Paper Processor suite exposed an
environment-sensitive, order-dependent RSS failure at the old 192 MiB default.
The separately supplied checkpoint `ea2c243` raises the default to 512 MiB and
retains the 768 MiB hard ceiling. The combined targeted regression was rerun
after that fix and passed (25 passed, 3 skipped). This is recorded as a
conditional baseline because the fix was independent of the Discovery change.
