import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMatchEvaluation } from "@/lib/api/discovery";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestMatchEvaluation", () => {
  it("posts to the match evaluation route and returns the normalized evaluation", async () => {
    const response = {
      match_id: "match-1",
      status: "evaluated",
      queued: false,
      evaluation: {
        evaluator_version: "feasibility-v1",
        hard_gate: "pass",
        coverage: { supported_modules: 2, total_modules: 2, ratio: 1 },
        execution_confidence: 100,
        scientific_fit: 100,
        missing_requirements: [],
        risks: [],
        recommended: true,
        reason: "The required analysis capabilities and target contract are present.",
        provenance: { model_version: "deterministic-evaluator-v1" },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMatchEvaluation("match-1")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/matches/match-1/evaluate",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
