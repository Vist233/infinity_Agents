# D1 — Additive Discovery D1 schema

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS

Implemented migration `0023_discovery_catalog.sql` and versioned contract
validators for Paper Catalog, Data Collections, capability facts, Research
Matches, the dedicated Discovery Processor session, and literature-watch
cursor state. Existing Chat, Task, Worker v2, Paper Processor, Outbox, and
Artifact tables were not altered.

The migration was verified against a clean SQLite database by applying every
Infinity migration in order. Negative cases cover duplicate paper resource
ownership, duplicate versioned matches, invalid status values, and deletion of
a referenced Paper Resource. Contract tests cover invalid capability keys,
collection identity, malformed profiles, and the exact automatic threshold.
