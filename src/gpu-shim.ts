import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binDirOf, gpuLocksDirOf } from "./run-layout.ts";
import type { RunComponent } from "./component.ts";
import { JsonlFile } from "./jsonl.ts";
import type { RunEvent } from "./records.ts";

/**
 * GPU slots (docs/16 section C): a GPU job is started as `gpu <command>`. The shim takes one of N lock files with flock (N = the GPU slots, files under the run
 * directory), sets CUDA_VISIBLE_DEVICES to the GPU of that slot (file descriptor 9 holds the lock; the command inherits it, so the slot lasts as long as anything started by the command), runs the command and gives the slot back when it ends. The agents' commands start with no GPU
 * visible, so a command without the shim sees none. The CPU slot of the surrounding bash command is held as usual; the order is always the GPU lock inside the
 * command, never the reverse. Linux only (flock).
 */
export { binDirOf as gpuBinDirOf, gpuLocksDirOf as gpuDirOf } from "./run-layout.ts";

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The text of the shim. `slotMap` has one GPU index per slot. */
export function gpuShimText(options: { dir: string; slotMap: readonly number[] }): string {
  return `#!/bin/bash
# gpu <command> [args...]: wait for a GPU slot, run the command with that GPU visible, give the slot back when it ends.
if [ $# -eq 0 ]; then echo "usage: gpu <command> [args...]" >&2; exit 2; fi
dir=${quote(options.dir)}
gpus=(${options.slotMap.join(" ")})
n=\${#gpus[@]}
agent=\${INFINITY_AGENT:-0}
now() { date +%s%3N; }
note() { printf '%s\\n' "$1" >> "$dir/events.jsonl"; }
note "{\\"e\\":\\"request\\",\\"t\\":$(now),\\"p\\":$$,\\"a\\":$agent}"
while :; do
  for ((i = 0; i < n; i++)); do
    exec 9>>"$dir/slot$i"
    if flock -n 9; then
      note "{\\"e\\":\\"grant\\",\\"t\\":$(now),\\"p\\":$$,\\"a\\":$agent,\\"gpu\\":\${gpus[$i]}}"
      CUDA_VISIBLE_DEVICES=\${gpus[$i]} "$@"
      code=$?
      note "{\\"e\\":\\"end\\",\\"t\\":$(now),\\"p\\":$$}"
      exit $code
    fi
    exec 9>&-
  done
  sleep 0.2
done
`;
}

export interface GpuLine {
  e: "request" | "grant" | "end";
  t: number;
  p: number;
  a?: number;
  gpu?: number;
}

/** What the shim's log says now: jobs holding a slot, jobs waiting, and the totals for the summary. */
export class GpuLedger {
  readonly capacity: number;
  readonly stats = { commands: 0, waited: 0, totalWaitMs: 0, maxWaitMs: 0 };
  private readonly asked = new Map<number, number>();
  private readonly granted = new Map<number, number>();
  private busyMs = 0;
  private first: number | undefined;
  private last = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get inUse(): number {
    return this.granted.size;
  }

  get waiting(): number {
    return this.asked.size;
  }

  /** Feeds one line; returns the wait in ms when the line was a grant. */
  feed(line: GpuLine): number | undefined {
    this.first ??= line.t;
    this.last = Math.max(this.last, line.t);
    if (line.e === "request") {
      this.asked.set(line.p, line.t);
      return undefined;
    }
    if (line.e === "grant") {
      const waitMs = Math.max(0, line.t - (this.asked.get(line.p) ?? line.t));
      this.asked.delete(line.p);
      this.granted.set(line.p, line.t);
      this.stats.commands += 1;
      this.stats.totalWaitMs += waitMs;
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, waitMs);
      if (waitMs >= 1000) this.stats.waited += 1;
      return waitMs;
    }
    const start = this.granted.get(line.p);
    if (start !== undefined) this.busyMs += line.t - start;
    this.granted.delete(line.p);
    return undefined;
  }

  /** Busy slot time over all slot time between the first and the last line (0 to 1); jobs still running count up to the last line. */
  utilisation(): number {
    const span = this.last - (this.first ?? this.last);
    if (span <= 0) return 0;
    const open = [...this.granted.values()].reduce((sum, start) => sum + (this.last - start), 0);
    return (this.busyMs + open) / (this.capacity * span);
  }
}

/** Complete lines of a file after `offset` bytes, and the new offset. */
export function readNewLines(path: string, offset: number): { lines: GpuLine[]; offset: number } {
  if (!existsSync(path)) return { lines: [], offset };
  const text = readFileSync(path, "utf8");
  const end = text.lastIndexOf("\n") + 1;
  const lines: GpuLine[] = [];
  for (const raw of text.slice(offset, end).split("\n")) {
    try {
      if (raw.trim() !== "") lines.push(JSON.parse(raw) as GpuLine);
    } catch {
      // a damaged line
    }
  }
  return { lines, offset: Math.max(offset, end) };
}

export interface GpuShimOptions {
  /** One GPU index per slot (`Capacity.gpuSlotMap`). */
  slotMap: readonly number[];
  everyMs?: number;
  /** Shares the ledger with the machine sampler (slots in use and waiting). */
  ledger?: GpuLedger;
}

/** Writes `bin/gpu` into the run directory, follows the shim's log, writes `slot_wait` (kind gpu) events and a summary at the end. */
export function gpuShim(options: GpuShimOptions): RunComponent {
  const ledger = options.ledger ?? new GpuLedger(options.slotMap.length);
  const stopping = new AbortController();
  let loop: Promise<void> | undefined;
  let finish: (() => void) | undefined;
  return {
    name: "gpu-shim",
    start(context) {
      const root = context.layout.root;
      const dir = gpuLocksDirOf(root);
      mkdirSync(dir, { recursive: true });
      mkdirSync(binDirOf(root), { recursive: true });
      const shim = join(binDirOf(root), "gpu");
      writeFileSync(shim, gpuShimText({ dir, slotMap: options.slotMap }));
      chmodSync(shim, 0o755);
      const events = new JsonlFile<RunEvent>(context.layout.events);
      const log = join(dir, "events.jsonl");
      let offset = 0;
      const drain = () => {
        const next = readNewLines(log, offset);
        offset = next.offset;
        for (const line of next.lines) {
          const waitMs = ledger.feed(line);
          if (waitMs !== undefined && waitMs >= 1000) events.append({ type: "slot_wait", ts: context.clock.now(), kind: "gpu", agent: line.a ?? 0, waitMs });
        }
      };
      finish = () => {
        drain();
        events.append({
          type: "slot_summary",
          ts: context.clock.now(),
          kind: "gpu",
          slots: ledger.capacity,
          ...ledger.stats,
          utilisation: ledger.utilisation(),
        });
      };
      loop = (async () => {
        while (!stopping.signal.aborted) {
          await context.clock.sleep(options.everyMs ?? 2000, stopping.signal).catch(() => undefined);
          if (!stopping.signal.aborted) drain();
        }
      })();
    },
    async stop() {
      stopping.abort();
      await loop;
      finish?.();
      finish = undefined;
    },
  };
}
