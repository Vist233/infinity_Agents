import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { startViewer, type ViewerHandle } from "../server.ts";

let handle: ViewerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe("the page", () => {
  it("is one page with its script, read-only, and its numbers come from the run files", async () => {
    handle = await startViewer({ root: join(import.meta.dirname, "fixtures", "synthetic") });
    const base = `http://127.0.0.1:${handle.port}`;
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("<title>Infinity run viewer</title>");
    for (const id of ["result", "progress", "attention", "scores", "board", "machine"]) expect(html).toContain(`id="${id}"`);
    // Read-only: nothing that sends or changes anything.
    expect(html).not.toMatch(/<(button|form|textarea)\b/i);
    expect(html).not.toMatch(/method:\s*["'](POST|PUT|DELETE|PATCH)/i);
    // The inline script is valid JavaScript and uses the endpoints the server offers.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new Script(script)).not.toThrow();
    for (const path of ["/api/run", "/api/series", "/api/agents", "/api/stream"]) expect(script).toContain(path);
    // The numbers the page shows (tiles, timeline marks, machine panel start) are in these answers.
    const run = await (await fetch(`${base}/api/run`)).json();
    expect([run.agentsStarted, run.scoredSubmits, run.bestScore, run.rung]).toEqual([8, 0, null, 8]);
    const series = await (await fetch(`${base}/api/series`)).json();
    expect(series.rungs.map((r: { to: number }) => r.to)).toEqual([2, 4, 8]);
    expect(Math.round((series.machine[0].ts - series.startedAt) / 60000)).toBe(0);
  });
});
