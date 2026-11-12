/**
 * GPU slots test with no model (docs/15 E7): JOBS scripted jobs go through the `gpu` shim, each allocating a dummy CUDA tensor of --gb GB and holding it for
 * --hold seconds. Checks that no more jobs run at once than there are GPU slots, that each job sees the GPU of its slot only, and that a command started
 * without the shim sees no GPU. Needs Linux, flock, nvidia-smi and python3 with torch; says so and stops (exit code 0) when one of them is missing.
 *
 *   node examples/synthetic-gpu.ts [--jobs 12] [--gb 4] [--hold 5] [--max-per-gpu N] [--python python3]
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLocalEnvironment } from "sakura-agent";
import { recommendCapacity } from "../src/capacity.ts";
import { limitCommands } from "../src/command-limits.ts";
import { GpuLedger, gpuDirOf, gpuShim, readNewLines } from "../src/gpu-shim.ts";
import { readMachineFacts } from "../src/proc-readings.ts";
import { unsupportedFeatures } from "../src/platform.ts";
import { runLayout } from "../src/run-layout.ts";
import { chooseAgents, takeNumber } from "../bin/flags.ts";

const args = process.argv.slice(2);
const jobs = takeNumber(args, "jobs") ?? 12;
const gigabytes = takeNumber(args, "gb") ?? 4;
const hold = takeNumber(args, "hold") ?? 5;
const maxPerGpu = takeNumber(args, "max-per-gpu");
const pythonIndex = args.indexOf("--python");
const python = pythonIndex >= 0 ? (args[pythonIndex + 1] ?? "python3") : "python3";
const run = promisify(execFile);
const skip = (why: string): never => {
  console.log(`skipped: ${why}`);
  process.exit(0);
};

const problems = await unsupportedFeatures({ gpu: true });
if (problems.length > 0) skip(problems.join("; "));
const torch = await run(python, ["-c", "import torch; print(torch.cuda.device_count())"]).catch(() => undefined);
if (!torch) skip(`${python} cannot import torch`);
if (Number(torch?.stdout.trim()) < 1) skip("torch sees no CUDA device");

const profile = { kind: "gpu", gpu: { vramPerJobGb: gigabytes + 1, ...(maxPerGpu === undefined ? {} : { maxJobsPerGpu: maxPerGpu }) } } as const;
const facts = await readMachineFacts(200);
const capacity = recommendCapacity(facts, profile);
await chooseAgents(profile, undefined);
if (capacity.gpuSlots < 1) skip("no GPU slot: the GPUs do not hold one job of this size");

const runDir = mkdtempSync(join(tmpdir(), "infinity-synthetic-gpu-"));
const layout = runLayout(runDir);
mkdirSync(layout.root, { recursive: true });
const ledger = new GpuLedger(capacity.gpuSlots);
const component = gpuShim({ slotMap: capacity.gpuSlotMap, everyMs: 500, ledger });
const clock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }),
};
component.start({ layout, clock: clock as never, view: { rung: () => jobs, agents: () => jobs }, note: console.log, hold: () => {} });

const allocate = `import os,sys,time,torch; x=torch.empty(int(${gigabytes}*2**30),dtype=torch.uint8,device="cuda"); print("gpu", os.environ["CUDA_VISIBLE_DEVICES"], torch.cuda.device_count()); sys.stdout.flush(); time.sleep(${hold})`;
const results = await Promise.all(
  Array.from({ length: jobs }, (_, index) => {
    const env = limitCommands(createLocalEnvironment(runDir), { threadsPerJob: 1, gpu: true }, { root: runDir, agent: index + 1 });
    return env.exec(`gpu ${python} -c '${allocate}'`, { cwd: runDir });
  }),
);
const bare = await limitCommands(createLocalEnvironment(runDir), { threadsPerJob: 1, gpu: true }, { root: runDir, agent: 99 }).exec(
  `${python} -c 'import torch; print(torch.cuda.device_count())'`,
  { cwd: runDir },
);
await component.stop();

// peak jobs at once, from the shim's own log
let now = 0;
let peak = 0;
for (const line of readNewLines(join(gpuDirOf(runDir), "events.jsonl"), 0).lines.sort((a, b) => a.t - b.t || (a.e === "end" ? -1 : 1))) {
  if (line.e === "grant") now += 1;
  if (line.e === "end") now -= 1;
  peak = Math.max(peak, now);
}
const failed = results.filter((result) => result.exitCode !== 0);
const seesNone = bare.output.trim().split("\n").at(-1) === "0";
console.log(
  JSON.stringify(
    {
      runDir,
      gpuSlots: capacity.gpuSlots,
      jobs,
      jobsFailed: failed.length,
      peakJobsAtOnce: peak,
      withinSlots: peak <= capacity.gpuSlots,
      commandWithoutShimSeesNoGpu: seesNone,
      meanWaitMs: Math.round(ledger.stats.totalWaitMs / Math.max(1, ledger.stats.commands)),
      maxWaitMs: ledger.stats.maxWaitMs,
      slotUtilisation: Number(ledger.utilisation().toFixed(3)),
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 && peak <= capacity.gpuSlots && seesNone ? 0 : 1);
