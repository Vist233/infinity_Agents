import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { DifferentFilesystemError, HiddenKeeper, restoreOnExit } from "../src/hidden-keeper.ts";
import { JsonlFile } from "../src/jsonl.ts";

let root: string;
let keeperDir: string;
let secretFile: string;
let secretDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-keeper-"));
  keeperDir = join(root, ".keeper");
  secretFile = join(root, "labels.csv");
  secretDir = join(root, "eval");
  writeFileSync(secretFile, "id,label\n1,yes\n");
  mkdirSync(join(secretDir, "inner"), { recursive: true });
  writeFileSync(join(secretDir, "inner", "score.py"), "print(1)\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const journal = () => new JsonlFile<{ type: string; id: string; from?: string; to?: string }>(join(keeperDir, "journal.jsonl")).readAll();

describe("HiddenKeeper", () => {
  it("moves a file and a directory away, to unguessable names inside a private directory, and tells where they are", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile, secretDir]);
    expect(existsSync(secretFile)).toBe(false);
    expect(existsSync(secretDir)).toBe(false);
    const privateFile = keeper.privatePath(secretFile);
    expect(readFileSync(privateFile, "utf8")).toContain("label");
    expect(readFileSync(join(keeper.privatePath(secretDir), "inner", "score.py"), "utf8")).toBe("print(1)\n");
    for (const path of [privateFile, keeper.privatePath(secretDir)]) {
      expect(path.startsWith(`${keeperDir}/`)).toBe(true);
      expect(path).toMatch(/\/[0-9a-f]{32}$/); // no part of the original name
    }
    expect(statSync(keeperDir).mode & 0o777).toBe(0o700);
  });

  it("writes the journal line before it moves, and a second line after", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    expect(journal().map((entry) => entry.type)).toEqual(["plan", "moved"]);
    expect(journal()[0]?.from).toBe(secretFile);
  });

  it("hides nothing when one of the paths is bad", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    expect(() => keeper.hide([secretFile, join(root, "missing")])).toThrow("does not exist");
    expect(existsSync(secretFile)).toBe(true);
    expect(journal()).toEqual([]);
  });

  it("refuses a path that is already hidden, or that overlaps the keeper directory", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    expect(() => keeper.hide([secretFile])).toThrow(); // gone from its place, so it does not exist
    expect(() => keeper.hide([keeperDir])).toThrow("overlaps");
    expect(() => keeper.hide([root])).toThrow("overlaps");
  });

  it("refuses a path that was hidden and has been put there again by someone else", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    writeFileSync(secretFile, "a new file with the old name");
    expect(() => keeper.hide([secretFile])).toThrow("already hidden");
  });

  it("refuses data on another filesystem, because a rename cannot cross it", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir, deviceOf: (path) => (path === secretFile ? 99 : 1) });
    expect(() => keeper.hide([secretFile])).toThrow(DifferentFilesystemError);
    expect(existsSync(secretFile)).toBe(true);
  });

  it("does not know a path that was never hidden", () => {
    expect(() => new HiddenKeeper({ dir: keeperDir }).privatePath(secretFile)).toThrow("not hidden");
  });

  it("gives the evaluator the private paths without moving anything", async () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    const seen = await keeper.withHidden(async (paths) => {
      expect(existsSync(secretFile)).toBe(false);
      return readFileSync(paths[secretFile] ?? "", "utf8");
    });
    expect(seen).toContain("label");
    expect(existsSync(secretFile)).toBe(false);
  });

  it("puts everything back, with the same content, and again without harm", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile, secretDir]);
    const report = keeper.restore();
    expect(report.restored.sort()).toEqual([secretDir, secretFile].sort());
    expect(readFileSync(secretFile, "utf8")).toBe("id,label\n1,yes\n");
    expect(readFileSync(join(secretDir, "inner", "score.py"), "utf8")).toBe("print(1)\n");
    expect(keeper.restore()).toEqual({ restored: [], conflicts: [], missing: [] });
    expect(readdirSync(keeperDir)).toEqual(["journal.jsonl"]);
  });

  it("can hide again after a restore", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    keeper.restore();
    keeper.hide([secretFile]);
    expect(existsSync(secretFile)).toBe(false);
  });

  it("never overwrites: if something new stands in the original place, it reports a conflict and keeps both", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    writeFileSync(secretFile, "someone put this here");
    const report = keeper.restore();
    expect(report.conflicts).toEqual([{ from: secretFile, to: keeper.privatePath(secretFile) }]);
    expect(readFileSync(secretFile, "utf8")).toBe("someone put this here");
    expect(readFileSync(keeper.privatePath(secretFile), "utf8")).toContain("label");
  });

  it("reports a plan whose data is nowhere", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    rmSync(keeper.privatePath(secretFile));
    expect(keeper.restore().missing).toEqual([secretFile]);
  });

  it("recovers from a crash between the journal line and the rename: nothing was moved, nothing is lost", () => {
    mkdirSync(keeperDir, { recursive: true });
    new JsonlFile(join(keeperDir, "journal.jsonl")).append({ type: "plan", id: "aa", from: secretFile, to: join(keeperDir, "aa"), ts: 1 });
    const report = HiddenKeeper.recover(keeperDir);
    expect(report).toEqual({ restored: [], conflicts: [], missing: [] });
    expect(readFileSync(secretFile, "utf8")).toContain("label");
  });

  it("recovers from a crash between the rename and the second journal line", () => {
    mkdirSync(keeperDir, { recursive: true });
    new JsonlFile(join(keeperDir, "journal.jsonl")).append({ type: "plan", id: "bb", from: secretFile, to: join(keeperDir, "bb"), ts: 1 });
    renameSync(secretFile, join(keeperDir, "bb"));
    expect(HiddenKeeper.recover(keeperDir).restored).toEqual([secretFile]);
    expect(readFileSync(secretFile, "utf8")).toContain("label");
  });

  it("reads a journal whose last line was torn by a crash", () => {
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    appendFileSync(join(keeperDir, "journal.jsonl"), '{"type":"plan","id":"cc","fr');
    expect(HiddenKeeper.recover(keeperDir).restored).toEqual([secretFile]);
  });
});

describe("restoreOnExit with a stand-in for process", () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const calls = { kill: [] as Array<[number, string]>, exit: [] as number[], stderr: [] as string[] };
    const target = {
      pid: 4242,
      on: (event: string, listener: (...args: any[]) => void) => emitter.on(event, listener as (...args: unknown[]) => void),
      off: (event: string, listener: (...args: any[]) => void) => emitter.off(event, listener as (...args: unknown[]) => void),
      kill: (pid: number, signal: NodeJS.Signals) => calls.kill.push([pid, signal]),
      exit: (code: number) => calls.exit.push(code),
      stderr: { write: (text: string) => calls.stderr.push(text) },
    };
    return { emitter, calls, target };
  }

  it("restores on exit", () => {
    const { emitter, target } = fakeProcess();
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    restoreOnExit(keeper, target);
    emitter.emit("exit");
    expect(existsSync(secretFile)).toBe(true);
  });

  it("restores on a signal, removes its handlers and sends the signal again", () => {
    const { emitter, calls, target } = fakeProcess();
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    restoreOnExit(keeper, target);
    emitter.emit("SIGTERM", "SIGTERM");
    expect(existsSync(secretFile)).toBe(true);
    expect(calls.kill).toEqual([[4242, "SIGTERM"]]);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("restores on an uncaught exception, prints it and exits with 1", () => {
    const { emitter, calls, target } = fakeProcess();
    const keeper = new HiddenKeeper({ dir: keeperDir });
    keeper.hide([secretFile]);
    restoreOnExit(keeper, target);
    emitter.emit("uncaughtException", new Error("boom"));
    expect(existsSync(secretFile)).toBe(true);
    expect(calls.exit).toEqual([1]);
    expect(calls.stderr.join("")).toContain("boom");
  });

  it("says so on stderr when the restore itself fails, and does not throw", () => {
    const { emitter, calls, target } = fakeProcess();
    restoreOnExit(
      {
        restore: () => {
          throw new Error("disk gone");
        },
      } as unknown as HiddenKeeper,
      target,
    );
    expect(() => emitter.emit("exit")).not.toThrow();
    expect(calls.stderr.join("")).toContain("disk gone");
  });

  it("stops watching on dispose", () => {
    const { emitter, target } = fakeProcess();
    const keeper = new HiddenKeeper({ dir: keeperDir });
    restoreOnExit(keeper, target).dispose();
    for (const event of ["exit", "SIGINT", "SIGTERM", "uncaughtException"]) expect(emitter.listenerCount(event)).toBe(0);
  });
});

/** The data must survive whatever happens to the program. These tests run the keeper in a separate process and end it in different ways. */
describe("HiddenKeeper in a separate process", () => {
  const childScript = join(import.meta.dirname, "support", "keeper-child.ts");

  function startChild(mode: string): { child: ChildProcess; hidden: Promise<void>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const child = spawn(process.execPath, [childScript, mode, keeperDir, secretFile], { stdio: ["ignore", "pipe", "ignore"] });
    const hidden = new Promise<void>((resolveHidden) => child.stdout?.on("data", (chunk) => String(chunk).includes("hidden") && resolveHidden()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
    return { child, hidden, exited };
  }

  it("a kill -9 leaves the data hidden and recover() puts it back", async () => {
    const { child, hidden, exited } = startChild("wait");
    await hidden;
    expect(existsSync(secretFile)).toBe(false);
    child.kill("SIGKILL");
    expect((await exited).signal).toBe("SIGKILL");
    expect(existsSync(secretFile)).toBe(false); // nothing could run in the dead process
    expect(HiddenKeeper.recover(keeperDir).restored).toEqual([secretFile]);
    expect(readFileSync(secretFile, "utf8")).toBe("id,label\n1,yes\n");
  }, 30_000);

  it("SIGTERM restores the data by itself and the process still ends by that signal", async () => {
    const { child, hidden, exited } = startChild("wait");
    await hidden;
    child.kill("SIGTERM");
    expect((await exited).signal).toBe("SIGTERM");
    expect(readFileSync(secretFile, "utf8")).toBe("id,label\n1,yes\n");
  }, 30_000);

  it("SIGINT restores the data too", async () => {
    const { child, hidden, exited } = startChild("wait");
    await hidden;
    child.kill("SIGINT");
    expect((await exited).signal).toBe("SIGINT");
    expect(existsSync(secretFile)).toBe(true);
  }, 30_000);

  it("an uncaught exception restores the data and the process fails", async () => {
    const { exited } = startChild("throw");
    expect((await exited).code).toBe(1);
    expect(readFileSync(secretFile, "utf8")).toBe("id,label\n1,yes\n");
  }, 30_000);

  it("a normal exit restores the data", async () => {
    const { exited } = startChild("exit");
    expect((await exited).code).toBe(0);
    expect(readFileSync(secretFile, "utf8")).toBe("id,label\n1,yes\n");
  }, 30_000);
});
