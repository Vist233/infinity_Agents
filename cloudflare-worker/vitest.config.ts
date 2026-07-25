import { defineConfig } from "vitest/config";

// Worker unit tests run in a plain Node environment. D1 and rate-limit bindings
// are exercised through lightweight in-memory doubles (see test/fake-d1.ts), and
// StepFun / arXiv / PubMed HTTP calls are mocked per-test via globalThis.fetch.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
