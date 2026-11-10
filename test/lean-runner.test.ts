import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLeanRunner } from "../src/lean-runner.ts";
import { Pool } from "../src/pool.ts";

/** The runner is tested with small shell scripts in the place of `lean`. */
let root: string;
let scratch: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infinity-runner-"));
  scratch = join(root, "scratch");
  mkdirSync(scratch);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeLean(script: string): string {
  const bin = join(root, "toolchain", "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "lean");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const request = (overrides: object = {}) => ({ cwd: scratch, args: ["a", "b"], leanPath: [scratch], writableDirs: [scratch], timeoutMs: 10_000, ...overrides });

describe("createLeanRunner (no sandbox, the default)", () => {
  it("does not confine the process unless asked to", () => {
    expect(createLeanRunner({ leanBin: fakeLean("exit 0"), pool: new Pool(1) }).sandboxed).toBe(false);
  });

  it("returns the exit code and both output streams", async () => {
    const runner = createLeanRunner({ leanBin: fakeLean('echo "out $@"; echo "err" >&2; exit 3'), pool: new Pool(1), sandbox: false });
    expect(await runner.run(request())).toEqual({ exitCode: 3, output: expect.stringContaining("out a b"), timedOut: false });
    expect(runner.sandboxed).toBe(false);
  });

  it("hands the process a clean environment with LEAN_PATH and nothing else of the caller's", async () => {
    process.env.INFINITY_TEST_SECRET = "do-not-leak";
    try {
      const runner = createLeanRunner({ leanBin: fakeLean('echo "path=$LEAN_PATH secret=$INFINITY_TEST_SECRET"'), pool: new Pool(1), sandbox: false });
      const result = await runner.run(request({ leanPath: ["/x", "/y"] }));
      expect(result.output).toContain("path=/x:/y secret=\n");
    } finally {
      delete process.env.INFINITY_TEST_SECRET;
    }
  });

  it("keeps only the last part of a very long output", async () => {
    const runner = createLeanRunner({
      leanBin: fakeLean('i=0; while [ $i -lt 3000 ]; do echo "line $i padding padding padding padding padding"; i=$((i+1)); done'),
      pool: new Pool(1),
      sandbox: false,
    });
    const result = await runner.run(request());
    expect(result.output.length).toBeLessThanOrEqual(20_000);
    expect(result.output).toContain("line 2999");
  });

  it("kills a process that runs past the timeout", async () => {
    const runner = createLeanRunner({ leanBin: fakeLean("sleep 30"), pool: new Pool(1), sandbox: false });
    const result = await runner.run(request({ timeoutMs: 100 }));
    expect(result.timedOut).toBe(true);
  });

  it("kills the process and rejects when the signal aborts, and does not start when it is already aborted", async () => {
    const runner = createLeanRunner({ leanBin: fakeLean("sleep 30"), pool: new Pool(1), sandbox: false });
    const controller = new AbortController();
    const running = runner.run(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    await expect(running).rejects.toThrow("cancelled");
    await expect(runner.run(request({ signal: controller.signal }))).rejects.toThrow("cancelled");
  });

  it("rejects when the executable cannot be started", async () => {
    fakeLean("exit 0");
    const runner = createLeanRunner({ leanBin: join(root, "toolchain", "bin", "missing"), pool: new Pool(1), sandbox: false });
    await expect(runner.run(request())).rejects.toThrow();
  });

  it("runs at most as many processes as the pool allows", async () => {
    const runner = createLeanRunner({
      leanBin: fakeLean(`echo start >> "${root}/log"; sleep 0.2; echo end >> "${root}/log"`),
      pool: new Pool(1),
      sandbox: false,
    });
    await Promise.all([runner.run(request()), runner.run(request())]);
    const log = (await import("node:fs")).readFileSync(join(root, "log"), "utf8").trim().split("\n");
    expect(log).toEqual(["start", "end", "start", "end"]);
  });
});

describe.skipIf(process.platform !== "darwin")("createLeanRunner (macOS sandbox)", () => {
  it("lets the process write into its directory but nowhere else, and cuts the network", async () => {
    const outside = mkdtempSync(join(tmpdir(), "infinity-outside-"));
    try {
      const runner = createLeanRunner({
        leanBin: fakeLean(
          `echo in > "${scratch}/inside.txt"; echo out > "${outside}/outside.txt" 2>/dev/null; echo "code=$?"; /usr/bin/curl -s -m 2 http://127.0.0.1:9 >/dev/null 2>&1; echo "net=$?"`,
        ),
        pool: new Pool(1),
        sandbox: true,
      });
      expect(runner.sandboxed).toBe(true);
      const result = await runner.run(request());
      expect(existsSync(join(scratch, "inside.txt"))).toBe(true);
      expect(existsSync(join(outside, "outside.txt"))).toBe(false);
      expect(result.output).not.toContain("code=0");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
