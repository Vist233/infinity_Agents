import { describe, expect, it } from "vitest";
import { ledgerFacts } from "../examples/monitor.ts";
import { busyShare, parseCpuLine } from "../src/proc-readings.ts";

describe("monitor parts", () => {
  it("reads busy and total time from the first /proc/stat line and the busy share between two readings", () => {
    const a = parseCpuLine("cpu  100 0 100 700 100 0 0 0 0 0");
    const b = parseCpuLine("cpu  200 0 200 750 100 0 0 0 0 0");
    expect(a).toMatchObject({ busy: 200, total: 1000 });
    expect(busyShare(a, b)).toBeCloseTo(200 / 250, 5);
    expect(busyShare(a, a)).toBeNull();
  });

  it("counts agents alive from the ledger: started minus ended or stopped, and the results; a half-written line is ignored", () => {
    const ledger = [
      { type: "lifecycle", agent: 1, event: "started" },
      { type: "lifecycle", agent: 2, event: "started" },
      { type: "lifecycle", agent: 1, event: "ended" },
      { type: "lifecycle", agent: 3, event: "started" },
      { type: "lifecycle", agent: 3, event: "stopped" },
      { type: "result", agent: 2 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expect(ledgerFacts(`${ledger}\n{"type":"lifecy`)).toEqual({ agentsLive: 1, agentsStarted: 3, results: 1 });
  });
});
