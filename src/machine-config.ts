import { readFileSync, writeFileSync } from "node:fs";
import type { Capacity } from "./capacity.ts";
import type { LaunchOptions } from "./launch.ts";

/**
 * What one computer can carry, as a small file: made by `infinity recommend --write machine.json`, read by `infinity run --machine machine.json`. It holds the
 * same choices as the flags (the flags always win over the file). It belongs to the machine, not to the task: the same task form runs on any machine file.
 */
export interface MachineConfig {
  /** How many agents to run (the top of the ladder). */
  agents?: number;
  /** Heavy commands at once (the CPU slot gate). */
  slots?: number;
  /** Threads one command may use. */
  threads?: number;
  /** Memory one command may use, in GB. */
  memGb?: number;
  /** The share of an agent's time spent in heavy commands. */
  heavyShare?: number;
  /** The longest a single command may run, in minutes. */
  commandMinutes?: number;
}

const KEYS = ["agents", "slots", "threads", "memGb", "heavyShare", "commandMinutes"] as const;

/** The file's content, checked: unknown fields and numbers that are not above 0 are refused with words. */
export function parseMachineConfig(text: string): MachineConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the machine file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the machine file must be a JSON object");
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "note") continue;
    if (!(KEYS as readonly string[]).includes(key)) problems.push(`unknown field '${key}' (fields: ${KEYS.join(", ")})`);
    else if (!(typeof value === "number" && value > 0)) problems.push(`${key} must be a number above 0`);
  }
  if (problems.length > 0) throw new Error(`the machine file: ${problems.join("; ")}`);
  return raw as MachineConfig;
}

export const readMachineConfig = (path: string): MachineConfig => parseMachineConfig(readFileSync(path, "utf8"));

/** The launch options the file stands for (`gate: number` is the slot count). */
export function machineOptions(config: MachineConfig): Partial<LaunchOptions> {
  return {
    ...(config.agents === undefined ? {} : { agents: config.agents }),
    ...(config.slots === undefined ? {} : { gate: config.slots }),
    ...(config.threads === undefined ? {} : { threads: config.threads }),
    ...(config.memGb === undefined ? {} : { memGb: config.memGb }),
    ...(config.heavyShare === undefined ? {} : { heavyShare: config.heavyShare }),
    ...(config.commandMinutes === undefined ? {} : { commandMinutes: config.commandMinutes }),
  };
}

/** The file for this machine from a recommendation: what the capacity logic concluded, with the per-command limits it was computed from. */
export function machineConfigFrom(capacity: Capacity, profile: { threadsPerJob: number; memPerJobGb: number; heavyShare: number }): MachineConfig {
  return { agents: capacity.agents, slots: capacity.cpuSlots, threads: profile.threadsPerJob, memGb: profile.memPerJobGb, heavyShare: profile.heavyShare };
}

export const writeMachineConfig = (path: string, config: MachineConfig, note: string): void =>
  writeFileSync(path, `${JSON.stringify({ note, ...config }, null, 2)}\n`);
