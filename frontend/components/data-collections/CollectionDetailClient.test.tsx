import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CollectionMatchCard } from "@/components/data-collections/CollectionDetailClient";
import { LanguageProvider } from "@/lib/i18n";
import type { DiscoveryMatch } from "@/lib/api/discovery";

function match(overrides: Partial<DiscoveryMatch> = {}): DiscoveryMatch {
  return {
    match_id: "match-1",
    paper_id: "paper-1",
    collection_id: "collection-1",
    paper_profile_version: "paper-profile-v1",
    dataset_profile_version: "dataset-profile-v1",
    status: "candidate",
    hard_gate: "pending",
    coverage_ratio: 0,
    execution_confidence: null,
    scientific_fit: null,
    evaluator_version: null,
    evaluation_json: null,
    created_task_id: null,
    candidate_reason: "Candidate created from compatible local profiles.",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function renderCard(current: DiscoveryMatch, onEvaluate = vi.fn(), onCreateTask = vi.fn()) {
  render(<LanguageProvider initialLanguage="zh"><CollectionMatchCard match={current} evaluating={false} creating={false} onEvaluate={onEvaluate} onCreateTask={onCreateTask} /></LanguageProvider>);
  return { onEvaluate, onCreateTask };
}

describe("CollectionMatchCard", () => {
  it("offers evaluation for a candidate and does not create a task before evaluation", () => {
    const { onEvaluate, onCreateTask } = renderCard(match());

    fireEvent.click(screen.getByRole("button", { name: "评估匹配" }));
    expect(onEvaluate).toHaveBeenCalledWith("match-1");
    expect(screen.queryByRole("button", { name: "创建任务" })).toBeNull();
    expect(onCreateTask).not.toHaveBeenCalled();
  });

  it("offers task creation after a passing evaluation", () => {
    const { onCreateTask } = renderCard(match({
      status: "evaluated",
      hard_gate: "pass",
      coverage_ratio: 1,
      execution_confidence: 100,
    }));

    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    expect(onCreateTask).toHaveBeenCalledWith("match-1");
    expect(screen.queryByRole("button", { name: "评估匹配" })).toBeNull();
  });
});
