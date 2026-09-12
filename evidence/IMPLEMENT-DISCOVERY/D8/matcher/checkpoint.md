Status: PASS for local implementation and regression coverage.

The candidate layer is deliberately not a Task admission layer. D9 owns the
hard gate and confidence threshold; D10 owns idempotent materialization.

Commit carrying the implementation: c2733c4 (landed on cf-deploy as part of
the reviewed Discovery commit series).
