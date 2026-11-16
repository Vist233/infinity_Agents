# Guide for an AI that runs Infinity Agent

You are an AI (or a script) that has to run many agents on one task and read what they produced. This page is all you need. Everything is also available to a person on the command line; the library and the tools below use the same code.

## The idea in one minute

- A **task form** says what to do and how a result is scored. It is plain data (a TypeScript file `export default {...}`, a JSON file, or an object you pass to the tool).
- A **machine file** says what this computer can carry (how many agents, how many heavy commands at once). It is made by one command and is not part of the task.
- One call starts the run. Many agents work in parallel, each in its own Git directory. Every `submit` of an agent is scored by **your evaluator**, a program you write. The best score ranks.
- You watch the run from its files and stop it when you have enough.

## Step by step

### 1. Look at the machine

Command: `infinity recommend --write machine.json`. Tool: `infinity_recommend`. It reads cores, memory, GPU and other load, and says how many agents and how many heavy commands at once make sense. These are hints; the number of agents is your choice (1 to 100, more than the recommendation adds nothing).

### 2. Write the form

Start from a template: `infinity new code my-task` (or `math`). It writes `my-task/task.ts` and, for code, an example `evaluate.py`.

The fields (a field that does not belong to the preset is refused with a message):

| Field | Preset | Meaning |
|---|---|---|
| `preset` | both | `"code"`: agents have a shell and `submit`. `"math"`: agents prove one Lean 4 statement (file tools and a `lean` check; no shell); the score is 1 for an accepted proof. |
| `name`, `summary` | both | Name for the report; one line for `--help`. |
| `prompt` | code (required), math (extra words) | The problem in words. Say the goal, what the agents see, what to hand in, what is forbidden. |
| `statement` | math (required) | The Lean source of a Prop. The proof must be `theorem main : Statement.Goal`. |
| `data` | code | `{ name: path }`: each name is a link in the agent's work directory to a read-only copy. For example, `{ data: "./inputs" }` exposes `data/`. |
| `hidden` | code | Paths only the evaluator may read (test labels, secret inputs). Moved away while the agents run, put back at the end. The evaluator finds their private paths in `INFINITY_HIDDEN_0`, `INFINITY_HIDDEN_1`, ... |
| `evaluate` | code | `{ program, run?, args?, timeoutMinutes? }` (a program, started outside the agents' shell) or, in TypeScript only, a function. |
| `metric` | code | `{ name, direction: "max" \| "min" }`; required with `evaluate`. |
| `stop` | code | `"until-stopped"` (default) or `{ targetScore }`. A math task always ends at the first accepted proof (leave `stop` out). |
| `review` | code | The safety review of agents' shell commands: on by default, `false` switches it off (the report says so). |
| `tokens`, `wallMinutes` | both | Token budget; the run ends in order after this many minutes. |
| `profile` | both | What one heavy command needs (`{ cpu: { threadsPerJob, memPerJobGb, heavyShare } }`); the recommendation reads it. |
| `evalSlots`, `submitIntervalMinutes`, `evalTimeoutMinutes` | code | Scoring at once (default 2); least minutes between two submits of one agent; longest scoring. |
| `leanPool`, `sandbox` | math | Lean processes at once; confine Lean with the macOS sandbox. |

Paths are relative to the folder of the form file (or to `formDir` when you pass the form to the tool).
Keep hidden labels outside every visible input directory. Keep the evaluator outside the visible inputs as well.

### 3. Write the evaluator (code preset)

It is a program in any language. Infinity starts it for every `submit`, outside the agents' shell:

- environment: `INFINITY_WORK_DIR` (the agent's directory), `INFINITY_COMMIT`, `INFINITY_HIDDEN_0`, `INFINITY_HIDDEN_1`, ...; only PATH, HOME and LANG of the parent's environment are passed on (no key);
- it must print, as its last line, one JSON object: `{"score": 0.93, "metrics": {"other": 1}, "details": "words for the agent"}`;
- on an unusable submit print `{"score": null, "details": "why"}`.

Rules that matter, because agents **will** try to win by the cheapest means:
- Check the range and the format of what you read (a number out of range, a wrong length, missing columns), and say so in `details`.
- **Never put hidden data in `details`.** The agent reads it. Do not return labels, row values or anything one can decode them from.
- Keep the evaluator program outside what the agents can read; the loader lists it as protected automatically.
- If the score can be raised by something that is not the goal (hard-coding the hidden inputs, timing noise, reading the public source of the answer), the agents will find it. Say it is forbidden in the `prompt` and make the evaluator check for it.
- For a task such as "make this program faster": run the agent's program on **hidden** inputs, check the output first (a wrong answer scores `null`), then measure time (`direction: "min"`). Repeat the timing and take the median.

### 4. Start

Command:

```sh
infinity run ./my-task/task.ts --machine machine.json --agents 4 --wall-minutes 30 --view
```

Flags win over the machine file. `--no-review` leaves the branch review out (it can cost about half of the tokens). `infinity --help` lists every flag; conflicting flags are refused with a message.

Tool: `infinity_run` with `{ form: {...}, formDir: "/abs/folder", agents: 4, wallMinutes: 30 }` (or `{ task: "<known task>" }`). It returns at once; the run goes on in the same process.

Library: `startRun(formPackage(form, baseDir), { model, agents, wallMinutes })`, see `src/launch.ts` and `src/form.ts`.

### 5. Read the run

- `infinity_status` (or `handle.status()`): state, agents alive, tokens, best score, warnings, the newest events.
- Files in `runs/<name>-<time>/`: `report/report.html`, `report/leaderboard.csv`, `ledger.jsonl` (`result` lines are scored submits), `events.jsonl`, `machine.jsonl`, `agents/NNN/work/` (one Git repository per agent; the best solution is the commit named in the first row of the leaderboard).
- A person can look at it live: `infinity view runs` (read-only page on 127.0.0.1).

### 6. Stop and resume

`infinity_stop` (or Ctrl-C, `handle.stop()`): agents stopped in order, report written, hidden data put back. Resume: `infinity run <same task> --resume runs/<run>` with the same flags.

## Choosing the numbers

- **Agents:** start with the recommendation or smaller. More agents help only while the machine and the provider keep up; on throttling the ladder drops a rung by itself.
- **Budget:** always set `tokens` or `wallMinutes` for a first run. Reviews cost tokens.
- **A small first run** (2 agents, 10 to 20 minutes) shows whether the prompt and the evaluator work before you spend more.

## What is not guaranteed

- Agents' shells run with the user's rights; there is no sandbox. The safety review and Infinity's rules lower the risk and prove nothing. Do not run it where secrets are within reach.
- Hidden data is protected by a private path and by review rules, not by the operating system.
- Machine readings and process cleanup need Linux; elsewhere a warning says what is missing.
- The model key is read from the environment (`OPENCODE_API_KEY`, or `COMMANDCODE_API_KEY` with `INFINITY_PROVIDER=commandcode`) and never printed. Do not print the environment.

## Common mistakes

| Message or symptom | Cause |
|---|---|
| `Invalid form ...: unknown field 'x'` | A field name is misspelled, or belongs to the other preset. |
| `metric is required with evaluate` | An evaluator needs a metric, and a metric needs an evaluator. |
| Many submits with `score: null` | The evaluator rejects what the agents hand in; read `details` in `ledger.jsonl` and fix the prompt or the evaluator message. |
| A score that is too good | The evaluator can be gamed; see the rules in step 3. |
| No scored submit for a long time | The commands are slow on this machine (use a smaller data sample), or only one heavy command runs at a time (`slots`). |
