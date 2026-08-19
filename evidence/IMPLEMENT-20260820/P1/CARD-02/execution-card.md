# Execution Card P1 / CARD-02 — server-owned public Worker issuance

## Outcome

The authenticated enrollment request is now an empty, strict request model.
The control plane generates a unique `public-worker-<UUID>` ID and takes the
Namespace from `WORKER_PUBLIC_NAMESPACE` or the configured `REDIS_NAMESPACE`.
The response no longer exposes a trust tier. The requesting account is an
audit actor, not a Namespace or task-execution boundary.

The old database trust column and lower-level issuer arguments remain only as
a migration compatibility boundary for the next credential/schema card; the
new HTTP path never accepts or derives a user-selected trust value.

## Scope

- `backend/app.py`
- `backend/worker_enrollment.py`
- `backend/code_agent/worker/consumer.py`
- enrollment/task-draft regression tests

## Exit criteria

- No browser request can submit a Worker ID, Namespace, Pool, provider, or
  trust field to the create endpoint.
- Multiple requests create independent server-generated Worker IDs.
- The Worker runtime logs only public-cluster authentication and does not
  depend on a trust label.
