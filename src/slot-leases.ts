// CPU slots are a resource of the machine, not of one run. Every run that has a slot gate writes down how many slots it holds; a run that starts while
// others are live takes only what the cores leave over, so two runs on one machine cannot starve each other by both counting all the cores.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

interface Lease {
  pid: number;
  runDir: string;
  slots: number;
}

export interface SlotClaim {
  /** The slots this run may use. */
  slots: number;
  /** What was taken away and why, for the person starting the run; empty when the run got what it asked for. */
  note: string | undefined;
  /** Gives the slots back (when the run ends). */
  release(): void;
}

/** One folder per machine (INFINITY_SLOT_LEASE_DIR moves it, for tests). */
const defaultLeaseDir = (): string => process.env.INFINITY_SLOT_LEASE_DIR || join(tmpdir(), "infinity-slot-leases");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The leases of other live runs on this machine (a lease whose process is gone is removed). */
function liveLeases(dir: string, self: string): Lease[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const leases: Lease[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const lease = JSON.parse(readFileSync(path, "utf8")) as Lease;
      if (name === self) continue;
      if (alive(lease.pid)) leases.push(lease);
      else rmSync(path, { force: true });
    } catch {
      // half written or foreign: not a lease
    }
  }
  return leases;
}

/** Takes up to `wanted` slots, leaving room for the slots of the other live runs on this machine (at least one slot is always given). */
export function claimSlots(wanted: number, runDir: string, options: { dir?: string; cores?: number; pid?: number } = {}): SlotClaim {
  const dir = options.dir ?? defaultLeaseDir();
  const pid = options.pid ?? process.pid;
  const cores = options.cores ?? availableParallelism();
  const name = `${pid}-${runDir.replace(/[^A-Za-z0-9_.-]/g, "_").slice(-80)}.json`;
  const others = liveLeases(dir, name);
  const held = others.reduce((sum, lease) => sum + lease.slots, 0);
  const slots = Math.max(1, Math.min(wanted, cores - held));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ pid, runDir, slots } satisfies Lease));
  } catch {
    // without a lease the other runs simply do not see this one
  }
  const note =
    slots < wanted
      ? `CPU slots: ${slots} instead of ${wanted}, because ${others.length} other run${others.length === 1 ? "" : "s"} on this machine hold${others.length === 1 ? "s" : ""} ${held} of the ${cores} cores (${others.map((lease) => lease.runDir).join(", ")}).`
      : undefined;
  return { slots, note, release: () => rmSync(join(dir, name), { force: true }) };
}
