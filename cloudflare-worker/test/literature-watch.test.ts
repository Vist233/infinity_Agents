import { describe, expect, it, vi } from "vitest";
import { parseArxivFeed, runLiteratureDiscovery } from "../src/literature-watch";
import { makeEnv } from "./fake-d1";

const FEED = `<?xml version="1.0"?><feed>
  <entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Safe discovery study</title>
  <published>2024-01-02T00:00:00Z</published><author><name>A. Researcher</name></author>
  <summary>We evaluate a reproducible scientific method.</summary></entry>
</feed>`;

describe("literature watcher", () => {
  it("canonicalizes arXiv versions and bounds parsed entries", () => {
    const parsed = parseArxivFeed(FEED, 10);
    expect(parsed.records).toMatchObject([{
      sourceRef: "2401.00001",
      canonicalRef: "https://arxiv.org/abs/2401.00001",
      title: "Safe discovery study",
    }]);
  });

  it("deduplicates source records, preserves the cursor on provider failure, and enforces the daily cap", async () => {
    const { env, db } = makeEnv({
      DISCOVERY_LITERATURE_ENABLED: "true",
      DISCOVERY_LITERATURE_SOURCES: "arxiv",
      DISCOVERY_LITERATURE_MAX_PER_RUN: "10",
      DISCOVERY_LITERATURE_MAX_PER_DAY: "1",
    });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(FEED, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = 1_800_000_000;
    const first = await runLiteratureDiscovery(env, now);
    expect(first).toMatchObject({ fetched: 1, created: 1, duplicates: 0, cursors: { arxiv: "1" } });
    expect(db.paperCatalog.size).toBe(1);

    const capped = await runLiteratureDiscovery(env, now + 60);
    expect(capped).toMatchObject({ fetched: 0, created: 0 });
    expect(db.paperCatalog.size).toBe(1);

    db.literatureWatchState.clear();
    fetchMock.mockRejectedValueOnce(new Error("provider timeout"));
    const failed = await runLiteratureDiscovery(env, now + 86_400);
    expect(failed).toMatchObject({ fetched: 0, created: 0, failed: 1, cursors: { arxiv: null } });
    vi.unstubAllGlobals();
  });
});
