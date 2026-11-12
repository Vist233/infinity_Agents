import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitCommands, limitPrefix, limitedEnvironment, limitsOf, runPlaceOf } from "../src/command-limits.ts";
import { LinuxHost } from "../src/host.ts";
import { leftoverStopper, processesUnder } from "../src/leftover.ts";
import { detachedLaunch } from "../src/review-rules.ts";
import { runLayout } from "../src/run-layout.ts";
import { JsonlFile } from "../src/jsonl.ts";
import type { RunEvent } from "../src/records.ts";
import { FakeClock } from "./support/fake-clock.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-limits-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("limits in front of every command", () => {
  it("exports the four thread variables and renices the shell; no nice with level 0; the profile gives the threads", () => {
    const prefix = limitPrefix({ threadsPerJob: 3 });
    for (const name of ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"]) expect(prefix).toContain(`${name}=3`);
    expect(prefix).toContain("renice -n 10 -p $$");
    expect(limitPrefix({ threadsPerJob: 2, niceLevel: 0 })).not.toContain("renice");
    expect(limitsOf()).toEqual({ threadsPerJob: 2 });
    expect(limitsOf({ cpu: { threadsPerJob: 4 } })).toEqual({ threadsPerJob: 4 });
    expect(limitsOf({ kind: "gpu", gpu: { vramPerJobGb: 6 } })).toEqual({ threadsPerJob: 2, gpu: true });
    // a GPU task: no GPU visible, the run's shim on the PATH, the agent's number for the shim's log
    const gpu = limitPrefix({ threadsPerJob: 2, gpu: true }, { root: "/runs/r1", agent: 7 });
    expect(gpu).toContain("CUDA_VISIBLE_DEVICES=-1");
    expect(gpu).toContain("INFINITY_AGENT=7");
    expect(gpu).toContain("PATH='/runs/r1/bin':\"$PATH\"");
    expect(limitPrefix({ threadsPerJob: 2 }, { root: "/runs/r1", agent: 7 })).not.toContain("CUDA_VISIBLE_DEVICES");
    expect(runPlaceOf("/x/runs/r1/agents/007/work")).toEqual({ root: "/x/runs/r1", agent: 7 });
  });

  it("a real command sees the variables and a lower priority than an unlimited command started the same way, through exec and spawn; output and exit code are unchanged", async () => {
    // The niceness is measured against a baseline from the same process, never against a fixed number: another test (or the machine) may have changed the
    // niceness of this process. Linux sets the value (renice -n 5 gives 5, unless the niceness is already higher); macOS adds it.
    const plain = createLocalEnvironment(dir);
    const baseline = Number((await plain.exec("ps -o ni= -p $$", { cwd: dir })).output.trim());
    const lower = (value: number) => (baseline >= 5 ? value >= baseline : value > baseline);
    const env = limitCommands(plain, { threadsPerJob: 3, niceLevel: 5 });
    const show = 'echo "$OMP_NUM_THREADS $MKL_NUM_THREADS $OPENBLAS_NUM_THREADS $NUMEXPR_NUM_THREADS"; ps -o ni= -p $$; exit 7';
    const exec = await env.exec(show, { cwd: dir });
    expect(exec.exitCode).toBe(7);
    const [variables, niceness] = exec.output.trim().split("\n");
    expect(variables).toBe("3 3 3 3");
    expect(lower(Number(niceness))).toBe(true);
    const spawned = await env.spawn(show, { cwd: dir }).wait();
    expect(spawned.output).toContain("3 3 3 3");
    // a child of the shell inherits the priority of the shell
    const child = Number((await env.exec("ps -o ni= -p $$; sh -c 'ps -o ni= -p $$'", { cwd: dir })).output.trim().split("\n")[1]);
    expect(child).toBe(Number(niceness));
  });

  it("the factory makes a limited environment for each work directory", async () => {
    const make = limitedEnvironment({ threadsPerJob: 2 });
    const env = make({ workDir: dir, sharedDir: dir });
    expect((await env.exec("echo $OMP_NUM_THREADS", { cwd: dir })).output.trim()).toBe("2");
  });
});

describe("detached launches", () => {
  it("are found: setsid, nohup, disown and a lone &", () => {
    for (const command of [
      "setsid python train.py",
      "nohup python train.py > log &",
      "python a.py & disown",
      "python train.py &",
      "a & b",
      "(sleep 1; nohup x)",
      "python x.py &\nwait",
    ])
      expect(detachedLaunch(command), command).toBeDefined();
  });

  it("are not confused with &&, redirections, URLs or words that contain the names", () => {
    for (const command of [
      "make && python train.py",
      "python train.py > out.txt 2>&1",
      "python train.py &> out.txt",
      "curl 'http://x/?a=1&b=2'",
      "grep nohupped notes.txt",
      "echo a || echo b",
      "python train.py |& tee log",
      "ls -la",
    ])
      expect(detachedLaunch(command), command).toBeUndefined();
  });
});

describe("leftover processes at the end", () => {
  const procLine = (pid: number) => `${pid} (python3) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 5 1000 100 0`;
  const fakeProc = () => {
    const proc = join(dir, "proc");
    const root = join(dir, "run");
    mkdirSync(join(root, "agents", "001"), { recursive: true });
    mkdirSync(join(dir, "run-other"));
    mkdirSync(join(proc, "self"), { recursive: true });
    const add = (pid: number, cwd: string) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "stat"), procLine(pid));
      symlinkSync(cwd, join(proc, String(pid), "cwd"));
    };
    add(201, join(root, "agents", "001"));
    add(202, root);
    add(203, join(dir, "run-other"));
    add(process.pid, root); // this process: never stopped
    return { proc, root, add };
  };

  it("finds processes by working directory under the run directory, not by name or by a sibling with the same prefix", () => {
    const { proc, root } = fakeProc();
    expect(processesUnder(root, new LinuxHost({ procDir: proc })).sort()).toEqual([201, 202, process.pid].sort());
    expect(processesUnder(root, new LinuxHost({ procDir: join(dir, "no-proc") }))).toEqual([]);
  });

  it("stops them with SIGTERM, then SIGKILL for the ones still alive after the grace time, never itself, and writes one event", async () => {
    const { proc, root } = fakeProc();
    const layout = runLayout(root);
    const signals: Array<[number, string]> = [];
    const stopper = leftoverStopper({
      host: new LinuxHost({ procDir: proc }),
      graceMs: 400,
      sleep: async () => {},
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 201 && signal === "SIGTERM") rmSync(join(proc, "201"), { recursive: true }); // ends politely; 202 does not
      },
    });
    stopper.start({ layout, clock: new FakeClock(), view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await stopper.stop();
    await stopper.stop(); // once only
    expect(signals).toEqual([
      [201, "SIGTERM"],
      [202, "SIGTERM"],
      [202, "SIGKILL"],
    ]);
    const events = new JsonlFile<RunEvent>(layout.events).readAll();
    expect(events).toEqual([{ type: "leftover_processes", ts: 0, found: 2, killedHard: 1 }]);
  });

  it("does nothing, and writes nothing, where there is no /proc", async () => {
    const root = join(dir, "run");
    mkdirSync(root);
    const layout = runLayout(root);
    const stopper = leftoverStopper({ host: new LinuxHost({ procDir: join(dir, "nowhere") }) });
    stopper.start({ layout, clock: new FakeClock(), view: { rung: () => 1, agents: () => 1 }, note: () => {}, hold: () => {} });
    await stopper.stop();
    expect(new JsonlFile<RunEvent>(layout.events).readAll()).toEqual([]);
  });
});

describe("a run with the limits", () => {
  it("runs the agents' bash commands with the thread variables set", async () => {
    const { runTask } = await import("../src/orchestrator.ts");
    const { defineTask } = await import("../src/task.ts");
    const { createFakeEvaluator } = await import("./support/fake-evaluator.ts");
    const { createScriptedCodeModel } = await import("./support/scripted-code-model.ts");
    writeFileSync(join(dir, "truth.txt"), "100");
    const model = createScriptedCodeModel({
      hints: ["h1"],
      value: (_hint, cycle) => 40 + 30 * cycle,
      extraCalls: () => [{ name: "bash", args: { command: 'echo "$OMP_NUM_THREADS" > threads.txt' } }],
    });
    const task = defineTask({
      name: "limits",
      mode: "code",
      prompt: "p",
      hidden: [join(dir, "truth.txt")],
      evaluate: createFakeEvaluator({ original: join(dir, "truth.txt") }).evaluate,
      metric: { name: "score", direction: "max" },
      review: false,
      agents: 1,
      model: { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 },
      stop: { targetScore: 0.9 },
      profile: { cpu: { threadsPerJob: 3 } },
      runsDir: dir,
    });
    const outcome = await runTask(task, { createClient: () => model, runDir: join(dir, "run"), createEnvironment: limitedEnvironment(limitsOf(task.profile)) });
    expect(readFileSync(join(runLayout(outcome.runDir).workDir(1), "threads.txt"), "utf8").trim()).toBe("3");
  }, 60_000);
});
