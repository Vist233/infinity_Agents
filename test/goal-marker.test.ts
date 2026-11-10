import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Proves decision 10 with the real framework: a goal whose verify is `test -f ../proved` runs in the agent's work directory,
 * so the marker sits next to `work/`, outside the confined directory. The agent cannot stop before the marker exists.
 */
let agentDir: string;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "infinity-goal-"));
  await mkdir(join(agentDir, "work"));
});
afterEach(() => rm(agentDir, { recursive: true, force: true }));

const CHECKLIST_DONE = "- [done] a proof was accepted :: ok";

describe("goal marker", () => {
  it("keeps the agent working until ../proved exists, and the confined agent cannot create it", async () => {
    let requestsSeen = 0;
    let markerWrittenAtRequest = -1;
    let markerExistedAfterForgery = true;
    const client = createFauxClient((_request, index) => {
      requestsSeen = index + 1;
      if (index === 0) return { text: "I think I am done." };
      if (index === 1) return { text: CHECKLIST_DONE }; // the goal check says done, but the marker is missing
      if (index === 2) return { toolCalls: [{ name: "write", args: { path: "../proved", content: "forged" } }] };
      if (index === 3) markerExistedAfterForgery = existsSync(join(agentDir, "proved"));
      if (index === 3) return { text: "I am done now." };
      markerWrittenAtRequest = index;
      writeFileSync(join(agentDir, "proved"), "accepted by the orchestrator\n"); // the orchestrator, not the agent
      return { text: CHECKLIST_DONE };
    });
    const agent = await createAgent({
      model: client,
      cwd: join(agentDir, "work"),
      confine: true,
      tools: ["read", "write"],
      goal: { objective: "prove it", verify: "test -f ../proved" },
    });
    const result = await agent.run("Start.").result;
    await agent.close();

    expect(result.reason).toBe("done");
    expect(markerExistedAfterForgery).toBe(false); // the write to ../proved was refused by confine
    expect(markerWrittenAtRequest).toBeGreaterThan(1);
    expect(requestsSeen).toBeGreaterThanOrEqual(markerWrittenAtRequest + 1);
    const marker = await readFile(join(agentDir, "proved"), "utf8");
    expect(marker).toContain("accepted by the orchestrator");
  });
});
