# Infinity

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/sakura-infinity)](https://www.npmjs.com/package/sakura-infinity)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Many coding agents on one task. Every attempt is scored; you keep the best.**

Infinity runs 1 to 100 agents in parallel on one task and scores each submission with your evaluator: a model's accuracy on hidden data, the speed of a program, a loss, or a Lean 4 proof. It is built on [Sakura](https://github.com/Vist233/Sakura), a complete coding agent you can build with, and published on npm as `sakura-infinity`.

## Why Infinity

Running more agents is easy; getting more out of them is not. Agents spend most of their time waiting for the model, while training a model or running a test suite needs the CPU. Infinity keeps those apart: **how many agents explore and how many heavy jobs run at once are separate limits.**

In a 16 vCPU capacity test (about 4.5 hours of runs), adding agents alone raised `load/core` from 1.63 to 1.97 without a stable gain in score. With 16 agents sharing 8 heavy-work slots, `load/core` fell to about 1.02 and the first scored result came after 16.5 minutes instead of 29.3. The GPU sat near 0%: the bottleneck of that task was the CPU. These are the results of one task on one machine, not a guarantee.

## Quick start

You need Node 22.18 or newer and a key of DeepSeek, OpenAI or Anthropic. Math tasks also need Lean 4 (`curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`); code tasks need whatever your evaluator runs (Python for the template).

```sh
npm install -g sakura-infinity
export DEEPSEEK_API_KEY=...   # or INFINITY_PROVIDER=openai with OPENAI_API_KEY, or anthropic with ANTHROPIC_API_KEY

infinity run math-parity --agents 3 --view   # a bundled example: prove "n % 2 = 0 or n % 2 = 1"; ends at the first accepted proof

infinity new code my-task                    # my-task/task.mts (the form) and my-task/evaluate.py (an example scorer)
# edit the prompt in task.mts and the scoring in evaluate.py, then:
infinity run ./my-task --agents 4 --wall-minutes 30 --view
```

`--view` opens the run page at `http://127.0.0.1:4173/`: the best result first (score, agent, commit, folder), then time and tokens against their limits, the score over time and the agents. `infinity --help` lists every flag; `infinity recommend --write machine.json` saves what this computer can carry.

The key is read from the environment once and removed from it: the agents' commands never see it, and it is never printed or written. `INFINITY_MODEL` picks another model of the chosen provider.

## How a run works

- **A task is a form.** The problem in words, what the agents may see, what is hidden, and a program that scores a submission. What the computer can carry is a separate machine file. Any "improve a result" task fits.
- **Two tool kits.** The `code` preset gives each agent `read`, `write`, `edit`, `bash`, `submit` and `handoff`; a submit is a command, listed files and a commit, scored by your evaluator on data the agents cannot see. The `math` preset gives file tools and a `lean` check; the Lean verifier is the evaluator, and the run ends at the first accepted proof.
- **A ladder of agents.** The run starts with one agent and doubles (1, 2, 4 … up to your ceiling) while the provider does not throttle; a throttling answer drops one rung, and a used-up quota stops the run.
- **Pools for heavy work.** CPU slots (`--slots N`), evaluation slots, Lean slots and GPU slots cap what runs at once, whatever the number of agents.
- **Hidden data stays hidden.** Labels are moved to a private path with a journal while the agents work and put back at the end, also on Ctrl-C and on a crash.
- **Everything is a file.** Each agent works in its own Git directory with a commit after every turn; the ledger, events, leaderboard and report are written to the run directory, and the viewer only reads them.
- **Stop rules.** First proof, target score, token budget, wall time, quota, or your stop.

## Built on Sakura

Each agent is a Sakura agent with its own work directory, session file, tools and goal. Two reviewers use Sakura's composition:

- **Safety review.** Sakura's review plugin judges risky commands; in front of it, Infinity's rules refuse pushing, ssh, uploads, killing by name, credential files, the hidden data, other agents' directories and the run's own files. `review: false` in a task switches it off, and the report says so.
- **Branch review (optional).** Every few minutes an agent's conversation is forked into a reviewer with the same model, system text and tools, so the provider's cache still applies, but a guard lets it only `read` files in the agent's directory. It answers `OK` or gives short advice, which is steered into the agent marked as not coming from the user. The scheduling, results and lifecycle are Infinity's code; Sakura provides the session fork, assembly, plugins and execution boundary. Its benefit is not measured and it costs tokens (about half of them in one real run); `--no-review` leaves it out.

## Your own task

```sh
infinity recommend --write machine.json   # what this computer can carry (agents, slots, threads); edit it if you like
infinity new code my-task                 # or: infinity new math my-statement
infinity run ./my-task --machine machine.json --view
```

The form's fields and the rules for a good evaluator are in [AGENT-GUIDE.md](AGENT-GUIDE.md), written for an AI or a script that runs Infinity too. [`tasks/covertype/task.ts`](tasks/covertype/task.ts) is a complete real example: predict the forest cover type (7 classes), scored by accuracy on hidden labels.

## Results of a run

Each run writes `runs/<task>-<time>/`:

| File | What it holds |
|---|---|
| `report/report.html` | leaderboard, score over time, reviews, warnings |
| `report/leaderboard.csv` | one row per scored result: agent, score, commit, work directory |
| `ledger.jsonl` | what each agent did; `result` lines are submissions |
| `events.jsonl` | rungs, throttles, reviews, refusals, warnings, `run_end` |
| `machine.jsonl` | machine readings every 5 s (Linux only) |
| `agents/NNN/work/` | one Git repository per agent; the best solution is the commit in the first row of the leaderboard |

The last line printed is the outcome, for example `{"reason":"target","tokensUsed":8781,"bestScore":1}`.

- **Viewer.** `infinity view runs` serves a read-only page for a running or finished run. It binds to `127.0.0.1`, answers GET only and never writes into a run. On a remote machine forward the port (`ssh -L 4173:127.0.0.1:4173 host`), or share it with `--host 0.0.0.0 --token <secret>`.
- **Stop.** Ctrl-C, SIGTERM or `stop()` stops the agents in order, restores hidden labels and writes the report. `--wall-minutes N` and `--tokens N` set limits.
- **Resume.** `infinity run <task> --resume runs/<run> <the same flags>` reopens the sessions and work directories. After a hard kill (`kill -9`, power loss), put hidden labels back first: `node examples/recover-hidden.ts runs/<run>/.keeper` from a clone.

## Use it from code or from an agent

```ts
import { startRun } from "./src/launch.ts";
import { createInfinityTools } from "./src/sakura-tools.ts";
import { formPackage } from "./src/form.ts";
import form from "./tasks/covertype/task.ts";

const covertype = formPackage(form, "./tasks/covertype");
const run = await startRun(covertype, { model, agents: 8, wallMinutes: 45 }); // returns at once; the run goes on in this process
console.log(run.status());                                                     // state, agents alive, tokens, best score
await run.stop();                                                              // ends the run in order and waits

// infinity_run, infinity_status, infinity_stop and infinity_recommend as tools for a Sakura agent
const tools = createInfinityTools({ packs: [covertype], model });
```

These imports work from a clone of this repository.

## Limits

- **Linux for full function.** On macOS a run works, but machine readings, command limits and the cleanup of leftover processes are not supported; the report says so.
- **No sandbox.** The code agents run and Lean proof files have your user's rights, network included. The rules and the review lower the risk and prove nothing. Use a machine you can afford to lose files on, without secrets in the home directory.
- **Hidden labels are not blocked by the operating system.** They are moved to an unguessable path during the run; a shell can read what your user can read.
- **Not verified:** runs above 8 agents on macOS, GPU pools on real hardware, and the benefit of the branch review.

<details>
<summary>Lean safety</summary>

A proof file is a program: Lean runs code at compile time (`#eval`, macros, `initialize`). There is no sandbox by default. Instead the Lean process gets a clean environment (only `PATH`, `HOME`, `LEAN_PATH`; no keys), the math agents have no shell and their file tools are confined to their work directory, and a deny-list rejects `#eval`, macros, `elab`, `initialize`, `unsafe`, `extern` and other imports at `submit` (it is not a boundary). `sandbox: true` in a task confines every Lean process on macOS with `sandbox-exec`; there is no sandbox on Linux in this version.

The check accepts a proof only if it compiles, has no `sorry`, depends only on `propext`, `Classical.choice` and `Quot.sound`, and `theorem main` has exactly the type `Statement.Goal`.

</details>

## Development

```sh
git clone https://github.com/Vist233/infinity_Agents.git infinity-agent
cd infinity-agent
npm ci
npm run check            # types, lint, format, tests (about 3 minutes; uses real Lean when it is installed)
node bin/infinity.ts run math-parity --agents 1
```

From a clone, `node bin/infinity.ts` takes the place of `infinity`. For the Covertype example: `python3 -m venv .venv-ml && .venv-ml/bin/pip install numpy pandas scikit-learn`, then `.venv-ml/bin/python tasks/covertype/prepare.py 150000` once.

## License

MIT, see [LICENSE](LICENSE).
