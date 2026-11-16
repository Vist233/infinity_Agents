import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startViewer, type ViewerHandle } from "../server.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const handles: ViewerHandle[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(root: string, pollMs = 30) {
  const handle = await startViewer({ root, pollMs });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}
const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;

describe("endpoints", () => {
  it("serves one run of a runs directory with all views", async () => {
    const { base, handle } = await start(fixtures);
    expect(handle.server.address()).toMatchObject({ address: "127.0.0.1" });
    const runs = await getJson(`${base}/api/runs`);
    expect(runs.current).toBe("synthetic");
    const run = await getJson(`${base}/api/run`);
    expect(run).toMatchObject({ agentsStarted: 8, scoredSubmits: 0, bestScore: null, state: "finished", machineSamples: 48 });
    const series = await getJson(`${base}/api/series`);
    expect(series.rungs).toHaveLength(3);
    expect(series.submits).toHaveLength(0);
    expect(series.machine).toHaveLength(48);
    expect(await getJson(`${base}/api/series?max=20`).then((s) => s.machine.length)).toBeLessThan(40);
    expect(await getJson(`${base}/api/agents`)).toHaveLength(8);
    const rungs = await getJson(`${base}/api/events?type=rung`);
    expect(rungs).toHaveLength(3);
    expect(rungs.every((e: any) => e.type === "rung")).toBe(true);
    expect(await getJson(`${base}/api/events?type=rung&limit=2`)).toHaveLength(2);
    expect(await getJson(`${base}/api/events?since=${run.endedAt}`)).toHaveLength(0);
  });

  it("serves a single run directory, rejects unknown runs, other methods and foreign hosts", async () => {
    const { base, handle } = await start(join(fixtures, "synthetic"));
    expect((await getJson(`${base}/api/run?run=synthetic`)).task).toBe("synthetic-load");
    expect((await fetch(`${base}/api/run?run=../../etc`)).status).toBe(404);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/run`, { method: "POST" })).status).toBe(405);
    const status = await new Promise<number>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port: handle.port, path: "/api/run", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("server-sent events", () => {
  it("delivers an update when a run file grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sse-"));
    temps.push(dir);
    cpSync(join(fixtures, "synthetic"), dir, { recursive: true });
    const { base } = await start(dir);
    const response = await fetch(`${base}/api/stream`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!seen.includes(needle) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
        if (chunk && !chunk.done) seen += decoder.decode(chunk.value);
      }
      return seen.includes(needle);
    };
    expect(await readUntil("event: hello")).toBe(true);
    const before = (await getJson(`${base}/api/run`)).scoredSubmits;
    appendFileSync(
      join(dir, "ledger.jsonl"),
      `${JSON.stringify({ type: "result", ts: 1794454600000, agent: 1, status: "ok", score: 0.5, selfReported: false })}\n`,
    );
    expect(await readUntil("event: update")).toBe(true);
    reader.cancel();
    expect((await getJson(`${base}/api/run`)).scoredSubmits).toBe(before + 1);
  });
});
