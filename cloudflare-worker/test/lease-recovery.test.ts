import { describe, expect, it } from "vitest";
import { recoverExpiredLeases } from "../src/lease-recovery";

type Lease = {
  task_id: string;
  active_attempt_id: string | null;
  worker_id: string;
  fencing_epoch: number;
  attempt_count: number;
  max_attempts: number;
  cancel_requested_at: number | null;
  task_status: string;
  task_lease_expires_at: number | null;
  lease_worker_id: string | null;
  lease_claim_id: string | null;
  lease_namespace: string | null;
  lease_token_hash: string | null;
  attempt_status: string;
};

class RecoveryFakeD1 {
  failBatch = false;

  constructor(readonly lease: Lease) {}

  prepare(sql: string) {
    return new RecoveryStatement(this.lease, sql);
  }

  async batch(statements: RecoveryStatement[]) {
    if (this.failBatch) throw new Error("simulated D1 outage");
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class RecoveryStatement {
  private args: unknown[] = [];

  constructor(private readonly lease: Lease, private readonly sql: string) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    if (this.sql.includes("FROM tasks t") && this.sql.includes("JOIN task_attempts")) {
      return { results: [this.lease as T] };
    }
    return { results: [] as T[] };
  }

  async run() {
    const compact = this.sql.replace(/\s+/g, " ");
    if (compact.includes("UPDATE task_attempts")) {
      if (this.lease.attempt_status !== "expired") this.lease.attempt_status = "expired";
      return { meta: { changes: 1 } };
    }
    if (compact.includes("UPDATE tasks")) {
      const nextStatus = String(this.args[1]);
      if (this.lease.task_status === "claimed" || this.lease.task_status === "running") {
        this.lease.task_status = nextStatus;
        this.lease.active_attempt_id = null;
        this.lease.lease_worker_id = null;
        this.lease.task_lease_expires_at = null;
        this.lease.lease_claim_id = null;
        this.lease.lease_namespace = null;
        this.lease.lease_token_hash = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 1 } };
  }
}

describe("D1 expired lease recovery", () => {
  it("requeues an expired public attempt when retries remain", async () => {
    const db = new RecoveryFakeD1({
      task_id: "task-1", active_attempt_id: "attempt-1", worker_id: "worker-1",
      fencing_epoch: 1, attempt_count: 1, max_attempts: 3, cancel_requested_at: null,
      task_status: "running", task_lease_expires_at: 10, lease_worker_id: "worker-1",
      lease_claim_id: "claim-1", lease_namespace: "infinity-public", lease_token_hash: "hash-1", attempt_status: "running",
    });
    expect(await recoverExpiredLeases({ DB: db as never }, 20)).toBe(1);
    expect(db.lease.task_status).toBe("queued");
    expect(db.lease.attempt_status).toBe("expired");
    expect(db.lease).toMatchObject({
      active_attempt_id: null,
      lease_worker_id: null,
      task_lease_expires_at: null,
      lease_claim_id: null,
      lease_namespace: null,
      lease_token_hash: null,
    });
    expect(db.lease.fencing_epoch).toBe(1);
  });

  it("fails an exhausted attempt and cancels a requested task", async () => {
    const exhausted = new RecoveryFakeD1({
      task_id: "task-2", active_attempt_id: "attempt-2", worker_id: "worker-2",
      fencing_epoch: 2, attempt_count: 3, max_attempts: 3, cancel_requested_at: null,
      task_status: "claimed", task_lease_expires_at: 10, lease_worker_id: "worker-2",
      lease_claim_id: "claim-2", lease_namespace: "infinity-public", lease_token_hash: "hash-2", attempt_status: "claimed",
    });
    const cancelled = new RecoveryFakeD1({
      task_id: "task-3", active_attempt_id: "attempt-3", worker_id: "worker-3",
      fencing_epoch: 3, attempt_count: 1, max_attempts: 3, cancel_requested_at: 19,
      task_status: "running", task_lease_expires_at: 10, lease_worker_id: "worker-3",
      lease_claim_id: "claim-3", lease_namespace: "infinity-public", lease_token_hash: "hash-3", attempt_status: "running",
    });
    expect(await recoverExpiredLeases({ DB: exhausted as never }, 20)).toBe(1);
    expect(await recoverExpiredLeases({ DB: cancelled as never }, 20)).toBe(1);
    expect(exhausted.lease.task_status).toBe("failed");
    expect(cancelled.lease.task_status).toBe("cancelled");
    expect(exhausted.lease).toMatchObject({ lease_worker_id: null, lease_claim_id: null, lease_namespace: null, lease_token_hash: null });
    expect(cancelled.lease).toMatchObject({ lease_worker_id: null, lease_claim_id: null, lease_namespace: null, lease_token_hash: null });
  });

  it("leaves an expired candidate fenced for the next scheduler tick when D1 is unavailable", async () => {
    const db = new RecoveryFakeD1({
      task_id: "task-transient", active_attempt_id: "attempt-transient", worker_id: "worker-transient",
      fencing_epoch: 1, attempt_count: 1, max_attempts: 3, cancel_requested_at: null,
      task_status: "running", task_lease_expires_at: 10, lease_worker_id: "worker-transient",
      lease_claim_id: "claim-transient", lease_namespace: "infinity-public", lease_token_hash: "hash-transient", attempt_status: "running",
    });
    db.failBatch = true;

    expect(await recoverExpiredLeases({ DB: db as never }, 20)).toBe(0);
    expect(db.lease.task_status).toBe("running");
    expect(db.lease.attempt_status).toBe("running");
  });
});
