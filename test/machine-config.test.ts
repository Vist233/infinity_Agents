import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineConfigFrom, machineOptions, parseMachineConfig, readMachineConfig, writeMachineConfig } from "../src/machine-config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infinity-machine-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const capacity = {
  cpuSlots: 6,
  gpuSlots: 0,
  gpuSlotMap: [],
  agents: 8,
  maxUseful: 16,
  source: "profile",
  limitedBy: "memory",
  byCores: 7,
  byMemory: 6,
  agentsByGpu: null,
} as const;

describe("the machine file", () => {
  it("is made from a recommendation, written with a note, and read back unchanged", () => {
    const config = machineConfigFrom({ ...capacity, gpuSlotMap: [] }, { threadsPerJob: 2, memPerJobGb: 3, heavyShare: 0.8 });
    expect(config).toEqual({ agents: 8, slots: 6, threads: 2, memGb: 3, heavyShare: 0.8 });
    const path = join(dir, "machine.json");
    writeMachineConfig(path, config, "made here");
    expect(readFileSync(path, "utf8")).toContain("made here");
    expect(readMachineConfig(path)).toMatchObject(config);
  });

  it("stands for launch options: slots become the gate, the rest keep their names", () => {
    expect(machineOptions({ agents: 4, slots: 3, threads: 2, memGb: 5, heavyShare: 0.5, commandMinutes: 30 })).toEqual({
      agents: 4,
      gate: 3,
      threads: 2,
      memGb: 5,
      heavyShare: 0.5,
      commandMinutes: 30,
    });
    expect(machineOptions({})).toEqual({});
  });

  it("refuses broken files with words", () => {
    expect(() => parseMachineConfig("{")).toThrow("not valid JSON");
    expect(() => parseMachineConfig("[]")).toThrow("must be a JSON object");
    expect(() => parseMachineConfig('{"agents": 0, "cores": 4}')).toThrow(/agents must be a number above 0; unknown field 'cores'/);
  });
});
