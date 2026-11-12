/**
 * The machine sampler as a program of its own, for when no run is going or the run is not this code: one JSON line every few seconds
 * (the same fields as a run's machine.jsonl), until it is stopped. With `--run` it also prints how many agents the run has alive.
 *
 *   node examples/monitor.ts --out metrics.jsonl [--every 5] [--run runs/<run dir>]
 *
 * Numbers only: no command line, environment, path or address. A run writes the same record by itself (`machine.jsonl`); this is the standalone form.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MachineReader } from "../src/proc-readings.ts";

/** Agents alive = started minus (ended or stopped), counted per agent from the ledger lines. */
export function ledgerFacts(text: string): { agentsLive: number; agentsStarted: number; results: number } {
  const live = new Set<number>();
  let started = 0;
  let results = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { type?: string; agent?: number; event?: string };
      if (entry.type === "result") results += 1;
      if (entry.type === "lifecycle" && typeof entry.agent === "number") {
        if (entry.event === "started") {
          started += 1;
          live.add(entry.agent);
        } else if (entry.event === "ended" || entry.event === "stopped") live.delete(entry.agent);
      }
    } catch {
      // a line that is still being written
    }
  }
  return { agentsLive: live.size, agentsStarted: started, results };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, every: { type: "string", default: "5" }, run: { type: "string" } } });
  if (!values.out) throw new Error("--out <file> is required");
  const everyMs = Math.max(1, Number(values.every)) * 1000;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping = true));
  const reader = new MachineReader(values.run ? { runRoot: values.run } : {});
  while (!stopping) {
    const ledger = values.run && existsSync(join(values.run, "ledger.jsonl")) ? ledgerFacts(readFileSync(join(values.run, "ledger.jsonl"), "utf8")) : undefined;
    const sample = await reader.read(Date.now(), { rung: ledger?.agentsLive ?? 0, agents: ledger?.agentsLive ?? 0 });
    appendFileSync(values.out, `${JSON.stringify({ ...sample, results: ledger?.results })}\n`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

if (import.meta.main) await main();
