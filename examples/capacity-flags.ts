import { type Capacity, type TaskProfile, cpuOf, describeCapacity, recommendCapacity } from "../src/capacity.ts";
import { readMachineFacts } from "../src/proc-readings.ts";
import { MAX_AGENTS } from "../src/task.ts";

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

/** The profile of a task, with the command line's `--threads`, `--mem-gb` and `--heavy-share` laid over what the example says (they change the CPU part). */
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

/** Prints what this machine can carry and returns the number of agents to use: the user's own (`--agents N`, or the old first number) always wins. */
export async function chooseAgents(
  profile: TaskProfile,
  requested: number | undefined,
): Promise<{ agents: number; capacity: Capacity; foreignBusyCores: number }> {
  const facts = await readMachineFacts();
  const capacity = recommendCapacity(facts, profile);
  console.log(describeCapacity(capacity, requested));
  if ((facts.busyCores ?? 0) >= 0.5)
    console.log(`Foreign load: about ${(facts.busyCores ?? 0).toFixed(1)} cores are busy with other work; they are left out of the slots and only measured.`);
  return { agents: Math.min(MAX_AGENTS, requested ?? capacity.agents), capacity, foreignBusyCores: facts.busyCores ?? 0 };
}
