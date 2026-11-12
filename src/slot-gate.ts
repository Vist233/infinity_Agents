import type { Plugin, ToolCall, ToolResult } from "sakura-agent";
import { isLightCommand } from "./command-class.ts";
import type { RunComponent } from "./component.ts";
import { JsonlFile } from "./jsonl.ts";
import { Pool } from "./pool.ts";
import type { RunEvent } from "./records.ts";

/**
 * The CPU slot gate (docs/16 section C): a counted semaphore. A heavy command of any agent holds one slot for its whole life, because the commands of a run never
 * go to the background (see `commandLimits`). Nothing observes processes: the slot is taken before the command starts and given back when it has ended.
 */
export class SlotGate {
  readonly pool: Pool;
  readonly capacity: number;
  readonly stats = { commands: 0, waited: 0, totalWaitMs: 0, maxWaitMs: 0 };
  /** Called after every heavy command got its slot, with the agent and the time it waited (the component writes the events). */
  onWait: ((agent: number, waitMs: number) => void) | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private busyMs = 0;
  private readonly open = new Set<{ since: number }>();

  constructor(capacity: number, now: () => number = Date.now) {
    this.pool = new Pool(capacity);
    this.capacity = capacity;
    this.now = now;
    this.startedAt = now();
  }

  get inUse(): number {
    return this.pool.inUse;
  }

  get waiting(): number {
    return this.pool.waiting;
  }

  /** Busy slot time over all slot time since the gate was made (0 to 1). */
  utilisation(): number {
    const now = this.now();
    const elapsed = now - this.startedAt;
    let busy = this.busyMs;
    for (const hold of this.open) busy += now - hold.since;
    return elapsed > 0 ? busy / (this.capacity * elapsed) : 0;
  }

  /** Runs `work` while holding a slot; the wait is measured and recorded. */
  async run<T>(agent: number, work: () => Promise<T>): Promise<T> {
    const asked = this.now();
    const release = await this.pool.acquire();
    const hold = { since: this.now() };
    this.open.add(hold);
    const waitMs = this.now() - asked;
    this.stats.commands += 1;
    this.stats.totalWaitMs += waitMs;
    this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, waitMs);
    if (waitMs >= 1) this.stats.waited += 1;
    try {
      this.onWait?.(agent, waitMs);
    } catch {
      // recording must never keep a command from running
    }
    try {
      return await work();
    } finally {
      this.busyMs += this.now() - hold.since;
      this.open.delete(hold);
      release();
    }
  }
}

const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

export interface CommandLimitsOptions {
  /** Heavy commands wait here for a slot; left out, no waiting. */
  gate?: SlotGate | undefined;
  /** No command runs longer than this (docs/16 section C); the bash tool stops its whole process group. */
  wallMinutes: number;
  /** The agent's number, for the gate's record. */
  agent: number;
}

/**
 * A plugin on one agent's shell tool. Commands always run in the foreground: `background: true` is refused (and the prompt does not offer it), and the bash tool's
 * own move to the background after a while is switched off by the setup, so a command is a call that ends when the process ends. Every command gets a hard wall
 * limit (the bash tool's `timeout`, which stops the whole process group), so a hung command cannot hold a slot for ever. A heavy command waits for a slot of the gate.
 */
export function commandLimits(options: CommandLimitsOptions): Plugin {
  const wallSeconds = Math.round(options.wallMinutes * 60);
  const argsOf = (call: ToolCall): Record<string, unknown> =>
    typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
  return {
    name: "command-limits",
    setup(api) {
      api.on("tool.before", (call) => {
        if (call.name !== "bash") return;
        const args = argsOf(call);
        if (args.background === true)
          return {
            kind: "deny",
            reason: `Run it in the foreground: commands may run up to ${options.wallMinutes} minutes here, and there is no background mode in this run.`,
          };
        const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : Number.POSITIVE_INFINITY;
        if (asked <= wallSeconds) return;
        return { kind: "rewrite", args: { ...args, timeout: wallSeconds } };
      });
      api.on("tool.run", (call, next) => {
        const command = argsOf(call).command;
        if (call.name !== "bash" || !options.gate || typeof command !== "string" || isLightCommand(command)) return next();
        return options.gate.run(options.agent, next);
      });
      api.on("tool.after", (call, result) => {
        if (call.name !== "bash" || !result.isError || !/Command timed out after/.test(textOf(result))) return;
        return {
          ...result,
          content: [...result.content, { type: "text", text: `(This run stops every command after ${options.wallMinutes} minutes at most.)` }],
        };
      });
    },
  };
}

/**
 * The run's side of the gate: turns the waits into events (`slot_wait` for a wait of a second or more) and, at the end, writes `slot_summary` with the
 * utilisation. The waiting itself is done by the commands in `commandLimits`; the sampler reads `inUse` and `waiting` from the gate.
 */
export function slotGate(gate: SlotGate): RunComponent {
  let write: ((event: RunEvent) => void) | undefined;
  let now: (() => number) | undefined;
  return {
    name: "slot-gate",
    start(context) {
      const events = new JsonlFile<RunEvent>(context.layout.events);
      write = (event) => events.append(event);
      now = () => context.clock.now();
      gate.onWait = (agent, waitMs) => {
        if (waitMs >= 1000) events.append({ type: "slot_wait", ts: context.clock.now(), kind: "cpu", agent, waitMs });
      };
    },
    async stop() {
      gate.onWait = undefined;
      if (!write || !now) return;
      write({ type: "slot_summary", ts: now(), kind: "cpu", slots: gate.capacity, ...gate.stats, utilisation: gate.utilisation() });
      write = undefined;
    },
  };
}
