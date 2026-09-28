import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollectionCard } from "@/components/data-collections/CollectionCard";
import type { DiscoveryCollection } from "@/lib/api/discovery";
import { LanguageProvider } from "@/lib/i18n";

const collection: DiscoveryCollection = {
  collection_id: "collection-1",
  name: "Example dataset",
  source_filename: "features.csv",
  source_content_type: "text/csv",
  source_size_bytes: 128,
  status: "ready",
  profile_version: "dataset-profile-v1",
  profile: {
    profile_version: "dataset-profile-v1",
    model_version: "inspector-v1",
    provenance: { collection_id: "collection-1", inspector_version: "inspector-v1", generated_at: "2026-09-28T00:00:00Z" },
    collection_id: "collection-1",
    domain_hint: "tabular",
    files: [{
      path: "features.csv",
      format: "csv",
      size_bytes: 128,
      sha256: "a".repeat(64),
      rows: 4,
      columns: 3,
      column_names: ["feature_a", "feature_b", "target"],
      data_types: { feature_a: "numeric", feature_b: "numeric", target: "numeric" },
      missing_ratio: 0,
      sample: [],
    }],
    capabilities: {
      "dataset.sample_count": 4,
      "dataset.feature_count": 2,
    },
    semantic_fields: { target: "target", feature_names: ["feature_a", "feature_b"] },
    display_tags: ["4 Samples", "2 Features"],
  },
  error: null,
  created_at: 0,
  updated_at: 0,
};

describe("CollectionCard", () => {
  it("renders sample and feature totals from normalized dotted capabilities", () => {
    render(<LanguageProvider initialLanguage="zh"><CollectionCard collection={collection} /></LanguageProvider>);

    expect(screen.getByText("4", { exact: true })).toBeVisible();
    expect(screen.getByText("2", { exact: true })).toBeVisible();
    expect(screen.getByText("4 Samples")).toBeVisible();
    expect(screen.getByText("2 Features")).toBeVisible();
  });
});
