import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTaskPackage } from "../bin/load-task.ts";
import { recommend, scaffold } from "../bin/scaffold.ts";
import { readMachineConfig } from "../src/machine-config.ts";

const model = { baseUrl: "http://unused", apiKey: "unused", model: "scripted", contextWindow: 100_000 };
const context = { agents: 2, profile: {}, model, tokens: undefined, branchReview: undefined, commandMinutes: undefined, runsDir: "runs" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infinity-load-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadTaskPackage", () => {
  it("finds the tasks of tasks/ by name: forms for math and covertype", async () => {
    expect((await loadTaskPackage("math-parity")).name).toBe("math-parity");
    const covertype = await loadTaskPackage("covertype");
    const task = covertype.build(context);
    expect(task.metric).toEqual({ name: "accuracy", direction: "max" });
    expect(task.files?.data?.endsWith("data/covertype")).toBe(true);
    expect(task.protect?.[0]?.endsWith("tasks/covertype/evaluate.py")).toBe(true);
  });

  it("reads a JSON form by file or by its folder, with paths relative to the file", async () => {
    mkdirSync(join(dir, "mine"));
    writeFileSync(join(dir, "mine", "task.json"), JSON.stringify({ preset: "code", name: "j", prompt: "p", data: { d: "in" } }));
    for (const name of [join(dir, "mine", "task.json"), join(dir, "mine")]) {
      const task = (await loadTaskPackage(name)).build(context);
      expect(task.files).toEqual({ d: join(dir, "mine", "in") });
    }
  });

  it("reads a TypeScript module that exports a task package as before", async () => {
    writeFileSync(join(dir, "pack.ts"), 'export default { name: "p", summary: "s", build() { throw new Error("built"); } };\n');
    const pack = await loadTaskPackage(join(dir, "pack.ts"));
    expect(pack.name).toBe("p");
    expect(() => pack.build(context)).toThrow("built");
  });

  it("says what is wrong in words: a missing task, an empty folder, a file that is neither", async () => {
    await expect(loadTaskPackage(join(dir, "nothing.ts"))).rejects.toThrow("no task");
    await expect(loadTaskPackage(dir)).rejects.toThrow("has no task.ts or task.json");
    writeFileSync(join(dir, "odd.ts"), "export default 5;\n");
    await expect(loadTaskPackage(join(dir, "odd.ts"))).rejects.toThrow("must export a form");
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ preset: "math", name: "m" }));
    await expect(loadTaskPackage(join(dir, "bad.json"))).rejects.toThrow("statement is required");
  });
});

describe("infinity new", () => {
  it("writes a code form and an example evaluator that load and build, and never overwrites", async () => {
    const written = scaffold(["code", join(dir, "t")]);
    expect(written.map((path) => path.split("/").pop())).toEqual(["task.ts", "evaluate.py"]);
    const task = (await loadTaskPackage(join(dir, "t"))).build(context);
    expect(task.protect).toEqual([join(dir, "t", "evaluate.py")]);
    expect(() => scaffold(["code", join(dir, "t")])).toThrow("exists already; nothing was written");
  });

  it("writes a math form that loads", async () => {
    scaffold(["math", join(dir, "m")]);
    expect(existsSync(join(dir, "m", "evaluate.py"))).toBe(false);
    const task = (await loadTaskPackage(join(dir, "m"))).build(context);
    expect(task.tools?.kind).toBe("lean");
  });

  it("refuses wrong arguments with the usage", () => {
    expect(() => scaffold(["both", dir])).toThrow("usage: infinity new");
    expect(() => scaffold(["code"])).toThrow("usage: infinity new");
  });

  it("the example evaluator scores a number from answer.txt and says why when it cannot", async () => {
    scaffold(["code", join(dir, "t")]);
    const { commandEvaluator } = await import("../src/evaluation.ts");
    const evaluate = commandEvaluator({ file: "python3", args: [join(dir, "t", "evaluate.py")] });
    const work = join(dir, "work");
    mkdirSync(work);
    const ctx = { workDir: work, commit: null, command: "", files: [], hidden: [], signal: new AbortController().signal };
    expect(await evaluate(ctx)).toMatchObject({ status: "error", score: null });
    writeFileSync(join(work, "answer.txt"), "7");
    expect(await evaluate(ctx)).toMatchObject({ status: "ok", score: 7 });
    writeFileSync(join(work, "answer.txt"), "1e308");
    const refused = await evaluate(ctx);
    expect(refused).toMatchObject({ status: "error", score: null });
    expect(refused.details).toContain("between 0 and 100");
    expect(readFileSync(join(dir, "t", "task.ts"), "utf8")).toContain("preset");
  });
});

describe("infinity recommend", () => {
  it("prints the recommendation and writes a machine file that can be read back", async () => {
    const path = join(dir, "machine.json");
    const lines = await recommend(["--write", path]);
    expect(lines[0]).toContain("recommended");
    expect(lines.at(-1)).toContain(`Wrote ${path}`);
    const config = readMachineConfig(path);
    expect(config.agents).toBeGreaterThanOrEqual(1);
    expect(config.slots).toBeGreaterThanOrEqual(1);
  });

  it("uses the profile of a named task and refuses stray arguments", async () => {
    expect((await recommend(["--task", "math-parity"]))[0]).toContain("recommended");
    await expect(recommend(["--bogus"])).rejects.toThrow("not understood: --bogus");
    await expect(recommend(["--write"])).rejects.toThrow("--write needs a value");
  });
});
