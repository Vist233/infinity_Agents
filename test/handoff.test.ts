import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handoffStore, handoffTool } from "../src/handoff.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const context = { log: {}, signal: new AbortController().signal } as never;
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

describe("handoff: one store for every agent of every run on the machine", () => {
  it("an agent of one run publishes a checked package; an agent of another run finds it and pulls it into its own folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "inf-handoff-"));
    dirs.push(root);
    const workA = join(root, "run-a", "agent-1");
    const workB = join(root, "run-b", "agent-3");
    mkdirSync(join(workA, "pkg"), { recursive: true });
    mkdirSync(workB, { recursive: true });
    writeFileSync(
      join(workA, "pkg", "handoff.json"),
      JSON.stringify({
        id: "lemma/parity",
        version: "1.0.0",
        description: "Parity of a sum of two odd numbers is even; use it for parity goals.",
        tags: ["math"],
        verify: { cmd: ["test", "-f", "proof.txt"], cwd: "." },
      }),
    );
    writeFileSync(join(workA, "pkg", "proof.txt"), "odd + odd = even\n");

    const a = handoffTool(join(root, "run-a"), 1, workA);
    const b = handoffTool(join(root, "run-b"), 3, workB);
    expect(a.name).toBe("handoff");
    const published = textOf(await a.execute({ action: "publish", source: "pkg" }, context));
    expect(published).toContain('"status":"accepted"');
    expect(textOf(await b.execute({ action: "search", query: "parity" }, context))).toContain("lemma/parity");
    expect(textOf(await b.execute({ action: "pull", id: "lemma/parity", verify: true }, context))).toContain('"verified":true');
  });

  it("lives in the machine's folder unless INFINITY_HANDOFF_DIR moves it (tests move it)", () => {
    expect(handoffStore()).toBe(process.env.INFINITY_HANDOFF_DIR);
    const saved = process.env.INFINITY_HANDOFF_DIR;
    delete process.env.INFINITY_HANDOFF_DIR;
    expect(handoffStore()).toMatch(/\.infinity[/\\]handoff$/);
    process.env.INFINITY_HANDOFF_DIR = saved;
  });
});
