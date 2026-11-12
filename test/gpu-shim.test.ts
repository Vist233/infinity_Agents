import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GpuLedger, type GpuLine, gpuBinDirOf, gpuDirOf, gpuShim, gpuShimText, readNewLines } from "../src/gpu-shim.ts";
import { JsonlFile } from "../src/jsonl.ts";
import type { RunEvent } from "../src/records.ts";
import { runLayout } from "../src/run-layout.ts";
import { unsupportedFeatures } from "../src/platform.ts";
import { FakeClock } from "./support/fake-clock.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-gpu-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (e: GpuLine["e"], t: number, p: number, extra: Partial<GpuLine> = {}): GpuLine => ({ e, t, p, ...extra });

describe("the gpu shim (text and bookkeeping)", () => {
  it("is a bash script that takes a lock file with flock, sets CUDA_VISIBLE_DEVICES from the slot map, and gives the slot back on exit", () => {
    const text = gpuShimText({ dir: "/runs/r1/gpu-locks", slotMap: [0, 0, 1] });
    expect(text.startsWith("#!/bin/bash")).toBe(true);
    expect(text).toContain("dir='/runs/r1/gpu-locks'");
    expect(text).toContain("gpus=(0 0 1)");
    expect(text).toContain("flock -n 9");
    expect(text).toContain(`CUDA_VISIBLE_DEVICES=\${gpus[$i]} "$@"`);
    expect(text).toContain("exit $code");
    expect(gpuShimText({ dir: "/it's", slotMap: [0] })).toContain("dir='/it'\\''s'");
  });

  it("follows the log: jobs holding a slot, jobs waiting, the wait of each job and the share of slot time that was busy", () => {
    const ledger = new GpuLedger(2);
    ledger.feed(line("request", 0, 10, { a: 1 }));
    expect(ledger.feed(line("grant", 0, 10, { a: 1, gpu: 0 }))).toBe(0);
    ledger.feed(line("request", 1000, 11, { a: 2 }));
    ledger.feed(line("request", 1000, 12, { a: 3 }));
    expect(ledger).toMatchObject({ inUse: 1, waiting: 2 });
    ledger.feed(line("end", 4000, 10));
    expect(ledger.feed(line("grant", 4000, 11, { a: 2, gpu: 0 }))).toBe(3000);
    expect(ledger).toMatchObject({ inUse: 1, waiting: 1 });
    ledger.feed(line("end", 10_000, 11));
    // slot 1 was busy 0 to 4000 and 4000 to 10000 = 10 s; two slots over 10 s = 20 s
    expect(ledger.utilisation()).toBeCloseTo(0.5, 5);
    expect(ledger.stats).toMatchObject({ commands: 2, waited: 1, totalWaitMs: 3000, maxWaitMs: 3000 });
  });

  it("reads only the complete lines of the log", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, '{"e":"request","t":1,"p":5,"a":1}\n{"e":"gr');
    const first = readNewLines(file, 0);
    expect(first.lines).toHaveLength(1);
    writeFileSync(file, '{"e":"request","t":1,"p":5,"a":1}\n{"e":"grant","t":2,"p":5,"a":1,"gpu":0}\n');
    expect(readNewLines(file, first.offset).lines).toEqual([{ e: "grant", t: 2, p: 5, a: 1, gpu: 0 }]);
    expect(readNewLines(join(dir, "none"), 0)).toEqual({ lines: [], offset: 0 });
  });
});

describe("the gpu shim run with a stand-in for flock (any system)", () => {
  it("is valid bash, and with a lock that is always free it logs request, grant and end, sets the GPU of the slot and passes the exit code on", async () => {
    const root = join(dir, "run");
    const locks = gpuDirOf(root);
    mkdirSync(locks, { recursive: true });
    mkdirSync(join(dir, "fake"), { recursive: true });
    writeFileSync(join(dir, "fake", "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "fake", "date"), "#!/bin/sh\necho 1700000000000\n", { mode: 0o755 }); // GNU date's %N is not on macOS
    const shim = join(dir, "gpu");
    writeFileSync(shim, gpuShimText({ dir: locks, slotMap: [2, 6] }), { mode: 0o755 });
    const syntax = await new Promise<number>((resolve) => spawn("bash", ["-n", shim]).on("close", (code) => resolve(code ?? -1)));
    expect(syntax).toBe(0);
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(shim, ["sh", "-c", 'echo "device $CUDA_VISIBLE_DEVICES"; exit 3'], {
        env: { ...process.env, PATH: `${join(dir, "fake")}:${process.env.PATH}`, INFINITY_AGENT: "9" },
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("close", (code) => resolve({ code: code ?? -1, out }));
    });
    expect(result).toEqual({ code: 3, out: "device 2\n" });
    expect(readNewLines(join(locks, "events.jsonl"), 0).lines.map((entry) => [entry.e, entry.a, entry.gpu])).toEqual([
      ["request", 9, undefined],
      ["grant", 9, 2],
      ["end", undefined, undefined],
    ]);
    const usage = await new Promise<number>((resolve) => spawn(shim, [], { env: process.env }).on("close", (code) => resolve(code ?? -1)));
    expect(usage).toBe(2);
  });
});

describe("the gpu shim component", () => {
  it("writes an executable bin/gpu and the lock directory, turns the log into slot_wait events (kind gpu) and writes the summary", async () => {
    const layout = runLayout(join(dir, "run"));
    mkdirSync(layout.root, { recursive: true });
    const clock = new FakeClock();
    const component = gpuShim({ slotMap: [0, 1], everyMs: 1000 });
    component.start({ layout, clock, view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    const shim = join(gpuBinDirOf(layout.root), "gpu");
    expect(readFileSync(shim, "utf8")).toContain("gpus=(0 1)");
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    expect(existsSync(gpuDirOf(layout.root))).toBe(true);
    writeFileSync(
      join(gpuDirOf(layout.root), "events.jsonl"),
      [line("request", 0, 7, { a: 4 }), line("grant", 2500, 7, { a: 4, gpu: 1 }), line("end", 3500, 7)].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    await clock.advance(1000);
    await component.stop();
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events.filter((event) => event.type === "slot_wait")).toMatchObject([{ kind: "gpu", agent: 4, waitMs: 2500 }]);
    expect(events.filter((event) => event.type === "slot_summary")).toMatchObject([{ kind: "gpu", slots: 2, commands: 1, waited: 1 }]);
  });
});

describe("what the platform lacks", () => {
  it("lists each missing feature as 'unsupported on this OS: ...' and asks for flock and nvidia-smi only for GPU tasks", async () => {
    const none = async () => false;
    const all = async () => true;
    expect(await unsupportedFeatures({ platform: "linux", hasProc: true, has: all, gpu: true })).toEqual([]);
    const mac = await unsupportedFeatures({ platform: "darwin", hasProc: false, has: none });
    expect(mac).toHaveLength(3);
    expect(mac.every((text) => text.startsWith("unsupported on this OS: "))).toBe(true);
    expect(mac.join(" ")).toContain("not Linux");
    expect(await unsupportedFeatures({ platform: "linux", hasProc: true, has: async (program) => program === "renice" })).toEqual([]);
    const gpu = await unsupportedFeatures({ platform: "linux", hasProc: true, has: async (program) => program === "renice", gpu: true });
    expect(gpu.join(" ")).toContain("flock");
    expect(gpu.join(" ")).toContain("GPU tasks are disabled");
    expect(gpu.join(" ")).toContain("nvidia-smi");
  });
});

// Real flock and a real shell: Linux only (macOS has no flock). Skipped elsewhere, and the title says so.
describe.skipIf(process.platform !== "linux")("[Linux only, skipped on other systems] the gpu shim with a real flock", () => {
  const setup = (slotMap: number[]) => {
    const root = join(dir, "run");
    const locks = gpuDirOf(root);
    mkdirSync(locks, { recursive: true });
    mkdirSync(gpuBinDirOf(root), { recursive: true });
    const shim = join(gpuBinDirOf(root), "gpu");
    writeFileSync(shim, gpuShimText({ dir: locks, slotMap }), { mode: 0o755 });
    return { shim, locks };
  };
  const runShim = (shim: string, command: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(shim, ["sh", "-c", command]);
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  it("lets only as many jobs run at once as there are slots, gives each the GPU of its slot, passes the exit code and records request, grant and end", async () => {
    const { shim, locks } = setup([3, 5]);
    const log = join(dir, "jobs.txt");
    writeFileSync(log, "");
    const job = `echo start >> ${log}; echo $CUDA_VISIBLE_DEVICES; sleep 0.6; echo end >> ${log}; exit 4`;
    const results = await Promise.all([1, 2, 3, 4].map(() => runShim(shim, job)));
    expect(results.map((result) => result.code)).toEqual([4, 4, 4, 4]);
    const devices = results.map((result) => result.out.trim()).sort();
    expect(devices.every((device) => device === "3" || device === "5")).toBe(true);
    expect(new Set(devices)).toEqual(new Set(["3", "5"]));
    let now = 0;
    let peak = 0;
    for (const entry of readFileSync(log, "utf8").trim().split("\n")) {
      now += entry === "start" ? 1 : -1;
      peak = Math.max(peak, now);
    }
    expect(peak).toBe(2);
    const ledger = new GpuLedger(2);
    for (const entry of readNewLines(join(locks, "events.jsonl"), 0).lines) ledger.feed(entry);
    expect(ledger).toMatchObject({ inUse: 0, waiting: 0 });
    expect(ledger.stats.commands).toBe(4);
    expect(ledger.stats.maxWaitMs).toBeGreaterThan(500);
  }, 30_000);

  it("a command without the shim sees no GPU when the environment hides it", async () => {
    const { limitPrefix } = await import("../src/command-limits.ts");
    const root = join(dir, "run");
    setup([0]);
    const out = await new Promise<string>((resolve) => {
      const child = spawn("/bin/bash", [
        "-c",
        `${limitPrefix({ threadsPerJob: 1, gpu: true }, { root, agent: 2 })}echo "[$CUDA_VISIBLE_DEVICES]"; gpu sh -c 'echo "[$CUDA_VISIBLE_DEVICES]"'`,
      ]);
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.on("close", () => resolve(text));
    });
    expect(out.trim().split("\n")).toEqual(["[-1]", "[0]"]);
  });
});
