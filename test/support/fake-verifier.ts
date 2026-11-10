import type { Verifier } from "../../src/verifier.ts";

/** Accepts a file that contains GOOD; everything else is rejected. */
export const fakeVerifier: Verifier = {
  check: async () => "No errors or warnings.",
  verify: async (source) => (source.includes("GOOD") ? { proved: true, reason: "proved" } : { proved: false, reason: "this is a bad proof" }),
};
