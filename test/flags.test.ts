import { describe, expect, it } from "vitest";
import { parseRunArgs, takeNumber, takeSwitch } from "../bin/flags.ts";

describe("flag helpers", () => {
  it("take a number and a switch out of the argument list and leave the rest", () => {
    const args = ["3", "--tokens", "500", "--no-gate", "resume", "dir"];
    expect(takeNumber(args, "tokens")).toBe(500);
    expect(takeSwitch(args, "no-gate")).toBe(true);
    expect(takeSwitch(args, "no-gate")).toBe(false);
    expect(takeNumber(args, "tokens")).toBeUndefined();
    expect(args).toEqual(["3", "resume", "dir"]);
    expect(() => takeNumber(["--tokens", "many"], "tokens")).toThrow("--tokens needs a number");
  });
});

describe("infinity run: the arguments", () => {
  it("a task alone takes every default: the gate on, the review on, the agents left to the recommendation", () => {
    const { task, options, view } = parseRunArgs(["covertype"]);
    expect(task).toBe("covertype");
    expect(options.gate).toBe(true);
    expect(options.agents).toBeUndefined();
    expect(options.review).toBeUndefined();
    expect(view).toBeUndefined();
  });

  it("reads the numbers and switches in any order and keeps the command line for the run facts", () => {
    const argv = [
      "--agents",
      "16",
      "covertype",
      "--tokens",
      "500",
      "--slots",
      "6",
      "--review-minutes",
      "7",
      "--threads",
      "3",
      "--pressure-brake",
      "--view",
      "--view-port",
      "5000",
    ];
    const { task, options, view } = parseRunArgs(argv);
    expect(task).toBe("covertype");
    expect(options).toMatchObject({ agents: 16, tokens: 500, gate: 6, review: { everyMinutes: 7 }, threads: 3, pressureBrake: true, commandLine: argv });
    expect(view).toEqual({ port: 5000 });
  });

  it("--no-review and --no-gate are read; --resume and --runs-dir take a path", () => {
    const { options } = parseRunArgs(["covertype", "--no-review", "--no-gate", "--resume", "runs/x", "--runs-dir", "elsewhere"]);
    expect(options).toMatchObject({ review: false, gate: false, resume: "runs/x", runsDir: "elsewhere" });
  });

  it("refuses conflicting flags, unknown flags, a missing task and a missing value, with a message that says what is wrong", () => {
    expect(() => parseRunArgs(["t", "--no-review", "--review-minutes", "5"])).toThrow("--no-review cannot be used with --review-minutes");
    expect(() => parseRunArgs(["t", "--review-minutes", "5", "--no-review"])).toThrow("--no-review cannot be used with --review-minutes");
    expect(() => parseRunArgs(["t", "--no-gate", "--slots", "4"])).toThrow("--no-gate cannot be used with --slots or --gate");
    expect(() => parseRunArgs(["t", "--no-gate", "--gate"])).toThrow("--no-gate cannot be used with --slots or --gate");
    expect(() => parseRunArgs(["t", "--agentz", "3"])).toThrow("not understood: --agentz");
    expect(() => parseRunArgs([])).toThrow("say which task to run");
    expect(() => parseRunArgs(["--agents", "3"])).toThrow("say which task to run");
    expect(() => parseRunArgs(["t", "--agents"])).toThrow("--agents needs a number");
    expect(() => parseRunArgs(["t", "--resume"])).toThrow("--resume needs a value");
  });
});
