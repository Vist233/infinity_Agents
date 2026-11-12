import { type TaskProfile, cpuOf } from "../src/capacity.ts";
import { type LaunchOptions, recommendRun } from "../src/launch.ts";

/** Takes `--name value` out of the argument list; undefined when it is not there. */
export function takeNumber(args: string[], name: string): number | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = Number(args.splice(at, 2)[1]);
  if (!Number.isFinite(value)) throw new Error(`--${name} needs a number`);
  return value;
}

/** Takes `--name` (a switch without a value) out of the argument list. */
export function takeSwitch(args: string[], name: string): boolean {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
}

/** The profile of a task, with the command line's `--threads`, `--mem-gb` and `--heavy-share` laid over it (they change the CPU part). */
export function profileWithFlags(base: TaskProfile, args: string[]): TaskProfile {
  const threadsPerJob = takeNumber(args, "threads");
  const memPerJobGb = takeNumber(args, "mem-gb");
  const heavyShare = takeNumber(args, "heavy-share");
  return {
    ...base,
    cpu: {
      ...cpuOf(base),
      ...(threadsPerJob === undefined ? {} : { threadsPerJob }),
      ...(memPerJobGb === undefined ? {} : { memPerJobGb }),
      ...(heavyShare === undefined ? {} : { heavyShare }),
    },
  };
}

/** Prints what this machine can carry and returns the number of agents to use: the user's own always wins (for the synthetic benchmarks, which have no task package). */
export async function chooseAgents(profile: TaskProfile, requested: number | undefined) {
  const recommendation = await recommendRun(profile, requested);
  for (const line of recommendation.lines) console.log(line);
  return { agents: recommendation.agents, capacity: recommendation.capacity, foreignBusyCores: recommendation.foreignBusyCores };
}

export const RUN_HELP = `usage: infinity run <task> [flags]

<task>  a task of tasks/ (for example covertype), or the path of a module that exports a task package
Flags:
  --agents N          number of agents; always wins over the machine's recommendation (printed first)
  --tokens N          token budget
  --wall-minutes N    end the run in order after N minutes
  --review-minutes N  minutes between two branch reviews of one agent (default 3)
  --no-review         leave the branch review out (not with --review-minutes)
  --threads N         threads per command (default 2), --mem-gb N memory per command, --heavy-share X share of time in heavy commands
  --slots N           CPU slots: at most N heavy commands at once (default: the recommended number); --gate is the default; --no-gate turns it off (not with --slots)
  --pressure-brake    hold the ladder while the machine is under pressure
  --command-minutes N longest a single command may run (default 120)
  --runs-dir DIR      where runs are created (default runs)
  --resume DIR        continue a stopped run
  --view [--view-port N]  also serve the read-only run viewer while the run goes on (default port 4173)
The model key is read from OPENCODE_API_KEY (COMMANDCODE_API_KEY with INFINITY_PROVIDER=commandcode) and never printed.`;

export interface RunCommand {
  task: string;
  options: Omit<LaunchOptions, "model">;
  view: { port: number } | undefined;
}

const VALUE_FLAGS = ["agents", "tokens", "wall-minutes", "review-minutes", "threads", "mem-gb", "heavy-share", "slots", "command-minutes", "view-port"];
const SWITCHES = ["no-review", "gate", "no-gate", "pressure-brake", "view"];

/** The arguments after `infinity run`. Unknown flags and conflicting flags are errors, said in words. */
export function parseRunArgs(argv: string[]): RunCommand {
  const args = [...argv];
  const value = (name: string): number | undefined => takeNumber(args, name);
  const text = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const given = args.splice(at, 2)[1];
    if (!given || given.startsWith("--")) throw new Error(`--${name} needs a value`);
    return given;
  };
  const runsDir = text("runs-dir");
  const resume = text("resume");
  const numbers = Object.fromEntries(VALUE_FLAGS.map((name) => [name, value(name)]));
  const on = Object.fromEntries(SWITCHES.map((name) => [name, takeSwitch(args, name)]));
  const [task, ...rest] = args;
  if (!task || task.startsWith("--")) throw new Error("say which task to run: infinity run <task> [flags]");
  if (rest.length > 0) throw new Error(`not understood: ${rest.join(" ")}`);
  if (on["no-review"] && numbers["review-minutes"] !== undefined) throw new Error("--no-review cannot be used with --review-minutes");
  if (on["no-gate"] && (numbers.slots !== undefined || on.gate)) throw new Error("--no-gate cannot be used with --slots or --gate");
  const gate = on["no-gate"] ? false : (numbers.slots ?? true);
  const options: RunCommand["options"] = {
    gate,
    ...(numbers.agents === undefined ? {} : { agents: numbers.agents }),
    ...(numbers.tokens === undefined ? {} : { tokens: numbers.tokens }),
    ...(numbers["wall-minutes"] === undefined ? {} : { wallMinutes: numbers["wall-minutes"] }),
    ...(on["no-review"] ? { review: false as const } : numbers["review-minutes"] === undefined ? {} : { review: { everyMinutes: numbers["review-minutes"] } }),
    ...(numbers.threads === undefined ? {} : { threads: numbers.threads }),
    ...(numbers["mem-gb"] === undefined ? {} : { memGb: numbers["mem-gb"] }),
    ...(numbers["heavy-share"] === undefined ? {} : { heavyShare: numbers["heavy-share"] }),
    ...(on["pressure-brake"] ? { pressureBrake: true } : {}),
    ...(numbers["command-minutes"] === undefined ? {} : { commandMinutes: numbers["command-minutes"] }),
    ...(runsDir === undefined ? {} : { runsDir }),
    ...(resume === undefined ? {} : { resume }),
    commandLine: argv,
  };
  return { task, options, view: on.view ? { port: numbers["view-port"] ?? 4173 } : undefined };
}
