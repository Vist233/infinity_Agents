import { describe, expect, it } from "vitest";
import { cpuOf, describeCapacity, gpuSlotMapOf, profileProblems, recommendCapacity } from "../src/capacity.ts";
import { defineTask } from "../src/task.ts";

const machine = { cores: 16, freeMemMb: 90 * 1024 };

describe("recommendCapacity for a CPU task", () => {
  it("ignores a history that has no usable figure instead of failing (zero CPU per agent early in a run)", () => {
    expect(recommendCapacity(machine, undefined, { cpuPerAgent: 0 })).toMatchObject({ agents: 16, source: "default" });
    expect(recommendCapacity(machine, undefined, {})).toMatchObject({ agents: 16, source: "default" });
  });
  it("is one agent per core without a profile", () => {
    expect(recommendCapacity(machine)).toMatchObject({ agents: 16, cpuSlots: 16, maxUseful: 32, source: "default", limitedBy: "default" });
  });

  it("works out CPU slots from the free cores and memory, and agents from the heavy share with a quarter more", () => {
    // defaults: 2 threads and 3 GB per job, 80 % of the time heavy: 16 / 2 = 8 slots, (90 - 8) / 3 = 27; 8 / 0.8 * 1.25 = 12.5, so 13 agents
    expect(recommendCapacity(machine, {})).toMatchObject({
      cpuSlots: 8,
      agents: 13,
      maxUseful: 26,
      source: "profile",
      limitedBy: "cores",
      byCores: 8,
      byMemory: 27,
      gpuSlots: 0,
    });
    // little memory decides: (20 - 8) / 3 = 4 slots, 4 / 0.8 * 1.25 = 6.25, so 7 agents
    expect(recommendCapacity({ cores: 16, freeMemMb: 20 * 1024 }, {})).toMatchObject({ cpuSlots: 4, agents: 7, limitedBy: "memory" });
    // jobs that are heavy all the time: 16 slots of one thread, 16 * 1.25 = 20
    expect(recommendCapacity(machine, { cpu: { threadsPerJob: 1, heavyShare: 1 } })).toMatchObject({ cpuSlots: 16, agents: 20 });
    // the profile defaults are filled in
    expect(cpuOf({ cpu: { threadsPerJob: 4 } })).toEqual({ threadsPerJob: 4, memPerJobGb: 3, heavyShare: 0.8 });
  });

  it("subtracts the cores that foreign load keeps busy and manages only the rest", () => {
    expect(recommendCapacity({ ...machine, busyCores: 4 }, {})).toMatchObject({ cpuSlots: 6, agents: 10 });
    expect(recommendCapacity({ ...machine, busyCores: 40 }, {}).cpuSlots).toBe(1);
  });

  it("never gives less than one agent or one slot", () => {
    expect(recommendCapacity({ cores: 1, freeMemMb: 1000 }, { cpu: { memPerJobGb: 50 } })).toMatchObject({ cpuSlots: 1, agents: 2, maxUseful: 4 });
  });

  it("lets what an earlier run measured replace the profile", () => {
    expect(recommendCapacity(machine, { cpu: { threadsPerJob: 1 } }, { cpuPerAgent: 0.5 })).toMatchObject({
      agents: 32,
      source: "history",
      limitedBy: "cores",
    });
    expect(recommendCapacity({ cores: 64, freeMemMb: 40 * 1024 }, undefined, { cpuPerAgent: 0.5, memPerAgentGb: 2 })).toMatchObject({
      agents: 16,
      limitedBy: "memory",
    });
    expect(recommendCapacity(machine, undefined, { cpuPerAgent: 0.5, plateauRung: 6, heavyShare: 0.5 })).toMatchObject({
      agents: 6,
      cpuSlots: 3,
      limitedBy: "plateau",
    });
    expect(recommendCapacity(machine, {}, {}).source).toBe("profile");
  });
});

describe("recommendCapacity for a GPU task", () => {
  const gpu = { kind: "gpu", gpu: { vramPerJobGb: 6, heavyShare: 0.5 } } as const;

  it("counts GPU slots per GPU, from the memory and the cap, and takes the smaller agent number of the two kinds", () => {
    expect(gpuSlotMapOf([24 * 1024, 24 * 1024], { vramPerJobGb: 6 })).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(gpuSlotMapOf([24 * 1024, 8 * 1024], { vramPerJobGb: 6, maxJobsPerGpu: 2 })).toEqual([0, 0, 1]);
    expect(gpuSlotMapOf([4 * 1024], { vramPerJobGb: 6 })).toEqual([]);
    // 4 slots on one 24 GB card: 4 / 0.5 * 1.25 = 10 agents; the CPU kind alone would allow 13
    expect(recommendCapacity({ ...machine, gpuMemMb: [24 * 1024] }, gpu)).toMatchObject({
      cpuSlots: 8,
      gpuSlots: 4,
      agents: 10,
      agentsByGpu: 10,
      limitedBy: "gpu",
      maxUseful: 20,
    });
    // a cap of 2 jobs per GPU
    expect(recommendCapacity({ ...machine, gpuMemMb: [24 * 1024] }, { ...gpu, gpu: { vramPerJobGb: 6, maxJobsPerGpu: 2 } })).toMatchObject({
      gpuSlots: 2,
      agents: 4,
    });
    // plenty of GPU room: the CPU kind decides
    expect(recommendCapacity({ ...machine, gpuMemMb: [24 * 1024, 24 * 1024, 24 * 1024] }, gpu)).toMatchObject({ gpuSlots: 12, agents: 13, limitedBy: "cores" });
  });

  it("a GPU task on a machine without a usable GPU gets one agent and no GPU slot", () => {
    expect(recommendCapacity(machine, gpu)).toMatchObject({ gpuSlots: 0, agents: 1 });
  });

  it("a CPU task ignores the GPUs", () => {
    expect(recommendCapacity({ ...machine, gpuMemMb: [24 * 1024] }, {})).toMatchObject({ gpuSlots: 0, agentsByGpu: null, agents: 13 });
  });
});

describe("describing the recommendation", () => {
  it("says in one line what it recommends and what was asked", () => {
    const capacity = recommendCapacity(machine, {});
    expect(describeCapacity(capacity)).toContain("recommended 13 agents (slots 8, source profile, limited by cores; more than 26 adds nothing)");
    expect(describeCapacity(capacity, 100)).toContain("you asked for 100");
    expect(describeCapacity(capacity, 13)).not.toContain("you asked");
    expect(describeCapacity(recommendCapacity({ ...machine, gpuMemMb: [24 * 1024] }, { kind: "gpu", gpu: { vramPerJobGb: 6 } }))).toContain(
      "CPU slots 8, GPU slots 4",
    );
  });
});

describe("the task profile", () => {
  const base = {
    name: "t",
    mode: "math",
    statement: "True",
    stop: "first-success",
    agents: 1,
    model: { baseUrl: "u", apiKey: "k", model: "m", contextWindow: 1000 },
  } as const;

  it("is checked with the task", () => {
    expect(profileProblems({ cpu: { threadsPerJob: 2, memPerJobGb: 3, heavyShare: 0.5 } })).toEqual([]);
    expect(profileProblems({ cpu: { threadsPerJob: 0, memPerJobGb: -1, heavyShare: 0 } })).toHaveLength(3);
    expect(profileProblems({ kind: "gpu" })).toEqual(["profile.gpu is required with kind 'gpu'"]);
    expect(profileProblems({ kind: "gpu", gpu: { vramPerJobGb: 0, heavyShare: 2, maxJobsPerGpu: 1.5 } })).toHaveLength(3);
    expect(() => defineTask({ ...base, profile: { cpu: { heavyShare: 1.5 } } })).toThrow(/heavyShare/);
    expect(defineTask({ ...base, profile: { cpu: { threadsPerJob: 4 } } }).profile).toEqual({ cpu: { threadsPerJob: 4 } });
  });
});
