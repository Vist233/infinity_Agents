import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaperCard } from "@/components/papers/PaperCard";
import type { DiscoveryPaper } from "@/lib/api/discovery";
import { LanguageProvider } from "@/lib/i18n";

function paper(overrides: Partial<DiscoveryPaper> = {}): DiscoveryPaper {
  return {
    paper_id: "paper-1",
    visibility: "private",
    title: "Unusable document",
    authors: [],
    year: null,
    venue: null,
    status: "failed",
    spam_status: "non_paper",
    profile_version: null,
    profile: null,
    overview: null,
    source_status: "failed",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("PaperCard", () => {
  it("does not label failed non-paper items as still loading", () => {
    render(<LanguageProvider initialLanguage="zh"><PaperCard paper={paper()} /></LanguageProvider>);

    expect(screen.getByText("非论文")).toBeVisible();
    expect(screen.queryByText("正在加载论文…")).toBeNull();
  });

  it("keeps requested items in the loading state", () => {
    render(<LanguageProvider initialLanguage="zh"><PaperCard paper={paper({ status: "requested", spam_status: "pending" })} /></LanguageProvider>);

    expect(screen.getByText("正在加载论文…")).toBeVisible();
  });
});
