# C3 Checkpoint

## Status

Complete locally. The Relay and D1 outbox boundary are implemented and tested.

## Required C4 work

- Implement a Worker v2 HTTPS client and replace the Python consumer's direct
  PostgreSQL/Redis Stream path.
- Use Relay hints only as wake-up signals; D1 Worker v2 remains authoritative
  for poll, claim, lease, input, and artifact operations.
- Remove the old production PostgreSQL/Redis client call graph after the new
  consumer tests prove it is unused.
