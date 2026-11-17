// What an agent cannot see about its own run, told to it in every request: how long it has worked, whether anything of it counts yet, how much disk it holds.
// A note at the end of the request (not kept in the log), in the same way as Sakura's limits notes. Two reminders when a line is crossed:
// no submit after a while (a run whose agents never submit produces nothing), and a work directory above its share of the disk.
import { execFile } from "node:child_process";
import type { Message, Plugin } from "sakura-agent";

export interface RunNotesOptions {
  /** The agent's work directory. */
  workDir: string;
  /** Submits this agent made before (a resumed agent keeps its count). */
  submitsBefore: number;
  /** After this many minutes without a submit the agent is asked for a baseline (default 20). */
  firstSubmitMinutes?: number;
  /** The work directory's share of the disk in GB; above it the agent is asked to clean up (default 20). */
  workDirGb?: number;
  now: () => number;
  /** How the size of a directory is measured, in bytes (tests replace it). */
  measure?: (dir: string) => Promise<number>;
}

export interface RunNotes extends Plugin {
  /** Called after each submit of this agent. */
  submitted(): void;
}

const MEASURE_EVERY_MS = 2 * 60_000;
const GB = 1024 ** 3;

/** `du -sk`: the size on disk, without reading the files. 0 when it cannot be measured. */
const duBytes = (dir: string): Promise<number> =>
  new Promise((resolve) => {
    execFile("du", ["-sk", dir], { timeout: 60_000 }, (error, stdout) => resolve(error ? 0 : Number.parseInt(stdout, 10) * 1024 || 0));
  });

export function runNotesPlugin(options: RunNotesOptions): RunNotes {
  const startedAt = options.now();
  const firstSubmitMinutes = options.firstSubmitMinutes ?? 20;
  const shareGb = options.workDirGb ?? 20;
  const measure = options.measure ?? duBytes;
  let submits = options.submitsBefore;
  let bytes: number | undefined;
  let measuredAt = Number.NEGATIVE_INFINITY;
  let measuring = false;

  /** Starts a measurement when the last one is old; the note uses the last known size (the request does not wait for the disk). */
  const refreshSize = () => {
    if (measuring || options.now() - measuredAt < MEASURE_EVERY_MS) return;
    measuring = true;
    measuredAt = options.now();
    void measure(options.workDir).then(
      (value) => {
        bytes = value;
        measuring = false;
      },
      () => {
        measuring = false;
      },
    );
  };

  const note = (): string => {
    const minutes = Math.floor((options.now() - startedAt) / 60_000);
    const gb = bytes === undefined ? undefined : bytes / GB;
    const parts = [`${minutes} minutes since you started`, `${submits} submit${submits === 1 ? "" : "s"} so far`];
    if (gb !== undefined) parts.push(`work directory ${gb.toFixed(1)} GB of a ${shareGb} GB share`);
    let text = `[Run: ${parts.join("; ")}.`;
    if (submits === 0 && minutes >= firstSubmitMinutes)
      text += " Nothing of yours counts yet: submit a working baseline now, even a simple one, then improve it.";
    if (gb !== undefined && gb > shareGb)
      text +=
        " Your work directory is over its share of the disk: delete intermediate files you no longer need (old pickles, checkpoints, copies of data) before you make more.";
    return `${text}]`;
  };

  return {
    name: "infinity-run-notes",
    compensates: "an agent cannot see how long it has worked, that nothing of it counts until it submits, or how much disk it fills",
    submitted() {
      submits += 1;
    },
    setup(api) {
      api.on("context", ({ messages }) => {
        refreshSize();
        const message: Message = { role: "user", content: [{ type: "text", text: note() }], ts: options.now() };
        return [...messages, message];
      });
    },
  };
}
