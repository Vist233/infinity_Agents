import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Hooks, PluginApi } from "sakura-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlugin } from "../src/commit-plugin.ts";
import { commitAll, headCommit, initWorkRepo } from "../src/work-repo.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "infinity-commit-"));
  await initWorkRepo(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function install(plugin: ReturnType<typeof commitPlugin>): (event: Event) => void {
  let handler: Hooks["event"] | undefined;
  const api = {
    on(hook: string, fn: unknown) {
      if (hook === "event") handler = fn as Hooks["event"];
    },
  } as unknown as PluginApi;
  plugin.setup(api);
  return (event) => handler?.(event);
}

const log = () => execFileSync("git", ["log", "--format=%s|%an"], { cwd: dir }).toString().trim().split("\n");

describe("work repository", () => {
  it("has no commit before the first one", async () => {
    expect(await headCommit(dir)).toBeUndefined();
  });

  it("commits changes and skips when nothing changed", async () => {
    await writeFile(join(dir, "Proof.lean"), "theorem main : True := trivial\n");
    const first = await commitAll(dir, "turn 1");
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(dir, "turn 2")).toBeUndefined();
    expect(await headCommit(dir)).toBe(first);
  });
});

describe("commit plugin", () => {
  it("commits after each turn_end with the changes of that turn", async () => {
    const commits: Array<[string, number]> = [];
    const plugin = commitPlugin({ dir, onCommit: (id, turn) => commits.push([id, turn]) });
    const fire = install(plugin);

    await writeFile(join(dir, "a.txt"), "one");
    fire({ type: "turn_end" });
    fire({ type: "turn_end" }); // nothing changed in turn 2
    await plugin.flush(); // in a real run the next model reply takes seconds, so the commit is long done before the next write
    await writeFile(join(dir, "a.txt"), "two");
    fire({ type: "turn_end" });
    await plugin.flush();

    expect(commits.map(([, turn]) => turn)).toEqual([1, 3]);
    expect(log()).toEqual(["turn 3|infinity-agent", "turn 1|infinity-agent"]);
  });

  it("when git is slower than the next write, the commit holds the directory as it is when git looks, and nothing is lost", async () => {
    // Exact behaviour (docs/decisions.md, 8): the commit is started at turn_end but git reads the directory a few milliseconds later.
    // A file written before turn_end is always in that commit; a file written in between may be in it too. No change is ever lost.
    const commits: string[] = [];
    const plugin = commitPlugin({ dir, onCommit: (id) => commits.push(id) });
    const fire = install(plugin);
    await writeFile(join(dir, "turn1.txt"), "written during turn 1");
    fire({ type: "turn_end" });
    await writeFile(join(dir, "turn2.txt"), "written right after turn 1 ended, before git looked");
    fire({ type: "turn_end" });
    await plugin.flush();

    const firstCommitFiles = execFileSync("git", ["show", "--name-only", "--format=", commits[0] ?? ""], { cwd: dir }).toString();
    expect(firstCommitFiles).toContain("turn1.txt");
    const everything = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir }).toString();
    expect(everything).toContain("turn1.txt");
    expect(everything).toContain("turn2.txt");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString()).toBe("");
  });

  it("ignores events other than turn_end", async () => {
    const plugin = commitPlugin({ dir });
    const fire = install(plugin);
    await writeFile(join(dir, "a.txt"), "one");
    fire({ type: "turn_start" });
    await plugin.flush();
    expect(await headCommit(dir)).toBeUndefined();
  });

  it("reports a failing git and never throws", async () => {
    const errors: unknown[] = [];
    const plugin = commitPlugin({ dir: join(dir, "does-not-exist"), onError: (error) => errors.push(error) });
    const fire = install(plugin);
    expect(() => fire({ type: "turn_end" })).not.toThrow();
    await expect(plugin.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("keeps committing after one commit failed", async () => {
    const commits: number[] = [];
    const plugin = commitPlugin({ dir, onCommit: (_id, turn) => commits.push(turn), onError: () => {} });
    const fire = install(plugin);
    await writeFile(join(dir, "a.txt"), "one");
    fire({ type: "turn_end" });
    await plugin.flush();
    await rm(join(dir, ".git", "index.lock"), { force: true });
    await writeFile(join(dir, "a.txt"), "two");
    fire({ type: "turn_end" });
    await plugin.flush();
    expect(commits).toEqual([1, 2]);
  });
});
