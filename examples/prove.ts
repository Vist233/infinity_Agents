/**
 * A real run: node examples/prove.ts <parity|odd-sum> [agents]
 * Real Lean (pool of 2), a real model through OpenCode Go. The key is read from OPENCODE_API_KEY and never printed.
 */
import { randomUUID } from "node:crypto";
import { compatPresets } from "sakura-agent";
import { runTask } from "../src/orchestrator.ts";
import { defineTask } from "../src/task.ts";

const STATEMENTS = {
  parity: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
  // the sum of the first n odd numbers is n squared, written with the core library only
  "odd-sum": "∀ n : Nat, (List.range n).foldl (fun acc i => acc + (2 * i + 1)) 0 = n * n",
} as const;

const [name, agentsArgument] = process.argv.slice(2);
if (name !== "parity" && name !== "odd-sum") throw new Error("usage: node examples/prove.ts <parity|odd-sum> [agents]");
const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");

const task = defineTask({
  name,
  mode: "math",
  statement: STATEMENTS[name],
  agents: Number(agentsArgument ?? 3),
  model: {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey,
    model: "deepseek-v4.1-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
    headers: { "x-opencode-session": randomUUID() },
  },
  stop: "first-success",
  leanPool: 2,
  sandbox: false, // no sandbox by default; a proof file runs with your rights. true confines Lean on macOS.
  tokens: 3_000_000,
  stuckMinutes: 10,
  runsDir: "runs",
});

const outcome = await runTask(task, { checkEveryMs: 30_000 });
console.log(JSON.stringify(outcome));
