import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineForm, formPackage, formProblems, looksLikeForm } from "../src/form.ts";
import type { PackageContext } from "../src/launch.ts";

const model = { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 };
const context = (over: Partial<PackageContext> = {}): PackageContext => ({
  agents: 3,
  profile: {},
  model,
  tokens: undefined,
  branchReview: undefined,
  commandMinutes: undefined,
  runsDir: "runs",
  ...over,
});

const codeForm = {
  preset: "code",
  name: "speed",
  prompt: "Make it fast.",
  data: { src: "input" },
  hidden: ["secret"],
  evaluate: { program: "score.py", run: "python3", args: ["--strict"] },
  metric: { name: "seconds", direction: "min" },
  stop: { targetScore: 1.5 },
} as const;

describe("formProblems", () => {
  it("accepts a code form and a math form", () => {
    expect(formProblems(codeForm)).toEqual([]);
    expect(formProblems({ preset: "math", name: "m", statement: "True" })).toEqual([]);
  });

  it("names every problem in words, not only the first", () => {
    const problems = formProblems({ preset: "code", name: "", extra: 1, evaluate: { program: "" }, tokens: -1 });
    expect(problems).toContain("name is required");
    expect(problems.join("\n")).toContain("unknown field 'extra'");
    expect(problems).toContain("prompt is required for the code preset: say what the agents are to do");
    expect(problems.join("\n")).toContain("evaluate must be a function or");
    expect(problems).toContain("tokens must be a number above 0");
  });

  it("keeps the presets apart", () => {
    expect(formProblems({ preset: "math", name: "m", statement: "True", hidden: ["x"] })).toContain("'hidden' belongs to the code preset");
    expect(formProblems({ preset: "code", name: "c", prompt: "p", statement: "True" })).toContain("'statement' belongs to the math preset");
    expect(formProblems({ preset: "code", name: "c", prompt: "p", stop: "first-success" })).toContain("stop 'first-success' belongs to the math preset");
    expect(formProblems({ preset: "math", name: "m", statement: "True", stop: { targetScore: 1 } })).toContain("a target score belongs to the code preset");
    expect(formProblems({ preset: "math", name: "m", statement: "True", stop: "until-stopped" })).toContain(
      "a math task stops at the first accepted proof: leave out stop",
    );
  });

  it("ties the metric to the evaluator and the target score to the metric", () => {
    const base = { preset: "code", name: "c", prompt: "p" };
    expect(formProblems({ ...base, evaluate: { program: "e.py" } })).toContain("metric is required with evaluate");
    expect(formProblems({ ...base, metric: { name: "s", direction: "max" } })).toContain("metric needs an evaluate");
    expect(formProblems({ ...base, stop: { targetScore: 1 } })).toContain("stop.targetScore needs a metric");
    expect(formProblems({ ...base, metric: { name: "s", direction: "up" }, evaluate: { program: "e.py" } })).toContain(
      "metric must be { name, direction: 'max' | 'min' }",
    );
  });

  it("refuses a form that is not an object", () => {
    expect(formProblems("text")).toEqual(["a form must be an object"]);
    expect(formProblems(null)).toEqual(["a form must be an object"]);
  });

  it("defineForm throws with the problems and returns a good form unchanged", () => {
    expect(() => defineForm({ preset: "math", name: "m" } as never)).toThrow("statement is required");
    expect(defineForm({ preset: "math", name: "m", statement: "True" }).name).toBe("m");
  });

  it("tells a form from a task package", () => {
    expect(looksLikeForm(codeForm)).toBe(true);
    expect(looksLikeForm({ name: "x", build() {} })).toBe(false);
    expect(looksLikeForm(undefined)).toBe(false);
  });
});

describe("formPackage", () => {
  it("builds a code task: paths relative to the form's folder, the evaluator program protected, the machine limits in the prompt", () => {
    const pack = formPackage(codeForm, "/base");
    expect(pack.name).toBe("speed");
    const task = pack.build(context({ profile: { cpu: { threadsPerJob: 4, memPerJobGb: 6 } }, commandMinutes: 15 }));
    expect(task.files).toEqual({ src: "/base/input" });
    expect(task.hidden).toEqual(["/base/secret"]);
    expect(task.protect).toEqual(["/base/score.py"]);
    expect(task.metric).toEqual({ name: "seconds", direction: "min" });
    expect(task.stop).toEqual({ targetScore: 1.5 });
    expect(task.review).toEqual({});
    expect(task.commandTimeoutMinutes).toBe(15);
    expect(task.prompt).toContain("Make it fast.");
    expect(task.prompt).toContain("at most 4 threads");
    expect(task.prompt).toContain("6 GB");
  });

  it("an absolute path stays as it is; review false and a function evaluator are kept", () => {
    const evaluate = async () => ({ status: "ok" as const, score: 1, metrics: {}, details: "" });
    const pack = formPackage(
      { preset: "code", name: "c", prompt: "p", data: { d: "/abs/dir" }, evaluate, metric: { name: "s", direction: "max" }, review: false },
      "/base",
    );
    const task = pack.build(context());
    expect(task.files).toEqual({ d: "/abs/dir" });
    expect(task.evaluate).toBe(evaluate);
    expect(task.review).toBe(false);
    expect(task.protect).toBeUndefined();
  });

  it("the branch review is the caller's choice; the form only extends it", () => {
    const pack = formPackage({ ...codeForm, branchReview: { maxTurns: 2 } }, "/base");
    const on = pack.build(context({ branchReview: { everyMinutes: 3, maxTurns: 6, maxConcurrent: 2 } }));
    const off = pack.build(context());
    expect(on.branchReview).toEqual({ everyMinutes: 3, maxTurns: 2, maxConcurrent: 2 });
    expect(off.branchReview).toBeUndefined();
  });

  it("builds a math task that stops at the first proof; the budget, wall limit and summary come through", () => {
    const pack = formPackage({ preset: "math", name: "m", statement: "True", tokens: 500, wallMinutes: 9, leanPool: 2 }, "/base");
    expect(pack.defaults).toEqual({ tokens: 500, wallMinutes: 9 });
    expect(pack.summary).toContain("True");
    const task = pack.build(context({ tokens: 100 }));
    expect(task).toMatchObject({
      tools: { kind: "lean", statement: "True", leanPool: 2, sandbox: false },
      stop: { targetScore: 1 },
      metric: { name: "proved", direction: "max" },
      review: false,
      tokens: 100,
      agents: 3,
    });
  });

  it("refuses a bad form when the package is made", () => {
    expect(() => formPackage({ preset: "code", name: "c" } as never, "/base")).toThrow("prompt is required");
  });
});

describe("a code form with a program evaluator", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infinity-form-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("scores through the program: the work directory and the hidden path reach it, the last JSON line is the result", async () => {
    writeFileSync(
      join(dir, "score.py"),
      'import json, os\nprint("noise")\nprint(json.dumps({"score": float(open(os.environ["INFINITY_WORK_DIR"] + "/n.txt").read()), "details": os.path.basename(os.environ["INFINITY_HIDDEN_0"])}))\n',
    );
    writeFileSync(join(dir, "n.txt"), "42");
    const pack = formPackage(
      {
        preset: "code",
        name: "c",
        prompt: "p",
        hidden: ["secret"],
        evaluate: { program: "score.py", run: "python3" },
        metric: { name: "s", direction: "max" },
      },
      dir,
    );
    const task = pack.build(context());
    const result = await task.evaluate?.({
      workDir: dir,
      commit: null,
      command: "",
      files: [],
      hidden: [join(dir, "private-secret")],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "ok", score: 42, details: "private-secret" });
    expect(readFileSync(join(dir, "score.py"), "utf8")).toContain("INFINITY_HIDDEN_0");
  });
});
