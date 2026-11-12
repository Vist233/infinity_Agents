# infinity-agent (working name)

Run many agents (up to 100) in parallel on one task and rank what they produce. Built on the Sakura agent framework. A task is defined by a piece of TypeScript code; a thin command line only runs it. It runs on the machine where it is started; for a remote machine, install and run it there.

Status: math mode is built and tested with scripted and real components (`npm test`); the first real end-to-end check with a real model is next. Code and machine-learning tasks come after. See `docs/`.

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

Design: `docs/01-owner-decisions.md`, `docs/02-architecture-draft.md`. Dependencies: `sakura-agent` 0.1.1. Note: the machine's npm setting `min-release-age=7` refuses packages younger than 7 days; until then install with `--min-release-age=0` for that one command, or use the tarball in `vendor/`.

## Run a task (math mode)

A task is TypeScript code (`defineTask` plus `runTask`); there is no command line in version 1. See `examples/prove.ts`:

```sh
npm install --min-release-age=0   # first time; the dependency comes from vendor/sakura-agent-0.1.1.tgz
export OPENCODE_API_KEY=...       # the model key; it is only read, never printed or stored
node examples/prove.ts parity 3   # 3 agents, ceiling of the ladder
node examples/prove.ts odd-sum 10 # a statement that needs induction
```

Each run writes `runs/<task>-<time>/`: `ledger.jsonl`, `events.jsonl`, `state.json`, `report/report.html`, `report/leaderboard.csv`, `lean/`, and per agent `agents/NNN/{work/, session.jsonl, proved}`. `work/` is a Git repository with a commit after every turn. A stopped or killed run continues with `runTask(task, { runDir, resume: true })`. Real-run evidence: `docs/test-report.md`.

Tests: `npm test` (about 2 minutes; uses real Lean when it is installed), `npm run check` (types, lint, format, tests), `npm run coverage`.

### Lean and the sandbox
- The program needs `lean` and `lake` on the PATH (install: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`) and stops with that command if they are missing. Mathlib is not needed.
- **Without the sandbox, a proof file is a program that runs with your rights.** Lean runs code at compile time (`#eval`, macros, `initialize`), so a file written by an agent could read or write anything your user can, and use the network. The owner decided that there is no sandbox by default. What is done instead: the Lean process gets a clean environment (only PATH, HOME, LEAN_PATH; no keys), the agents have no shell and their file tools are confined to their work directory, and a deny-list rejects `#eval`, macros, `elab`, `initialize`, `unsafe`, `extern` and other imports at `submit` (it is not a boundary; `check` is not filtered).
- The switch is kept: `sandbox: true` in the task confines every Lean process on macOS with `sandbox-exec` (writes only to its scratch directory, no network, no reading of the home directory except the Lean toolchain). There is no sandbox on Linux in this version.
- The official check (`submit`) accepts a proof only if it compiles, has no `sorry`, depends only on `propext`, `Classical.choice`, `Quot.sound`, and `theorem main` (at the top level) has exactly the type `Statement.Goal`.

## Watch a run in the browser (started by a person, from the terminal)

The run viewer is a read-only page that shows a run while it goes on: the rungs, the scored submits with the best-so-far line, the machine (CPU, load per core, memory, GPU, gate slots in use and waiting), the agents, the reviews and refusals, and the leaderboard. It has no dependencies, binds to `127.0.0.1` only, answers GET only, and never writes into a run directory or controls a run.

```
# started together with a run: the address is printed, the page updates live
node examples/covertype.ts --view            # --view-port N changes the port (default 4173)

# or on its own, in a second terminal, for a running or a finished run
npm run view -- runs                         # a runs directory (newest run opens first) or one run directory
```

Then open `http://127.0.0.1:4173/`. Remote machine: forward the port yourself (`ssh -L 4173:127.0.0.1:4173 host`); the viewer opens no other port.

## Code mode (built; first real check done on a small task)
Code and machine-learning tasks (`mode: "code"`): every agent has a shell (`read`, `write`, `edit`, `bash`) and the `submit` tool; each submit is scored by your evaluator on data the agents cannot see, and the ranking, the report and the ledger use that score. Plans and decisions: `docs/05-general-mode-plan.md`, `docs/10-branch-review-and-first-ml-run-plan.md`, `docs/decisions.md`. An example: `examples/covertype.ts` (data preparation and evaluator in `examples/covertype/`; needs Python with numpy, pandas and scikit-learn, for instance `python3 -m venv .venv-ml`).

The agent chooses the model and training code. A deployment can supply a Sakura tool environment through `runTask({ ... }, { createEnvironment })` to control shell access and available accelerators. See the [Covertype runbook](docs/11-runbook.md#agent-shell-and-accelerators).

Every run also writes `machine.jsonl` (load, CPU, memory, GPU memory every 5 s, with the rung) and shows it in the report; the number of agents is yours to choose, the report only gives a hint (`docs/11-runbook.md`, "How many agents?"). The structure of the code, its core and its components: `docs/13-design-review.md`. The run side (machine readings, limits on commands, slots, cleanup) supports Linux only; the capacity design is `docs/16-capacity-and-command-limits.md`. Where things stand and how to resume: `docs/08-current-state.md`.

- **Branch review (optional, `branchReview`):** every few minutes each agent's conversation is forked; a reviewer with the same model, system text and tools (so the provider's cache applies) may only `read` files in the agent's directory and says `OK` or gives short advice, which is steered into the agent marked as not coming from the user. It is not a gatekeeper and its benefit is not measured (`docs/test-report.md`). It costs tokens: in the one real run, reviews were about half of the tokens counted (cache reads counted in full).
- **Safety review (`review`):** the framework's review plugin judges risky commands; in front of it Infinity's rules refuse pushing, ssh, uploads, killing by name, credential files and the hidden data, other agents' directories and the run's own files. `review: false` switches it off and the report says so in a warning.
- **Hidden data:** moved away with a journal while the agents run and put back at the end (also on Ctrl-C and on a crash of the program; after a kill use `examples/recover-hidden.ts`). The evaluator gets the private path. **The agents' shell is not blocked from reading it by the operating system** (the planned path-deny profile, `ShellGuard`, is not built): the protection is the unguessable path and the review rules, and the report says so.
- The path-deny profile planned in `docs/05` section 15 is described in `docs/06-hiding-data-from-agents.md`. **Tested there:** file reads and renames under the macOS profile, on throwaway files; a Landlock read refusal in a Linux container. **Not tested, so not claimed:** processes started outside the profile through `launchd`, `osascript` or `open`, Spotlight, backups and snapshots, Landlock on bare metal.
- Even with a profile, the evaluator must not return hidden labels in its answer, and a hidden split that can be recomputed from public data is not hidden (covertype is public: the example forbids looking it up, which the rules and the reviewer enforce only as far as they notice).
- Code that agents run has the user's rights (network included); the review lowers the risk and proves nothing.
