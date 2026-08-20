# C4 Lease-Recovery Checkpoint

**Complete.** An expired Worker Attempt is no longer a permanent queue tomb:
the D1 scheduler returns it to the public queue when retryable, or records a
terminal failed/cancelled state, and emits the matching Event/Outbox record in
the same transaction boundary. Cloudflare Edge typecheck and tests are green.
