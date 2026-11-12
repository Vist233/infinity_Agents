/**
 * A load test with no model and no tokens (docs/15 E0 and E7): N scripted agents, each looping { think for a while, run a CPU burner } through the real
 * orchestrator, the real command limits and, when asked for, the real slot gate. machine.jsonl, run-facts.json and slot_wait are written as in a real run.
 *
 *   node examples/synthetic-load.ts [--agents N] [--seconds S] [--think 25] [--burn 30] [--threads 2] [--gate | --slots N | --no-gate] [--pressure-brake]
 *
 * The agents start fast: while the ladder climbs to N they answer at once with a trivial command; the real cycles (think, burn) start when all N are alive, and
 * the figures printed at the end cover that steady part only. A burner is one `node` process with --threads busy threads for --burn seconds (the thread
 * count it reads from OMP_NUM_THREADS, which the command limits set, so the limits are in the loop). Linux only. Leaves the run directory under runs/.
 */
import { type LlmClient, type LlmEvent, type LlmRequest, createLocalEnvironment } from "sakura-agent";
import { cpuOf } from "../src/capacity.ts";
import { DEFAULT_COMMAND_TIMEOUT_MINUTES } from "../src/code-mode.ts";
import { limitedEnvironment, limitsOf } from "../src/command-limits.ts";
import { defaultComponents } from "../src/defaults.ts";
import { readMachineSamples } from "../src/machine-summary.ts";
import { runTask } from "../src/orchestrator.ts";
import { runLayout } from "../src/run-layout.ts";
import { SlotGate } from "../src/slot-gate.ts";
import { defineTask } from "../src/task.ts";
import { chooseAgents, profileWithFlags, takeNumber, takeSwitch } from "../bin/flags.ts";

const commandLine = process.argv.slice(2);
const args = [...commandLine];
const seconds = takeNumber(args, "seconds") ?? 180;
const thinkSeconds = takeNumber(args, "think") ?? 25;
const burnSeconds = takeNumber(args, "burn") ?? 30;
const agentsFlag = takeNumber(args, "agents");
const slotsFlag = takeNumber(args, "slots");
const gateFlag = takeSwitch(args, "gate");
const noGate = takeSwitch(args, "no-gate");
const pressureBrake = takeSwitch(args, "pressure-brake");
const profile = profileWithFlags({ cpu: { threadsPerJob: 2, memPerJobGb: 1, heavyShare: burnSeconds / (burnSeconds + thinkSeconds) } }, args);
if (noGate && (slotsFlag !== undefined || gateFlag)) throw new Error("--no-gate cannot be used with --slots or --gate");
const { agents, capacity, foreignBusyCores } = await chooseAgents(profile, agentsFlag);
const slots = noGate ? undefined : (slotsFlag ?? (gateFlag ? capacity.cpuSlots : undefined));
const gate = slots === undefined ? undefined : new SlotGate(slots);

const burnerFor = (seconds: number) =>
  `${JSON.stringify(process.execPath)} -e 'const{Worker}=require("node:worker_threads");const n=Number(process.env.OMP_NUM_THREADS)||1;const end=Date.now()+${seconds.toFixed(1)}*1000;for(let i=0;i<n;i++)new Worker("const e="+end+";while(Date.now()<e);",{eval:true})'`;
// Agents must not move in lock step: each starts at a random point of its cycle, and every think and burn time varies, so the load is not a square wave.
const jitter = (seconds: number, spread: number) => seconds * (1 - spread + 2 * spread * Math.random());

// ----- the scripted agents -----
let started = 0;
let steadyAt: number | undefined;
let burns = 0;
let burnsInSteady = 0;
// The figures start after one full cycle so that the random start points have spread the agents over the cycle.
const settleMs = (thinkSeconds + burnSeconds) * 1000;
const measuring = () => steadyAt !== undefined && Date.now() >= steadyAt + settleMs;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
const model: LlmClient = {
  model: { id: "synthetic", contextWindow: 1_000_000, supportsImages: false },
  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    if (request.system.startsWith("You plan a team")) {
      yield { type: "text_delta", delta: JSON.stringify(Array.from({ length: 100 }, (_, index) => `idea ${index + 1}`)) };
    } else {
      const calls = request.messages.filter((message) => message.role === "assistant").length;
      if (calls === 0) started += 1;
      if (started >= agents && steadyAt === undefined) steadyAt = Date.now();
      const steady = steadyAt !== undefined && Date.now() >= steadyAt;
      const last = request.messages.at(-1);
      if (steady && last?.role === "tool" && !JSON.stringify(last.content).includes("warm")) {
        burns += 1;
        if (measuring()) burnsInSteady += 1;
      }
      const firstSteady = steady && JSON.stringify(last?.content ?? "").includes("warm");
      await sleep(steady ? (firstSteady ? Math.random() * (thinkSeconds + burnSeconds) * 1000 : jitter(thinkSeconds, 0.6) * 1000) : 5, signal);
      yield {
        type: "tool_call",
        call: {
          id: `call_${calls}_${Math.random().toString(36).slice(2, 8)}`,
          name: "bash",
          args: { command: steady ? burnerFor(jitter(burnSeconds, 0.3)) : "echo warm" },
        },
      };
    }
    yield { type: "usage", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } };
    yield { type: "done", stop: "stop" };
  },
};

const task = defineTask({
  name: "synthetic-load",
  mode: "code",
  prompt: "Synthetic load: no real work.",
  review: false,
  agents,
  profile,
  model: { baseUrl: "http://unused", apiKey: "unused", model: "synthetic", contextWindow: 1_000_000 },
  stop: "until-stopped",
  runsDir: "runs",
  stuckMinutes: 1000,
});

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
let steadyStartedMs = 0;
const wall = setInterval(() => {
  if (steadyAt !== undefined && steadyStartedMs === 0) steadyStartedMs = steadyAt;
  if (steadyStartedMs !== 0 && Date.now() - steadyStartedMs >= seconds * 1000 + settleMs) stop.abort();
}, 500);
const outcome = await runTask(task, {
  createClient: () => model,
  signal: stop.signal,
  createEnvironment: limitedEnvironment(limitsOf(profile), ({ workDir }) => createLocalEnvironment(workDir)),
  ...(gate ? { gate } : {}),
  components: defaultComponents({
    ceiling: agents,
    commandLine,
    foreignBusyCores,
    pressureBrake,
    commandTimeoutMinutes: DEFAULT_COMMAND_TIMEOUT_MINUTES,
    ...(gate ? { gate } : {}),
  }),
});
clearInterval(wall);

// ----- the figures of the steady part -----
const samples = readMachineSamples(runLayout(outcome.runDir).machine).filter(
  (sample) => steadyAt !== undefined && sample.ts >= steadyAt + settleMs && sample.agents >= agents,
);
const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
const steadyMinutes = steadyAt === undefined ? 0 : Math.max(0, (Date.now() - steadyAt - settleMs) / 60_000);
const cpu = cpuOf(profile);
console.log(
  JSON.stringify(
    {
      runDir: outcome.runDir,
      agents,
      threads: cpu.threadsPerJob,
      gate: slots ?? "off",
      steadyMinutes: Number(steadyMinutes.toFixed(2)),
      burnsPerMinute: steadyMinutes > 0 ? Number((burnsInSteady / steadyMinutes).toFixed(2)) : 0,
      burnsTotal: burns,
      meanWaitMs: gate && gate.stats.commands > 0 ? Math.round(gate.stats.totalWaitMs / gate.stats.commands) : 0,
      slotUtilisation: gate ? Number(gate.utilisation().toFixed(3)) : null,
      meanCpuBusy: Number(mean(samples.flatMap((sample) => (sample.cpuBusy === null ? [] : [sample.cpuBusy]))).toFixed(3)),
      meanRunCores: Number(mean(samples.flatMap((sample) => (sample.runCpuCores === null ? [] : [sample.runCpuCores]))).toFixed(2)),
      meanLoad1: Number(mean(samples.map((sample) => sample.load1)).toFixed(1)),
    },
    null,
    2,
  ),
);
