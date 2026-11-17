// The note an agent of a code task gets in every request: time, submits, disk; and the two reminders.
import { describe, expect, it } from "vitest";
import type { Message } from "sakura-agent";
import { runNotesPlugin } from "../src/run-notes.ts";

function harness(options: { submitsBefore?: number; bytes?: number }) {
  let now = 0;
  let context: ((input: { messages: Message[] }) => Message[]) | undefined;
  const plugin = runNotesPlugin({
    workDir: "/w",
    submitsBefore: options.submitsBefore ?? 0,
    workDirGb: 10,
    now: () => now,
    measure: async () => options.bytes ?? 0,
  });
  const on = (hook: string, handler: never) => {
    if (hook === "context") context = handler;
  };
  plugin.setup({ on } as never);
  const noteAt = async (minutes: number) => {
    now = minutes * 60_000;
    context?.({ messages: [] });
    await new Promise((resolve) => setImmediate(resolve)); // the size is measured in the background
    const out = context?.({ messages: [] }) ?? [];
    const last = out.at(-1)?.content[0];
    return last?.type === "text" ? last.text : "";
  };
  return { plugin, noteAt };
}

describe("runNotesPlugin", () => {
  it("says how long the agent has worked and that nothing counts yet; after 20 minutes it asks for a baseline", async () => {
    const { noteAt } = harness({});
    expect(await noteAt(5)).toMatch(/^\[Run: 5 minutes since you started; 0 submits so far; work directory 0\.0 GB of a 10 GB share\.\]$/);
    expect(await noteAt(25)).toContain("submit a working baseline now");
  });
  it("stops asking once the agent has submitted, and a resumed agent keeps its count", async () => {
    const { plugin, noteAt } = harness({});
    plugin.submitted();
    expect(await noteAt(30)).not.toContain("baseline");
    expect(await harness({ submitsBefore: 3 }).noteAt(30)).toContain("3 submits so far");
  });
  it("asks for a clean-up when the work directory is over its share", async () => {
    const { noteAt } = harness({ submitsBefore: 1, bytes: 38 * 1024 ** 3 });
    expect(await noteAt(1)).toContain("38.0 GB of a 10 GB share. Your work directory is over its share");
  });
});
