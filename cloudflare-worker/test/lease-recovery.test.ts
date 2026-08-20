import { describe, expect, it } from "vitest";
import { recoverExpiredLeases } from "../src/lease-recovery";

type Lease = {
  task_id: string;
  active_attempt_id: string;
  worker_id: string;
  fencing_epoch: number;
  attempt_count: number;
  max_attempts: number;
  cancel_requested_at: number | null;
  task_status: string;
  task_lease_expires_at: number;
  attempt_status: string;
};

class RecoveryFakeD1 {
  constructor(readonly lease: Lease) {}

  prepare(sql: string) {
    return new RecoveryStatement(this.lease, sql);
  }

  async batch(statements: RecoveryStatement[]) {
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
        this.lease.active_attempt_id = "";
        this.lease.task_lease_expires_at = 0;
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
      task_status: "running", task_lease_expires_at: 10, attempt_status: "running",
    });
    expect(await recoverExpiredLeases({ DB: db as never }, 20)).toBe(1);
    expect(db.lease.task_status).toBe("queued");
    expect(db.lease.attempt_status).toBe("expired");
  });

  it("fails an exhausted attempt and cancels a requested task", async () => {
    const exhausted = new RecoveryFakeD1({
      task_id: "task-2", active_attempt_id: "attempt-2", worker_id: "worker-2",
      fencing_epoch: 2, attempt_count: 3, max_attempts: 3, cancel_requested_at: null,
      task_status: "claimed", task_lease_expires_at: 10, attempt_status: "claimed",
    });
    const cancelled = new RecoveryFakeD1({
      task_id: "task-3", active_attempt_id: "attempt-3", worker_id: "worker-3",
      fencing_epoch: 3, attempt_count: 1, max_attempts: 3, cancel_requested_at: 19,
      task_status: "running", task_lease_expires_at: 10, attempt_status: "running",
    });
    expect(await recoverExpiredLeases({ DB: exhausted as never }, 20)).toBe(1);
    expect(await recoverExpiredLeases({ DB: cancelled as never }, 20)).toBe(1);
    expect(exhausted.lease.task_status).toBe("failed");
    expect(cancelled.lease.task_status).toBe("cancelled");
  });
});
