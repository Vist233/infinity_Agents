import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonlFile } from "./jsonl.ts";

/** One line of the journal. The journal is written BEFORE a move, so a crash at any moment can be put right from it. */
type JournalEntry =
  | { type: "plan"; id: string; from: string; to: string; ts: number }
  | { type: "moved"; id: string; ts: number }
  | { type: "restored"; id: string; ts: number };

export class DifferentFilesystemError extends Error {
  constructor(from: string, keeperDir: string) {
    super(`${from} is not on the same filesystem as ${keeperDir}; hidden data is moved by renaming, which needs one filesystem`);
    this.name = "DifferentFilesystemError";
  }
}

export interface KeeperOptions {
  /** A private directory (created, mode 0700) that holds the hidden things under unguessable names and the journal. Never inside an agent's work directory. */
  dir: string;
  /** For tests: which device a path is on (default: `stat().dev`). */
  deviceOf?: (path: string) => number;
  now?: () => number;
}

export interface RestoreReport {
  restored: string[];
  /** Things that could not be put back without overwriting something: both places hold something. Nothing is overwritten or deleted. */
  conflicts: Array<{ from: string; to: string }>;
  /** Plans whose data is nowhere (never moved, or lost by someone else). */
  missing: string[];
}

const JOURNAL = "journal.jsonl";

/**
 * Takes the evaluator and the hidden data away from the places the agents can see while they work, and puts them back afterwards.
 * Moves, never deletes: a rename to `<dir>/<random>`, journalled first. The data stays on disk under a name that cannot be guessed;
 * the evaluator is given that private path. This is not a lock by itself: an agent with a shell and the same rights can still read it unless its shell is confined.
 */
export class HiddenKeeper {
  private readonly dir: string;
  private readonly journal: JsonlFile<JournalEntry>;
  private readonly deviceOf: (path: string) => number;
  private readonly now: () => number;

  constructor(options: KeeperOptions) {
    this.dir = resolve(options.dir);
    this.deviceOf = options.deviceOf ?? ((path) => statSync(path).dev);
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.journal = new JsonlFile<JournalEntry>(join(this.dir, JOURNAL));
  }

  /** Hides each path (a file or a directory). All paths are checked first, so a bad one hides nothing. */
  hide(paths: string[]): void {
    const absolute = paths.map((path) => resolve(path));
    for (const path of absolute) this.check(path);
    for (const from of absolute) {
      const id = randomBytes(16).toString("hex");
      const to = join(this.dir, id);
      this.journal.append({ type: "plan", id, from, to, ts: this.now() });
      renameSync(from, to);
      this.journal.append({ type: "moved", id, ts: this.now() });
    }
  }

  /** Where a hidden thing is now. */
  privatePath(original: string): string {
    const from = resolve(original);
    const open = this.openPlans().find((plan) => plan.from === from);
    if (!open) throw new Error(`${from} is not hidden`);
    return open.to;
  }

  /** Runs `fn` with the private paths of everything hidden: the only moment the data is used. Nothing is moved back and forth. */
  async withHidden<T>(fn: (privatePaths: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    const map = Object.fromEntries(this.openPlans().map((plan) => [plan.from, plan.to]));
    return fn(map);
  }

  /** Puts everything back. Safe to call again and again; synchronous so that it can run in an exit handler. */
  restore(): RestoreReport {
    return restoreFrom(this.journal, this.now);
  }

  /** The journal-based restore for a run that was killed: `new HiddenKeeper({ dir }).restore()` does the same; this needs no instance. */
  static recover(dir: string): RestoreReport {
    const journal = new JsonlFile<JournalEntry>(join(resolve(dir), JOURNAL));
    return restoreFrom(journal, Date.now);
  }

  private check(path: string): void {
    if (!existsSync(path)) throw new Error(`Cannot hide ${path}: it does not exist`);
    if (this.openPlans().some((plan) => plan.from === path)) throw new Error(`Cannot hide ${path}: it is already hidden`);
    if (isInside(path, this.dir) || isInside(this.dir, path)) throw new Error(`Cannot hide ${path}: it overlaps the keeper directory ${this.dir}`);
    if (this.deviceOf(path) !== this.deviceOf(this.dir)) throw new DifferentFilesystemError(path, this.dir);
  }

  private openPlans() {
    return openPlans(this.journal);
  }
}

function isInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function openPlans(journal: JsonlFile<JournalEntry>) {
  const entries = journal.readAll();
  const restored = new Set(entries.filter((entry) => entry.type === "restored").map((entry) => entry.id));
  return entries.filter((entry): entry is Extract<JournalEntry, { type: "plan" }> => entry.type === "plan" && !restored.has(entry.id));
}

/** Decides from the files themselves, not from what the journal hopes: a crash can happen between the journal line and the rename. */
function restoreFrom(journal: JsonlFile<JournalEntry>, now: () => number): RestoreReport {
  const report: RestoreReport = { restored: [], conflicts: [], missing: [] };
  for (const plan of openPlans(journal).reverse()) {
    const hidden = existsSync(plan.to);
    const original = existsSync(plan.from);
    if (hidden && !original) {
      renameSync(plan.to, plan.from);
      journal.append({ type: "restored", id: plan.id, ts: now() });
      report.restored.push(plan.from);
    } else if (hidden && original) {
      report.conflicts.push({ from: plan.from, to: plan.to });
    } else if (original) {
      journal.append({ type: "restored", id: plan.id, ts: now() }); // the crash came before the move: nothing was ever hidden
    } else {
      report.missing.push(plan.from);
    }
  }
  return report;
}

export interface ProcessGuard {
  /** Stops watching (the keeper stays as it is). */
  dispose(): void;
}

/** The parts of `process` the guard uses, so that a test can stand in for it. */
export interface ProcessLike {
  readonly pid: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  exit(code: number): unknown;
  stderr: { write(text: string): unknown };
}

/**
 * Restores on a normal exit, on SIGINT and SIGTERM, and on an uncaught exception. After a signal it removes its own handler and sends the same
 * signal again, so the process ends the way it would have. SIGKILL and a power loss cannot be caught: `HiddenKeeper.recover(dir)` handles those.
 */
export function restoreOnExit(keeper: HiddenKeeper, target: ProcessLike = process): ProcessGuard {
  const restore = () => {
    try {
      keeper.restore();
    } catch (error) {
      target.stderr.write(`hidden-keeper: restore failed: ${String(error)}\n`);
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    restore();
    target.off("SIGINT", onSignal);
    target.off("SIGTERM", onSignal);
    target.kill(target.pid, signal);
  };
  const onUncaught = (error: Error) => {
    restore();
    target.stderr.write(`${error.stack ?? String(error)}\n`);
    target.exit(1);
  };
  target.on("exit", restore);
  target.on("SIGINT", onSignal);
  target.on("SIGTERM", onSignal);
  target.on("uncaughtException", onUncaught);
  return {
    dispose() {
      target.off("exit", restore);
      target.off("SIGINT", onSignal);
      target.off("SIGTERM", onSignal);
      target.off("uncaughtException", onUncaught);
    },
  };
}
