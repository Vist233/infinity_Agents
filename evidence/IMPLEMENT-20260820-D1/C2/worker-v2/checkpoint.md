# C2 Checkpoint

## Status

**Complete for the local D1-shaped control plane.** Worker v2 is now a real
Cloudflare Worker module with session auth, public-pool routing, D1 CAS/fencing,
R2 input reads, multipart Artifact finalize, and terminal failure/cancel paths.

## Required C3/C4 work

- C3 must provide the minimal HTTPS Redis Relay and fixed signed hint event.
- C4 must replace the Python Worker consumer's direct PostgreSQL/Redis Stream
  data plane with Relay hints plus these v2 endpoints, then remove the old
  production path after its call graph is empty.
- C5 must run against actual D1/R2/zhangbot Redis and real Claude Code Case 2/3.
