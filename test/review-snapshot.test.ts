import { describe, expect, it } from "vitest";
import { type ReviewOutputSettings, parseReviewSnapshot, reviewOutputProblems, reviewQuestion } from "../src/review-snapshot.ts";

const evidence = [{ entryId: "entry-1", tool: "submit", failed: false }];
const observed = { observedAt: 1000, observedTurn: 5 };
const response = {
  status: "working",
  assessment: "on_track",
  priority: 0,
  summary: "A result was submitted.",
  reason: "The next experiment can proceed.",
  evidenceRefs: ["E1"],
  steer: null,
  details: {},
};
const parse = (overrides: Record<string, unknown> = {}, settings: ReviewOutputSettings = {}) =>
  parseReviewSnapshot(JSON.stringify({ ...response, ...overrides }), settings, evidence, observed);

describe("review snapshots", () => {
  it("resolves a local reference and keeps the no-steer assessment and default sort key", () => {
    expect(parse()).toMatchObject({ ...observed, evidence, version: 1, assessment: "on_track", steer: null, sortValue: 0 });
  });

  it("uses the configured direction and puts a missing custom value after known values", () => {
    const settings = {
      fields: { remaining: { type: "number", description: "Remaining work" } },
      sort: { field: "remaining", direction: "min" },
    } satisfies ReviewOutputSettings;
    expect([
      parse({ details: { remaining: 5 } }, settings).sortValue,
      parse({ details: { remaining: 2 } }, settings).sortValue,
      parse({}, settings).sortValue,
    ]).toEqual([-5, -2, null]);
  });

  it("uses enum order from the task and shares its field definitions with the prompt", () => {
    const settings = {
      fields: { stage: { type: "enum", values: ["draft", "verified"], description: "Proof stage" } },
      sort: { field: "stage", direction: "max" },
    } satisfies ReviewOutputSettings;
    expect(reviewQuestion(settings, evidence)).toContain("stage: draft | verified. Proof stage");
    expect(parse({ details: { stage: "verified" } }, settings).sortValue).toBe(1);
  });

  it.each([
    { evidenceRefs: ["E99"] },
    { evidenceRefs: ["E1", "E1"] },
    { evidenceRefs: [] },
    { priority: 4 },
    { details: { arbitrary: true } },
    { steer: " " },
    { extra: "unexpected" },
  ])("rejects an invalid response: %j", (overrides) => {
    expect(() => parse(overrides)).toThrow();
  });

  it("keeps unknown distinct from normal priority when there is no evidence", () => {
    expect(parse({ status: "unknown", assessment: "unknown", priority: null, evidenceRefs: [] }).sortValue).toBeNull();
  });

  it("rejects a custom sort key without an ordered field", () => {
    expect(reviewOutputProblems({ fields: { note: { type: "string", description: "Notes" } }, sort: { field: "note", direction: "max" } })).toContain(
      "sort must refer to a number or enum field",
    );
  });
});
