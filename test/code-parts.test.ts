import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolContext, createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankCodeAgents, renderCodeCsv } from "../src/code-leaderboard.ts";
import { type EvalContext, type EvalResult, commandEvaluator, parseResult } from "../src/evaluation.ts";
import type { CodeSubmission } from "../src/mode.ts";
import type { LedgerEntry } from "../src/records.ts";
import { MAX_ENTRY_CHARS_PER_FILE, createSubmitTool } from "../src/submit-tool.ts";
import { type CodeTask, defineTask } from "../src/task.ts";
import { createScriptedCodeModel } from "./support/scripted-code-model.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "infinity-code-parts-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => (result.content[0] as { text: string }).text;

describe("submit tool", () => {
  function setup(results: EvalResult[], extra: { minIntervalMs?: number; selfReported?: boolean; direction?: "max" | "min" } = {}) {
    let now = 1000;
    const seen: { submissions: CodeSubmission[]; inputs: Array<{ commit: string | null; claim: Record<string, number> }>; commits: number } = {
      submissions: [],
      inputs: [],
      commits: 0,
    };
    const tool = createSubmitTool({
      helpers: { workDir: dir, commitNow: async () => `commit${++seen.commits}` },
      onSubmit: async (submission) => void seen.submissions.push(submission as CodeSubmission),
      metricName: "accuracy",
      direction: extra.direction ?? "max",
      minIntervalMs: extra.minIntervalMs ?? 0,
      now: () => now,
      evaluate: async (input) => {
        seen.inputs.push({ commit: input.commit, claim: input.claim });
        return { result: results.shift() as EvalResult, selfReported: extra.selfReported ?? false };
      },
    });
    const context = { env: createLocalEnvironment(dir, {}), signal: new AbortController().signal } as unknown as ToolContext;
    return {
      tool,
      context,
      seen,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const ok = (score: number): EvalResult => ({ status: "ok", score, metrics: { accuracy: score, seconds: 3 }, details: "" });

  it("commits first, scores that commit, records the files' contents and shows the score and the agent's best", async () => {
    const { tool, context, seen } = setup([ok(0.8), ok(0.7)]);
    await writeFile(join(dir, "pred.csv"), "1,2,3");
    const first = await tool.execute({ command: "python run.py", files: ["pred.csv"] }, context);
    expect(textOf(first)).toContain("accuracy 0.8");
    expect(textOf(first)).toContain("seconds 3");
    expect(seen.inputs[0]?.commit).toBe("commit1");
    expect(seen.submissions[0]).toMatchObject({ kind: "code", command: "python run.py", files: ["pred.csv"], selfReported: false });
    expect(seen.submissions[0]?.entry).toBe("=== pred.csv ===\n1,2,3");
    const second = await tool.execute({ command: "python run.py --lr 2", files: [] }, context);
    expect(textOf(second)).toContain("Your best so far: 0.8");
  });

  it("with direction min the lower score is the best", async () => {
    const { tool, context } = setup([ok(5), ok(3), ok(4)], { direction: "min" });
    await tool.execute({ command: "a" }, context);
    await tool.execute({ command: "b" }, context);
    expect(textOf(await tool.execute({ command: "c" }, context))).toContain("Your best so far: 3");
  });

  it("makes the agent wait between submits and does not record or score the refused one", async () => {
    const { tool, context, seen, advance } = setup([ok(0.5), ok(0.6)], { minIntervalMs: 60_000 });
    await tool.execute({ command: "a" }, context);
    advance(20_000);
    const refused = await tool.execute({ command: "b" }, context);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("40 seconds");
    expect(seen.submissions).toHaveLength(1);
    advance(40_000);
    expect(textOf(await tool.execute({ command: "b" }, context))).toContain("0.6");
    expect(seen.submissions).toHaveLength(2);
  });

  it("rejects a call without a command, cuts long files, and notes unreadable ones", async () => {
    const { tool, context, seen } = setup([ok(0.1)]);
    expect((await tool.execute({ command: "  " }, context)).isError).toBe(true);
    expect((await tool.execute(undefined, context)).isError).toBe(true);
    await writeFile(join(dir, "big.txt"), "x".repeat(MAX_ENTRY_CHARS_PER_FILE + 500));
    await tool.execute({ command: "c", files: ["big.txt", "missing.txt", 5] }, context);
    const entry = seen.submissions[0]?.entry ?? "";
    expect(entry).toContain(`first ${MAX_ENTRY_CHARS_PER_FILE} of ${MAX_ENTRY_CHARS_PER_FILE + 500}`);
    expect(entry).toContain("=== missing.txt (not readable) ===");
  });

  it("an error result is shown as an error and does not count as the best; a self-reported one says that nothing was verified", async () => {
    const failed = setup([{ status: "error", score: null, metrics: {}, details: "bad csv" }]);
    const result = await failed.tool.execute({ command: "a" }, failed.context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bad csv");
    const claimed = setup([{ status: "ok", score: 0.9, metrics: { accuracy: 0.9 }, details: "" }], { selfReported: true });
    const answer = textOf(await claimed.tool.execute({ command: "a", claim: { accuracy: 0.9, junk: "x" } }, claimed.context));
    expect(answer).toContain("self-reported");
    expect(answer).not.toContain("best so far");
    expect(claimed.seen.inputs[0]?.claim).toEqual({ accuracy: 0.9 });
  });
});

describe("evaluator", () => {
  const context = (overrides: Partial<EvalContext> = {}): EvalContext => ({
    workDir: dir,
    commit: "abc",
    command: "x",
    files: [],
    hidden: ["/private/one"],
    signal: new AbortController().signal,
    ...overrides,
  });
  const node = (code: string, extra: { timeoutMs?: number } = {}) => commandEvaluator({ file: process.execPath, args: ["-e", code], ...extra });

  it("runs a program with the work directory, commit and private paths in its environment and reads the last JSON line", async () => {
    const program = `console.log("noise"); console.log(JSON.stringify({score: 0.5, metrics: {a: 1, b: "x"}, details: [process.env.INFINITY_WORK_DIR, process.env.INFINITY_COMMIT, process.env.INFINITY_HIDDEN_0, process.env.OPENCODE_API_KEY ?? "nokey"].join("|")}))`;
    process.env.OPENCODE_API_KEY ??= "test-value-that-must-not-leak";
    const result = await node(program)(context());
    expect(result).toEqual({ status: "ok", score: 0.5, metrics: { a: 1 }, details: `${dir}|abc|/private/one|nokey` });
  });

  it("turns a crash, a missing answer, a bad answer, a timeout and a cancel into error results with a reason", async () => {
    expect(await node("console.error('boom'); process.exit(3)")(context())).toMatchObject({ status: "error", details: expect.stringContaining("exit 3") });
    expect((await node("console.log('no json here')")(context())).details).toContain("not JSON");
    expect((await node('console.log(JSON.stringify({score: "high"}))')(context())).details).toContain("numeric 'score'");
    expect((await node("setInterval(() => {}, 1000)", { timeoutMs: 100 })(context())).details).toContain("did not finish in time");
    const controller = new AbortController();
    const pending = node("setInterval(() => {}, 1000)")(context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    expect((await pending).details).toContain("cancelled");
    expect((await commandEvaluator({ file: join(dir, "does-not-exist") })(context())).details).toContain("could not be started");
  });

  it("parseResult accepts only an object with a numeric score on the last non-empty line", () => {
    expect(parseResult('{"score": 1}\n\n')).toMatchObject({ status: "ok", score: 1, details: "" });
    expect(parseResult("").status).toBe("error");
    expect(parseResult('{"score": null}').status).toBe("error");
  });
});

describe("code leaderboard", () => {
  const pointer = (agent: number) => ({ ts: 1, agent, workDir: `/w/${agent}`, commit: `c${agent}` });
  const result = (agent: number, score: number | null, extra: Partial<Extract<LedgerEntry, { type: "result" }>> = {}): LedgerEntry => ({
    type: "result",
    ...pointer(agent),
    command: "c",
    entry: "",
    files: [],
    status: score === null ? "error" : "ok",
    score,
    metrics: {},
    details: "",
    selfReported: false,
    steps: 1,
    elapsedMs: 1,
    ...extra,
  });

  it("ranks verified scores first, by direction, and puts agents without a score last", () => {
    const ledger: LedgerEntry[] = [
      result(1, 0.5),
      result(1, 0.9, { commit: "best1" }),
      result(2, 0.95, { selfReported: true }),
      result(3, 0.7),
      result(4, null),
      { type: "commit", ...pointer(5), turn: 1 },
    ];
    const max = rankCodeAgents(ledger, "max");
    expect(max.map((row) => row.agent)).toEqual([1, 3, 2, 4, 5]);
    expect(max[0]).toMatchObject({ rank: 1, score: 0.9, commit: "best1", submits: 2 });
    expect(max[3]).toMatchObject({ score: null, errors: 1 });
    expect(rankCodeAgents(ledger, "min").map((row) => row.agent)).toEqual([1, 3, 2, 4, 5]); // 0.5 is the lowest verified score of agent 1
    expect(renderCodeCsv(max).split("\n")[1]).toBe("1,1,0.9,false,2,0,best1,/w/1");
    expect(renderCodeCsv(rankCodeAgents([result(9, 1, { workDir: '/w/"9",x' })], "max"))).toContain('"/w/""9"",x"');
  });
});

describe("defineTask in code mode", () => {
  const base: CodeTask = {
    name: "t",
    mode: "code",
    prompt: "p",
    review: false,
    agents: 2,
    model: { baseUrl: "http://x", apiKey: "k", model: "m", contextWindow: 1000 },
    stop: "until-stopped",
  };
  const evaluate = async (): Promise<EvalResult> => ({ status: "ok", score: 1, metrics: {}, details: "" });

  it("accepts a valid task and lists every problem of an invalid one at once", () => {
    expect(defineTask({ ...base, evaluate, metric: { name: "acc", direction: "max" }, stop: { targetScore: 0.9 }, files: { data: "./d" } })).toBeTruthy();
    expect(() =>
      defineTask({
        ...base,
        prompt: " ",
        evaluate,
        stop: { targetScore: 1 },
        evalSlots: 0,
        submitIntervalMinutes: -1,
        evalTimeoutMinutes: 0,
        files: { "a/b": "x" },
        branchReview: { everyMinutes: 0, maxTurns: 0, maxConcurrent: 0 },
      }),
    ).toThrow(
      /prompt must not be empty.*metric is required.*targetScore needs a metric.*evalSlots.*submitIntervalMinutes.*evalTimeoutMinutes.*everyMinutes.*maxTurns.*maxConcurrent.*not a plain name/,
    );
    expect(() => defineTask({ ...base, metric: { name: "acc", direction: "max" } })).toThrow(/needs an evaluate/);
    expect(() => defineTask({ ...base, review: undefined as never })).toThrow(/review must be given/);
    expect(() => defineTask({ ...base, evaluate, metric: { name: " ", direction: "max" }, stop: { targetScore: Number.NaN } })).toThrow(
      /metric name.*targetScore must be a number/,
    );
  });
});

describe("code planner and mode set-up", () => {
  it("plans code hints with a code prompt and falls back to the code list", async () => {
    const { planHints, CODE_FALLBACK_HINTS } = await import("../src/planner.ts");
    const seen: string[] = [];
    const client = {
      model: { id: "x", contextWindow: 1000, supportsImages: false },
      // biome-ignore lint/correctness/useYield: the planner call fails on purpose
      async *stream(request: { system: string }) {
        seen.push(request.system);
        throw new Error("down");
      },
    };
    const hints = await planHints({ client: client as never, statement: "Raise the score", count: 3, kind: "code" });
    expect(hints).toEqual(CODE_FALLBACK_HINTS.slice(0, 3));
    expect(seen[0]).toContain("score (code, data, machine learning)");
  });

  it("CodeMode refuses to set up an agent before prepare, and finish is safe to repeat", async () => {
    const { CodeMode } = await import("../src/code-mode.ts");
    const { Pool } = await import("../src/pool.ts");
    const { realClock } = await import("../src/clock.ts");
    const { runLayout } = await import("../src/run-layout.ts");
    const task = defineTask({
      name: "t",
      mode: "code",
      prompt: "p",
      review: { breakerConsecutive: 3 },
      agents: 1,
      model: { baseUrl: "http://x", apiKey: "k", model: "m", contextWindow: 1000 },
      stop: "until-stopped",
    });
    const mode = new CodeMode({
      task,
      layout: runLayout(join(dir, "run")),
      clock: realClock,
      evalPool: new Pool(1),
      reviewClient: createScriptedCodeModel({ hints: [], value: () => 0 }),
    });
    expect(() => mode.agentSetup("h", 1)).toThrow(/prepare/);
    mode.finish([1, 2]); // the agents' directories do not exist: no error
    mode.finish([1, 2]);
    expect(mode.warnings()).toEqual(["There is no evaluator: the ranking uses the agents' own claims (self-reported)."]);
  });
});
