import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, type Host, LinuxHost } from "../src/host.ts";

/** A stat line the readers can parse. */
const stat = (pid: number, comm = "sleep", state = "S") => `${pid} (${comm}) ${state} 1 1 1 0 -1 0 0 0 0 0 7 3 0 0 20 0 2 0 5 1000 50 0`;

interface Setup {
  host: Host;
  /** A process that is alive, one that is not, and a program that exists. */
  alive: number;
  dead: number;
  program: string;
  /** What the host must report when a file is asked for that is not there. */
  hasProc: boolean;
}

/**
 * What every Host has to do, whatever it stands on: the same questions, the same kinds of answers. FakeHost answers from a table (so it runs everywhere);
 * LinuxHost answers from the real machine (so it runs on Linux only).
 */
function contract(name: string, make: () => Setup) {
  describe(`Host contract: ${name}`, () => {
    it("tells the system: a platform name, at least one core, three load averages, memory figures and a release string", () => {
      const { host } = make();
      expect(host.platform.length).toBeGreaterThan(0);
      expect(host.cpuCount()).toBeGreaterThanOrEqual(1);
      expect(host.loadAverage()).toHaveLength(3);
      expect(host.loadAverage().every((value) => Number.isFinite(value))).toBe(true);
      expect(host.totalMemoryBytes()).toBeGreaterThan(0);
      expect(host.freeMemoryBytes()).toBeGreaterThanOrEqual(0);
      expect(host.release().length).toBeGreaterThan(0);
    });

    it("reads /proc files as text and says undefined for one that is not there", () => {
      const { host, hasProc } = make();
      expect(host.hasProc()).toBe(hasProc);
      expect(host.readProc("this/file/is/not/there")).toBeUndefined();
      if (hasProc) expect(host.readProc("stat")).toContain("cpu");
    });

    it("lists processes with their stat text, a working directory only when asked, and no more than the cap", () => {
      const { host, alive, hasProc } = make();
      const all = host.processes();
      if (!hasProc) return expect(all).toEqual([]);
      expect(all.some((process) => process.pid === alive)).toBe(true);
      expect(all.every((process) => Number.isInteger(process.pid) && process.stat.includes("("))).toBe(true);
      expect(all.every((process) => process.cwd === undefined)).toBe(true);
      expect(host.processes({ cwd: true }).some((process) => process.pid === alive && typeof process.cwd === "string")).toBe(true);
      expect(host.processes({ cap: 1 }).length).toBeLessThanOrEqual(1);
    });

    it("knows whether a process is alive, signals one that is, and throws for one that is gone", () => {
      const { host, alive, dead, hasProc } = make();
      if (!hasProc) return;
      expect(host.isAlive(alive)).toBe(true);
      expect(host.isAlive(dead)).toBe(false);
      expect(() => host.signal(alive, "SIGCONT")).not.toThrow();
      expect(() => host.signal(dead, "SIGTERM")).toThrow();
    });

    it("sets a priority for a process that is there (true) and says false for one that is not", async () => {
      const { host, dead } = make();
      expect(await host.setPriority(dead, 5)).toBe(false);
    });

    it("answers a GPU query with text or undefined, a program check with a boolean, the commit with text or undefined, and a real path with a string", async () => {
      const { host, program } = make();
      const query = await host.gpuQuery("--query-gpu=memory.total");
      expect(query === undefined || typeof query === "string").toBe(true);
      expect(await host.hasProgram(program)).toBe(true);
      expect(await host.hasProgram("no-such-program-xyz")).toBe(false);
      const commit = await host.gitCommit();
      expect(commit === undefined || typeof commit === "string").toBe(true);
      expect(host.realPath("/no/such/path/xyz")).toBe("/no/such/path/xyz");
    });
  });
}

const fake = (): Setup => ({
  host: new FakeHost({
    files: { stat: "cpu  1 2 3 4\n", meminfo: "MemTotal: 1 kB\n" },
    processes: [
      { pid: 4242, stat: stat(4242), cwd: "/work" },
      { pid: 4243, stat: stat(4243, "python3"), cwd: "/work/agents/001" },
    ],
    programs: ["sh"],
  }),
  alive: 4242,
  dead: 99_999,
  program: "sh",
  hasProc: true,
});

contract("FakeHost", fake);
contract("FakeHost without /proc", () => ({ ...fake(), host: new FakeHost({ proc: false, programs: ["sh"] }), hasProc: false }));

describe.skipIf(process.platform !== "linux")("[Linux only, skipped on other systems] LinuxHost on the real machine", () => {
  contract("LinuxHost (real /proc)", () => ({ host: new LinuxHost(), alive: process.pid, dead: 2 ** 22 + 12_345, program: "sh", hasProc: true }));

  it("reads the real working directory of this process and the real kernel release", () => {
    const host = new LinuxHost();
    const mine = process.pid;
    expect(host.processes({ cwd: true }).find((entry) => entry.pid === mine)?.cwd).toBe(realpathSync(process.cwd()));
    expect(host.readProc("sys/kernel/osrelease")?.trim().length).toBeGreaterThan(0);
    expect(host.readProc("self/stat")).toContain(String(process.pid));
  });
});

describe("LinuxHost on a fake /proc tree (any system)", () => {
  let dir: string;
  let proc: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "infinity-host-")));
    proc = join(dir, "proc");
    mkdirSync(join(proc, "self"), { recursive: true });
    mkdirSync(join(proc, "pressure"));
    writeFileSync(join(proc, "stat"), "cpu  1 2 3 4\n");
    writeFileSync(join(proc, "pressure", "cpu"), "some avg10=1.00 avg60=2.00 avg300=3.00 total=4\n");
    const add = (pid: number, text: string, cwd?: string) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "stat"), text);
      if (cwd !== undefined) symlinkSync(cwd, join(proc, String(pid), "cwd"));
    };
    add(10, stat(10), dir);
    add(11, stat(11, "sh", "Z"));
    add(12, stat(12, "python3"), join(dir, "elsewhere"));
    mkdirSync(join(proc, "sys")); // not a process
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads nested files, lists only the numeric entries, gives a working directory only where there is a readable one, and honours the cap", () => {
    const host = new LinuxHost({ procDir: proc });
    expect(host.hasProc()).toBe(true);
    expect(host.readProc("pressure/cpu")).toContain("avg10=1.00");
    expect(host.processes().map((process) => process.pid)).toEqual([10, 11, 12]);
    const withCwd = host.processes({ cwd: true });
    expect(withCwd.map((process) => [process.pid, process.cwd])).toEqual([
      [10, dir],
      [11, undefined],
      [12, join(dir, "elsewhere")],
    ]);
    expect(host.processes({ cap: 2 }).map((process) => process.pid)).toEqual([10, 11]);
  });

  it("counts a zombie and a missing process as ended, and says there is no /proc where there is none", () => {
    const host = new LinuxHost({ procDir: proc });
    expect([host.isAlive(10), host.isAlive(11), host.isAlive(13)]).toEqual([true, false, false]);
    const none = new LinuxHost({ procDir: join(dir, "nowhere") });
    expect(none.hasProc()).toBe(false);
    expect(none.readProc("stat")).toBeUndefined();
  });
});

describe("FakeHost as a test double", () => {
  it("records the signals and priorities it is given, lets a test end a process when it is signalled, and refuses a signal for a process that is not there", async () => {
    const host = new FakeHost({
      processes: [
        { pid: 1, stat: stat(1) },
        { pid: 2, stat: stat(2) },
      ],
      onSignal: (pid, signal, self) => {
        if (signal === "SIGTERM" && pid === 1) self.end(1);
      },
    });
    host.signal(1, "SIGTERM");
    host.signal(2, "SIGTERM");
    expect(() => host.signal(1, "SIGKILL")).toThrow();
    expect(host.signals).toEqual([
      [1, "SIGTERM"],
      [2, "SIGTERM"],
    ]);
    expect([host.isAlive(1), host.isAlive(2)]).toEqual([false, true]);
    expect(await host.setPriority(2, 10)).toBe(true);
    expect(host.priorities).toEqual([[2, 10]]);
  });

  it("answers nvidia-smi queries from its table, and a missing query fails like a missing tool", async () => {
    const host = new FakeHost({ gpu: { "--query-gpu=memory.total": "24564\n" }, commit: "abc" });
    expect(await host.gpuQuery("--query-gpu=memory.total")).toBe("24564\n");
    expect(await host.gpuQuery("--query-compute-apps=pid,used_memory")).toBeUndefined();
    expect(await host.gitCommit()).toBe("abc");
    expect(await new FakeHost().gitCommit()).toBeUndefined();
  });
});
