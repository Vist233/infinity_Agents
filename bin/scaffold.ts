import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpuOf } from "../src/capacity.ts";
import { machineConfigFrom, writeMachineConfig } from "../src/machine-config.ts";
import { recommendRun } from "../src/launch.ts";
import { loadTaskPackage } from "./load-task.ts";

export const NEW_HELP = `usage: infinity new <code|math> <folder>
  writes a task form (task.mts) into <folder>, with an example evaluator for the code preset; edit them, then: infinity run <folder>`;

export const RECOMMEND_HELP = `usage: infinity recommend [--task <task>] [--write machine.json]
  looks at this computer (cores, memory, GPU, other load) and says how many agents, how many heavy commands at once and how many threads
  and how much memory one command may use; with --task it uses that task's profile; with --write it saves the answer as a machine file
  (edit it by hand if you like; use it with: infinity run <task> --machine machine.json). Flags of a run always win over the file.`;

const CODE_FORM = `// A task form: what to do and how it is scored. What the machine can carry is a separate file (infinity recommend --write machine.json).
// Paths are relative to this folder. Run it with:  infinity run . --machine machine.json --view   (task.mts: always an ES module, whatever package.json is above)
export default {
  preset: "code",
  name: "my-task",
  summary: "One line about the task",

  // The problem, in words: the goal, what the agents see, what to hand in (the "submit" tool: a command, the files it made, and the result), what is forbidden.
  prompt:
    "Find the whole number from 0 to 100 that is the best you can justify and write it alone into answer.txt in your directory (this is only an example task: replace this text with your own problem). Submit with the command that made it and the file answer.txt.",

  // Folders or files the agents may read (a read-only copy appears as data/<name> in every agent's directory).
  data: {},

  // Things only the evaluator may read (test labels, secret inputs); they are moved away while the agents run and put back at the end.
  // The evaluator finds their private paths in INFINITY_HIDDEN_0, INFINITY_HIDDEN_1, ...
  hidden: [],

  // How a submit is scored: a program (run with "python3" here) that prints one JSON line {"score": 12, "details": "words for the agent"}.
  // It finds the agent's directory in INFINITY_WORK_DIR. Never put hidden data into "details": the agent reads it.
  evaluate: { program: "evaluate.py", run: "python3" },
  metric: { name: "score", direction: "max" }, // "max": larger is better; "min": smaller is better (time, loss)

  // When the run ends by itself: "until-stopped" (Ctrl-C, token budget, wall limit) or { targetScore: 100 }.
  stop: "until-stopped",
  tokens: 2_000_000,
  wallMinutes: 30,
};
`;

const MATH_FORM = `// A math task: agents prove one statement in Lean 4 (core library, no Mathlib). The run ends at the first proof the local Lean accepts.
// Run it with:  infinity run . --agents 3 --view
export default {
  preset: "math",
  name: "my-statement",
  // The Lean source of a proposition. The proof must be "theorem main : Statement.Goal".
  statement: "∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1",
  // prompt: "Extra words for the agents (optional).",
  tokens: 1_000_000,
  wallMinutes: 20,
};
`;

const EVALUATE_PY = `"""Example evaluator: replace it with your own scoring.

It is started by Infinity outside the agents' shell, for every submit. Environment:
  INFINITY_WORK_DIR   the agent's directory (read the files it handed in)
  INFINITY_HIDDEN_0   private path of the first "hidden" entry of the form (INFINITY_HIDDEN_1, ... for more)
It must print one JSON line last: {"score": <number or null>, "metrics": {...}, "details": "<words for the agent>"}.
Print {"score": null, "details": "why"} when the submit is unusable. Do not put hidden data into "details".
"""
import json
import os
import sys

path = os.path.join(os.environ["INFINITY_WORK_DIR"], "answer.txt")
try:
    value = float(open(path).read().strip())
except (OSError, ValueError):
    print(json.dumps({"score": None, "details": "answer.txt must exist and hold one number."}))
    sys.exit(1)
# A real evaluator must also refuse results that are out of range or that exploit the scoring: agents will try.
if not 0 <= value <= 100:
    print(json.dumps({"score": None, "details": "the number must be between 0 and 100."}))
    sys.exit(1)
print(json.dumps({"score": value, "details": f"read {value}"}))
`;

/** `infinity new <preset> <folder>`: writes the form (and, for code, the example evaluator); never overwrites. */
export function scaffold(argv: string[]): string[] {
  const [preset, folder, ...rest] = argv;
  if ((preset !== "code" && preset !== "math") || !folder || rest.length > 0) throw new Error(NEW_HELP);
  const dir = resolve(folder);
  const files: [string, string][] = [[join(dir, "task.mts"), preset === "code" ? CODE_FORM : MATH_FORM]];
  if (preset === "code") files.push([join(dir, "evaluate.py"), EVALUATE_PY]);
  for (const [path] of files) if (existsSync(path)) throw new Error(`${path} exists already; nothing was written`);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of files) writeFileSync(path, content);
  return files.map(([path]) => path);
}

/** `infinity recommend`: prints the recommendation and optionally writes the machine file. */
export async function recommend(argv: string[]): Promise<string[]> {
  const args = [...argv];
  const take = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = args.splice(at, 2)[1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value\n${RECOMMEND_HELP}`);
    return value;
  };
  const task = take("task");
  const write = take("write");
  if (args.length > 0) throw new Error(`not understood: ${args.join(" ")}\n${RECOMMEND_HELP}`);
  const profile = task ? ((await loadTaskPackage(task)).profile ?? {}) : {};
  const recommendation = await recommendRun(profile);
  const lines = [...recommendation.lines];
  const cpu = cpuOf(profile);
  if (write) {
    const config = machineConfigFrom(recommendation.capacity, cpu);
    writeMachineConfig(write, config, "Made by infinity recommend; edit freely. Flags of a run win over this file.");
    lines.push(`Wrote ${write}: ${JSON.stringify(config)}`);
  }
  return lines;
}
