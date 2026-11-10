import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolContext, createLocalEnvironment } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Submission, createLeanTool } from "../src/lean-tool.ts";
import type { Verdict, Verifier } from "../src/verifier.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "infinity-tool-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function setup(verdict: Verdict = { proved: true, reason: "proved" }) {
  const seen: { checked: string[]; verified: string[]; submissions: Submission[] } = { checked: [], verified: [], submissions: [] };
  const verifier: Verifier = {
    check: async (source) => {
      seen.checked.push(source);
      return "Proof.lean:1:0: warning: something";
    },
    verify: async (source) => {
      seen.verified.push(source);
      return verdict;
    },
  };
  const tool = createLeanTool({ verifier, onSubmit: async (submission) => void seen.submissions.push(submission) });
  const context = { env: createLocalEnvironment(dir, { confine: true }), signal: new AbortController().signal } as unknown as ToolContext;
  return { tool, context, seen };
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof setup>["tool"]["execute"]>>) => (result.content[0] as { text: string }).text;

describe("lean tool", () => {
  it("check shows Lean's messages and records nothing", async () => {
    const { tool, context, seen } = setup();
    await writeFile(join(dir, "Proof.lean"), "import Statement\n");
    const result = await tool.execute({ action: "check" }, context);
    expect(textOf(result)).toContain("warning: something");
    expect(seen.checked).toEqual(["import Statement\n"]);
    expect(seen.submissions).toEqual([]);
  });

  it("submit tells the agent it is proved, after the orchestrator was told", async () => {
    const { tool, context, seen } = setup();
    await writeFile(join(dir, "Proof.lean"), "code");
    const result = await tool.execute({ action: "submit" }, context);
    expect(textOf(result)).toContain("proved");
    expect(seen.submissions).toEqual([{ code: "code", verdict: { proved: true, reason: "proved" } }]);
  });

  it("submit reports the reason when the proof is not accepted, and still records the attempt", async () => {
    const { tool, context, seen } = setup({ proved: false, reason: "uses sorry" });
    await writeFile(join(dir, "Proof.lean"), "code");
    expect(textOf(await tool.execute({ action: "submit" }, context))).toBe("Not accepted: uses sorry");
    expect(seen.submissions).toHaveLength(1);
  });

  it("reads another file when asked", async () => {
    const { tool, context, seen } = setup();
    await writeFile(join(dir, "Other.lean"), "other");
    await tool.execute({ action: "check", file: "Other.lean" }, context);
    expect(seen.checked).toEqual(["other"]);
  });

  it("answers with an error when the file is missing, outside the work directory, or the action is unknown", async () => {
    const { tool, context, seen } = setup();
    expect((await tool.execute({ action: "check" }, context)).isError).toBe(true);
    expect((await tool.execute({ action: "check", file: "../../etc/hosts" }, context)).isError).toBe(true);
    expect((await tool.execute({ action: "run" }, context)).isError).toBe(true);
    expect((await tool.execute(undefined, context)).isError).toBe(true);
    expect(seen.checked).toEqual([]);
  });
});
