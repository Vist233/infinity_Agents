import { ProviderError } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { describe, expect, it } from "vitest";
import { FALLBACK_HINTS, hintFor, planHints } from "../src/planner.ts";

const plan = (script: Parameters<typeof createFauxClient>[0], count = 3) => {
  const client = createFauxClient(script);
  return { client, planned: planHints({ client, statement: "∀ n : Nat, n = n", count }) };
};

describe("planHints", () => {
  it("returns the hints the model wrote, one request, with the statement in it", async () => {
    const { client, planned } = plan([{ text: '["use induction", "use omega", "split cases"]' }]);
    expect(await planned).toEqual(["use induction", "use omega", "split cases"]);
    expect(client.requests).toHaveLength(1);
    expect(JSON.stringify(client.requests[0]?.messages)).toContain("∀ n : Nat, n = n");
  });

  it("finds the list inside a fenced answer with prose around it", async () => {
    const { planned } = plan([{ text: 'Here you go:\n```json\n["a", "b", "c"]\n```\nGood luck.' }]);
    expect(await planned).toEqual(["a", "b", "c"]);
  });

  it("fills up from the fixed list when the model gives fewer hints, without repeating", async () => {
    const { planned } = plan([{ text: '["only one"]' }]);
    const hints = await planned;
    expect(hints).toHaveLength(3);
    expect(hints[0]).toBe("only one");
    expect(new Set(hints).size).toBe(3);
  });

  it("cuts a list that is too long, drops duplicates and non-strings", async () => {
    const { planned } = plan([{ text: '["a", "a", 7, "", "b", "c", "d"]' }]);
    expect(await planned).toEqual(["a", "b", "c"]);
  });

  it.each([["not a list at all"], ["[broken json"], ["[a, b]"], ['{"a": 1}'], [""]])("falls back to the fixed list for %j", async (text) => {
    const { planned } = plan([{ text }]);
    expect(await planned).toEqual(FALLBACK_HINTS.slice(0, 3));
  });

  it("falls back when the call fails", async () => {
    const { planned } = plan([{ error: new ProviderError("network", "down") }]);
    expect(await planned).toEqual(FALLBACK_HINTS.slice(0, 3));
  });

  it("passes a cancellation on", async () => {
    const client = createFauxClient([{ hang: true }]);
    const controller = new AbortController();
    const planned = planHints({ client, statement: "True", count: 2, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(planned).rejects.toThrow();
  });

  it("always plans for at least one agent", async () => {
    const { planned } = plan([{ text: "[]" }], 0);
    expect(await planned).toHaveLength(1);
  });
});

describe("hintFor", () => {
  const hints = ["h1", "h2", "h3"];
  it("gives each agent number its own hint, in order", () => {
    expect([1, 2, 3].map((agent) => hintFor(hints, agent))).toEqual(hints);
  });
  it("gives a replacement agent the next hint and starts over at the end of the list", () => {
    expect(hintFor(hints, 4)).toBe("h1");
    expect(hintFor(hints, 8)).toBe("h2");
  });
  it("uses the fixed list when there are no hints", () => {
    expect(hintFor([], 5)).toBe(FALLBACK_HINTS[0]);
  });
});
