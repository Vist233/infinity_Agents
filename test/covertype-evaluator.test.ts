import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandEvaluator } from "../src/evaluation.ts";

const python = resolve(".venv-ml/bin/python");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infinity-cover-"));
  mkdirSync(join(dir, "labels"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "labels", "test_labels.csv"), "Cover_Type\n1\n2\n3\n4\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const evaluate = () =>
  commandEvaluator({ file: python, args: [resolve("tasks/covertype/evaluate.py")] })({
    workDir: join(dir, "work"),
    commit: null,
    command: "x",
    files: [],
    hidden: [join(dir, "labels")],
    signal: new AbortController().signal,
  });

// needs the virtual environment of the example (numpy, pandas); skipped where it was not created
describe.skipIf(!existsSync(python))("the covertype evaluator script", () => {
  it("scores accuracy and says nothing about the labels", async () => {
    writeFileSync(join(dir, "work", "predictions.csv"), "Cover_Type\n1\n2\n3\n7\n");
    const result = await evaluate();
    expect(result).toMatchObject({ status: "ok", score: 0.75, details: "compared 4 rows" });
    expect(result.metrics.accuracy).toBe(0.75);
  });

  it("explains a missing file, a wrong column, a wrong length and a wrong value without revealing anything", async () => {
    expect((await evaluate()).details).toContain("not found");
    writeFileSync(join(dir, "work", "predictions.csv"), "label\n1\n2\n3\n4\n");
    expect((await evaluate()).details).toContain("exactly one column");
    writeFileSync(join(dir, "work", "predictions.csv"), "Cover_Type\n1\n2\n");
    expect((await evaluate()).details).toContain("has 2 rows");
    writeFileSync(join(dir, "work", "predictions.csv"), "Cover_Type\n1\n2\n3\n9\n");
    expect((await evaluate()).details).toContain("from 1 to 7");
  });
});
