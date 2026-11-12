/** How many agents a machine can carry for a task, as a number the user sees before the run (docs/16 section A). A hint: nothing applies it by itself. */

/** What the machine offers. */
export interface MachineFacts {
  cores: number;
  /** Cores busy with load that is not the run's (measured at the start; not managed, only subtracted). Default 0. */
  busyCores?: number;
  /** Memory that is free now (available, not total), in MB. */
  freeMemMb: number;
  /** Video memory of each GPU in MB, in the order of the GPUs; left out or empty without one. */
  gpuMemMb?: readonly number[];
}

/** What one heavy command of an agent needs on the CPU. */
export interface CpuProfile {
  /** Threads one job uses (default 2). */
  threadsPerJob?: number;
  /** Memory one job needs, in GB (default 3). */
  memPerJobGb?: number;
  /** The share of its time an agent runs a heavy command instead of waiting for the model, above 0 and up to 1 (default 0.5). */
  heavyShare?: number;
}

/** What one GPU job needs. */
export interface GpuProfile {
  /** Video memory one job needs, in GB. */
  vramPerJobGb: number;
  /** The share of its time an agent runs a GPU job (default 0.5). */
  heavyShare?: number;
  /** The most jobs on one GPU at once, whatever the memory allows (default: as many as the memory allows). */
  maxJobsPerGpu?: number;
}

/** Written by the task author. Default kind is "cpu"; a "gpu" task also needs `gpu`. */
export interface TaskProfile {
  kind?: "cpu" | "gpu";
  cpu?: CpuProfile;
  gpu?: GpuProfile;
}

/** Measured in an earlier run of the same user and task (from machine.jsonl); replaces the profile where given. */
export interface History {
  /** Mean CPU cores one agent used. */
  cpuPerAgent?: number;
  /** Peak memory one agent used, in GB. */
  memPerAgentGb?: number;
  /** The share of the time an agent ran a heavy command. */
  heavyShare?: number;
  /** The rung where the score rate stopped improving, once known. */
  plateauRung?: number;
}

export type CapacityLimit = "cores" | "memory" | "gpu" | "plateau" | "default";

export interface Capacity {
  /** Heavy CPU commands the machine can run at once (what the gate of a run allows). */
  cpuSlots: number;
  /** GPU jobs that can run at once, summed over the GPUs; 0 for a CPU task. */
  gpuSlots: number;
  /** The GPU index of each GPU slot (a GPU with room for two jobs appears twice). */
  gpuSlotMap: number[];
  /** The recommended number of agents. */
  agents: number;
  /** More agents than this add nothing (twice the recommendation). */
  maxUseful: number;
  source: "default" | "profile" | "history";
  /** What decided the number of CPU slots. */
  limitedBy: CapacityLimit;
  byCores: number | null;
  byMemory: number | null;
  /** The agents the GPU kind alone would call for (null for a CPU task). */
  agentsByGpu: number | null;
}

export const MEMORY_RESERVE_GB = 8;
/** The owner wants the machine kept full: a little more agents than slots, so the queue is never empty. */
export const FILL_FACTOR = 1.25;
export const PROFILE_DEFAULTS = { threadsPerJob: 2, memPerJobGb: 3, heavyShare: 0.8 } as const;

/** The CPU part of a profile with its defaults. */
export const cpuOf = (profile?: TaskProfile): Required<CpuProfile> => ({ ...PROFILE_DEFAULTS, ...profile?.cpu });

/** The problems of a profile, as words; empty when it is fine. */
export function profileProblems(profile: TaskProfile): string[] {
  const problems: string[] = [];
  const cpu = profile.cpu;
  if (cpu?.threadsPerJob !== undefined && !(cpu.threadsPerJob >= 1)) problems.push("profile.cpu.threadsPerJob must be at least 1");
  if (cpu?.memPerJobGb !== undefined && !(cpu.memPerJobGb > 0)) problems.push("profile.cpu.memPerJobGb must be positive");
  if (cpu?.heavyShare !== undefined && !(cpu.heavyShare > 0 && cpu.heavyShare <= 1)) problems.push("profile.cpu.heavyShare must be above 0 and at most 1");
  if (profile.kind !== undefined && profile.kind !== "cpu" && profile.kind !== "gpu") problems.push("profile.kind must be 'cpu' or 'gpu'");
  if (profile.kind === "gpu" && !profile.gpu) problems.push("profile.gpu is required with kind 'gpu'");
  const gpu = profile.gpu;
  if (gpu) {
    if (!(gpu.vramPerJobGb > 0)) problems.push("profile.gpu.vramPerJobGb must be positive");
    if (gpu.heavyShare !== undefined && !(gpu.heavyShare > 0 && gpu.heavyShare <= 1)) problems.push("profile.gpu.heavyShare must be above 0 and at most 1");
    if (gpu.maxJobsPerGpu !== undefined && !(Number.isInteger(gpu.maxJobsPerGpu) && gpu.maxJobsPerGpu >= 1))
      problems.push("profile.gpu.maxJobsPerGpu must be a whole number, at least 1");
  }
  return problems;
}

const slots = (value: number): number => Math.max(1, Math.floor(value));
const agentsFor = (jobSlots: number, heavyShare: number): number => Math.max(1, Math.ceil((jobSlots / heavyShare) * FILL_FACTOR));

/** GPU index of every GPU slot: per GPU the smaller of `maxJobsPerGpu` and what its memory holds (a GPU that holds no job gives none). */
export function gpuSlotMapOf(gpuMemMb: readonly number[], gpu: GpuProfile): number[] {
  const map: number[] = [];
  gpuMemMb.forEach((memMb, index) => {
    const fits = Math.floor(memMb / 1024 / gpu.vramPerJobGb);
    for (let job = 0; job < Math.min(gpu.maxJobsPerGpu ?? fits, fits); job += 1) map.push(index);
  });
  return map;
}

/**
 * CPU slots = free cores (the cores minus foreign load) / threads per job, cut by memory (free memory minus a reserve for the system, over memory per job).
 * Agents = slots / heavy share, with a quarter more so the queue is never empty. A GPU task takes the smaller of that and the GPU kind's own number.
 * Without a profile and without history the answer is one agent per core. The goal is a full machine at the ceiling, not headroom.
 */
export function recommendCapacity(facts: MachineFacts, profile?: TaskProfile, history?: History): Capacity {
  const empty = { gpuSlots: 0, gpuSlotMap: [] as number[], agentsByGpu: null };
  const result = (cpuSlots: number, agents: number, rest: Pick<Capacity, "source" | "limitedBy" | "byCores" | "byMemory"> & Partial<Capacity>): Capacity => {
    const final = Math.max(1, Math.round(agents));
    return { ...empty, cpuSlots: Math.max(1, Math.round(cpuSlots)), agents: final, maxUseful: 2 * final, ...rest };
  };
  const freeGb = facts.freeMemMb / 1024;
  const available = Math.max(1, facts.cores - (facts.busyCores ?? 0));
  if (history && (history.cpuPerAgent !== undefined || history.memPerAgentGb !== undefined)) {
    const byCores = history.cpuPerAgent && history.cpuPerAgent > 0 ? slots(available / history.cpuPerAgent) : null;
    const byMemory = history.memPerAgentGb && history.memPerAgentGb > 0 ? slots((freeGb - MEMORY_RESERVE_GB) / history.memPerAgentGb) : null;
    const limits: Array<[CapacityLimit, number]> = [];
    if (byCores !== null) limits.push(["cores", byCores]);
    if (byMemory !== null) limits.push(["memory", byMemory]);
    if (history.plateauRung !== undefined) limits.push(["plateau", history.plateauRung]);
    // a history with no usable figure (for example zero CPU per agent in the first seconds of a run) says nothing: fall through to the profile or the default
    if (limits.length > 0) {
      const [limitedBy, agents] = limits.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
      return result(history.heavyShare ? agents * history.heavyShare : agents, agents, { source: "history", limitedBy, byCores, byMemory });
    }
  }
  if (!profile) return result(facts.cores, facts.cores, { source: "default", limitedBy: "default", byCores: null, byMemory: null });
  const cpu = cpuOf(profile);
  const byCores = slots(available / cpu.threadsPerJob);
  const byMemory = slots((freeGb - MEMORY_RESERVE_GB) / cpu.memPerJobGb);
  const [limitedBy, cpuSlots] = byMemory < byCores ? (["memory", byMemory] as const) : (["cores", byCores] as const);
  const cpuAgents = agentsFor(cpuSlots, cpu.heavyShare);
  if (profile.kind !== "gpu" || !profile.gpu) return result(cpuSlots, cpuAgents, { source: "profile", limitedBy, byCores, byMemory });
  const gpuSlotMap = gpuSlotMapOf(facts.gpuMemMb ?? [], profile.gpu);
  const gpuSlots = gpuSlotMap.length;
  const agentsByGpu = gpuSlots === 0 ? 1 : agentsFor(gpuSlots, profile.gpu.heavyShare ?? PROFILE_DEFAULTS.heavyShare);
  const gpuDecides = agentsByGpu < cpuAgents;
  return result(cpuSlots, Math.min(cpuAgents, agentsByGpu), {
    source: "profile",
    limitedBy: gpuDecides ? "gpu" : limitedBy,
    byCores,
    byMemory,
    gpuSlots,
    gpuSlotMap,
    agentsByGpu,
  });
}

/** The line the examples print before a run. */
export function describeCapacity(capacity: Capacity, chosen?: number): string {
  const why = capacity.source === "default" ? "one per core, no task profile" : `limited by ${capacity.limitedBy}`;
  const slotsText = capacity.gpuSlots > 0 ? `CPU slots ${capacity.cpuSlots}, GPU slots ${capacity.gpuSlots}` : `slots ${capacity.cpuSlots}`;
  const used = chosen === undefined || chosen === capacity.agents ? "" : `; you asked for ${chosen}`;
  return `This machine: recommended ${capacity.agents} agents (${slotsText}, source ${capacity.source}, ${why}; more than ${capacity.maxUseful} adds nothing)${used}. You may change it with --agents.`;
}
