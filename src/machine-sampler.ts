import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { ComponentContext, RunComponent } from "./component.ts";
import { type Host, LinuxHost } from "./host.ts";
import { JsonlFile } from "./jsonl.ts";
import { optional } from "./machine-summary.ts";
import { unsupportedFeatures } from "./platform.ts";
import { type BrakeLimits, PressureBrake } from "./pressure-brake.ts";
import { MachineReader, type MachineReaderOptions, parseGpuFacts, parseMeminfo } from "./proc-readings.ts";
import type { RunEvent } from "./records.ts";

/** The machine sampler as a run component (docs/18): schedules the readings, writes `machine.jsonl` and `run-facts.json`, and asks the ladder to hold when the brake says so. */
export const SAMPLE_EVERY_MS = 5000;

// ----- what is written once per run -----

/** Facts of the machine and the run, written once at the start (`run-facts.json`). No environment, no address. */
export interface RunFacts {
  ts: number;
  cores: number;
  memTotalMb: number;
  gpuName: string | null;
  gpuMemTotalMb: number | null;
  kernel: string;
  node: string;
  commit: string | null;
  /** The most agents the run may have alive (the ceiling), when the caller knows it. */
  ceiling: number | null;
  /** The command-line flags of the run as given to the program (no environment). */
  commandLine: string[];
  /** The gates (docs/16 section C): whether the CPU gate was on, how many heavy commands and GPU jobs they allowed at once, and the wall limit of one command. */
  gate: GateFacts;
  /** Cores that load other than the run's kept busy at the start (measured, not managed). */
  foreignBusyCores: number | null;
  /** What this machine cannot do that the run needs: lines "unsupported on this OS: <feature>". */
  unsupported: string[];
}

export interface GateFacts {
  enabled: boolean;
  cpuSlots: number | null;
  gpuSlots: number | null;
  commandTimeoutMinutes: number | null;
}

export const NO_GATE: GateFacts = { enabled: false, cpuSlots: null, gpuSlots: null, commandTimeoutMinutes: null };

export async function readRunFacts(
  now: number,
  extra: { ceiling?: number; commandLine?: string[]; gate?: GateFacts; foreignBusyCores?: number; needsGpu?: boolean; host?: Host } = {},
): Promise<RunFacts> {
  const host = extra.host ?? new LinuxHost();
  const [gpuText, commit, unsupported] = await Promise.all([
    host.gpuQuery("--query-gpu=name,memory.total"),
    host.gitCommit(),
    unsupportedFeatures({ gpu: extra.needsGpu === true }),
  ]);
  const gpu = gpuText ? parseGpuFacts(gpuText) : undefined;
  const info = host.readProc("meminfo");
  return {
    ts: now,
    cores: host.cpuCount(),
    memTotalMb: info ? parseMeminfo(info).totalMb : Math.round(host.totalMemoryBytes() / 1048576),
    gpuName: gpu?.name ?? null,
    gpuMemTotalMb: gpu?.memMb ?? null,
    kernel: host.readProc("sys/kernel/osrelease")?.trim() ?? host.release(),
    node: process.version,
    commit: commit?.trim() || null,
    ceiling: extra.ceiling ?? null,
    commandLine: extra.commandLine ?? process.argv.slice(2),
    gate: extra.gate ?? NO_GATE,
    foreignBusyCores: extra.foreignBusyCores ?? null,
    unsupported,
  };
}

// ----- the component -----

export interface MachineSamplerOptions {
  everyMs?: number;
  /** The operating system (default: this Linux machine). */
  host?: Host;
  /** Lines written as warning events at the start (what the user chose that the report should say). */
  notes?: string[];
  /** For tests. */
  reader?: Pick<MachineReader, "read">;
  /** For tests: replaces the reading of the machine and run facts. */
  facts?: () => Promise<RunFacts>;
  /** The run's agent ceiling and command-line flags, when the program that starts the run knows them (the flags default to this program's). */
  ceiling?: number;
  commandLine?: string[];
  gate?: GateFacts;
  /** Cores busy with load that is not the run's, measured before the start (the example's recommendation reads it). */
  foreignBusyCores?: number;
  /** The run has GPU slots, so flock and nvidia-smi are needed. */
  needsGpu?: boolean;
  /** Slots held and waiting, per kind, for machine.jsonl. */
  slots?: MachineReaderOptions["slots"];
  /** Hold the ladder while the machine is over these limits (docs/16 section D). Left out, there is no brake. */
  brake?: BrakeLimits;
}

/** Writes `machine.jsonl` in the run directory every few seconds from the start of the agents to the end of the run. */
export function machineSampler(options: MachineSamplerOptions = {}): RunComponent {
  const stopping = new AbortController();
  let loop: Promise<void> | undefined;
  return {
    name: "machine-sampler",
    start(context: ComponentContext) {
      for (const line of options.notes ?? []) context.note(line);
      const reader =
        options.reader ?? new MachineReader({ runRoot: context.layout.root, ...optional("slots", options.slots), ...optional("host", options.host) });
      const every = options.everyMs ?? SAMPLE_EVERY_MS;
      const factsOf =
        options.facts ??
        (() =>
          readRunFacts(context.clock.now(), {
            ...optional("ceiling", options.ceiling),
            ...optional("commandLine", options.commandLine),
            ...optional("gate", options.gate),
            ...optional("foreignBusyCores", options.foreignBusyCores),
            ...optional("needsGpu", options.needsGpu),
            ...optional("host", options.host),
          }));
      factsOf()
        .then((facts) => {
          writeFileSync(join(context.layout.root, "run-facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
          for (const line of facts.unsupported ?? []) context.note(line);
        })
        .catch((error) => context.note(`run facts: ${error instanceof Error ? error.message : String(error)}`));
      const brake = options.brake ? new PressureBrake(options.brake) : undefined;
      const sample = async () => {
        try {
          const line = await reader.read(context.clock.now(), { rung: context.view.rung(), agents: context.view.agents() });
          appendFileSync(context.layout.machine, `${JSON.stringify(line)}\n`);
          const changed = brake?.update(line);
          if (changed !== undefined) {
            context.hold(changed);
            new JsonlFile<RunEvent>(context.layout.events).append({
              type: "pressure_hold",
              ts: line.ts,
              on: changed,
              rung: line.rung,
              loadPerCore: line.load1 / Math.max(1, line.cores),
              cpuPressure10: line.cpuPressure10,
            });
          }
        } catch (error) {
          context.note(`machine sampler: ${error instanceof Error ? error.message : String(error)}`);
          stopping.abort();
        }
      };
      loop = (async () => {
        await sample();
        while (!stopping.signal.aborted) {
          await sleepOf(context.clock, every, stopping.signal);
          if (stopping.signal.aborted) return;
          await sample();
        }
      })();
    },
    async stop() {
      stopping.abort();
      await loop;
    },
  };
}

const sleepOf = (clock: Clock, ms: number, signal: AbortSignal) => clock.sleep(ms, signal).catch(() => undefined);
