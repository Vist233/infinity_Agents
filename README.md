# infinity-agent (math mode)

Run many agents (up to 100) in parallel on one task and rank what they produce. Built on the Sakura agent framework. A task is defined by a piece of TypeScript code; a thin command line only runs it. It runs on the machine where it is started; for a remote machine, install and run it there.

Status: math mode is built and tested with scripted components and with real Lean and a real model on small statements. Code and machine-learning tasks are planned, not built.

Math mode needs a local Lean 4 (installed with `elan`). The program checks `lean --version` and `lake --version` at start and stops with the install command if they are missing; Mathlib is optional and is checked at start when a task asks for it.

## Architecture in one picture

```
 task.ts (run with: node task.ts)
   defineTask({ prompt, agents, mode | tools, review, evaluate?, hidden?, tokens?, stop })
 runTask: one Node process, on the machine where it was started
   Ladder   how many agents live: 1, 2, 4 ... 64, 100 (advance after 3 replies each without throttling; drop one rung on throttling)
   Gate     one shared brake in front of every model request; pauses everybody on a throttling answer; stops everything when the quota is used up
   Budget   counts tokens (cache reads in full); soft stop when  used + inflight x mean request >= budget
   Rescue   a stuck agent is restarted with a message, at most 3 times, then stopped and replaced
   Pools    Lean = CPU cores (a small fair queue)
   Planner  one call at the start: a different strategy hint for every agent
   Verifier "proved" = compiles, no sorry, only the standard axioms, type is exactly Statement.Goal
   Ledger   ledger.jsonl -> leaderboard.csv, report.html
   Agents   1..N: Git work dir (commit every turn), session file outside it, tools read / write / lean, confined, a Goal
```

Every agent is started with a **Goal** (the framework's `goal`), otherwise it would stop on its own after a while. For math the goal's check is `test -f ../proved`, a marker that only the orchestrator writes (outside the agent's confined work directory) when the verifier has accepted a proof.

A task is **started by code**: `node task.ts`. There is no command line in version 1.

Dependency: `sakura-agent` 0.1.1.

## Run a task (math mode)

A task is TypeScript code (`defineTask` plus `runTask`); there is no command line in version 1. See `examples/prove.ts`:

```sh
npm install                       # first time
export OPENCODE_API_KEY=...       # the model key; it is only read, never printed or stored
node examples/prove.ts parity 3   # 3 agents, ceiling of the ladder
node examples/prove.ts odd-sum 10 # a statement that needs induction
```

Each run writes `runs/<task>-<time>/`: `ledger.jsonl`, `events.jsonl`, `state.json`, `report/report.html`, `report/leaderboard.csv`, `lean/`, and per agent `agents/NNN/{work/, session.jsonl, proved}`. `work/` is a Git repository with a commit after every turn. A stopped or killed run continues with `runTask(task, { runDir, resume: true })`.

Tests: `npm test` (about 2 minutes; uses real Lean when it is installed), `npm run check` (types, lint, format, tests), `npm run coverage`.

### Lean and the sandbox
- The program needs `lean` and `lake` on the PATH (install: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`) and stops with that command if they are missing. Mathlib is not needed.
- **Without the sandbox, a proof file is a program that runs with your rights.** Lean runs code at compile time (`#eval`, macros, `initialize`), so a file written by an agent could read or write anything your user can, and use the network. There is no sandbox by default. What is done instead: the Lean process gets a clean environment (only PATH, HOME, LEAN_PATH; no keys), the agents have no shell and their file tools are confined to their work directory, and a deny-list rejects `#eval`, macros, `elab`, `initialize`, `unsafe`, `extern` and other imports at `submit` (it is not a boundary; `check` is not filtered).
- The switch is kept: `sandbox: true` in the task confines every Lean process on macOS with `sandbox-exec` (writes only to its scratch directory, no network, no reading of the home directory except the Lean toolchain). There is no sandbox on Linux in this version.
- The official check (`submit`) accepts a proof only if it compiles, has no `sorry`, depends only on `propext`, `Classical.choice`, `Quot.sound`, and `theorem main` (at the top level) has exactly the type `Statement.Goal`.

## Code mode (planned, not built yet)
Code and machine-learning tasks are planned. What is said here about hidden data is limited to what was tested:
- The evaluator and the hidden data are moved to a private directory with an unguessable name, with a journal, and put back at the end. The agent's shell will run under a profile that denies that one directory (macOS `sandbox-exec`: no read, no write, no rename of the directory or of any ancestor; Linux Landlock), and the file tools get a path check. It does not limit CPU, memory or network.
- **Tested:** file reads and renames under the macOS profile, on throwaway files; a Landlock read refusal in a Linux container. **Not tested, so not claimed:** processes that the shell asks `launchd`, `osascript` or `open` to start outside the profile (they could read the data), Spotlight indexing, backups and snapshots, Landlock on a bare-metal Linux host.
- Without the profile (the fallback), an agent that wants the data can read it. Even with it, the evaluator must not return hidden labels in its answer, and a hidden split that can be recomputed from public data is not hidden.
- The review model is the other boundary for code tasks; it lowers the risk and proves nothing. Code that agents run has the user's rights (network included).
