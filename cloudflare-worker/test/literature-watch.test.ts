import { describe, expect, it, vi } from "vitest";
import { parseArxivFeed, runLiteratureDiscovery } from "../src/literature-watch";
import { ensureLiteratureDailyQuota, listDueLiteratureFailures, recordLiteratureFailure, releaseLiteratureDailyQuota, resolveLiteratureFailure, reserveLiteratureDailyQuota } from "../src/discovery-db";
import { makeEnv } from "./fake-d1";

const FEED = `<?xml version="1.0"?><feed>
  <entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Safe discovery study</title>
  <published>2024-01-02T00:00:00Z</published><author><name>A. Researcher</name></author>
  <summary>We evaluate a reproducible scientific method.</summary></entry>
</feed>`;

const INVALID_THEN_VALID_FEED = `<?xml version="1.0"?><feed>
  <entry><id>https://example.invalid/not-arxiv</id><title>Ignored</title></entry>
  <entry><id>http://arxiv.org/abs/2401.00002v1</id><title>Cursor-safe study</title>
  <published>2024-01-03T00:00:00Z</published><author><name>A. Researcher</name></author>
  <summary>We preserve provider progress when a page contains an invalid record.</summary></entry>
  <opensearch:totalResults>2</opensearch:totalResults>
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

  it("advances past invalid provider entries instead of stalling the cursor", () => {
    const parsed = parseArxivFeed(INVALID_THEN_VALID_FEED, 10);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].sourceRef).toBe("2401.00002");
    expect(parsed.consumed).toBe(2);
    expect(parsed.nextCursor).toBe("2");
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

  it("serializes concurrent scheduled runs with a global lease", async () => {
    const { env, db } = makeEnv({
      DISCOVERY_LITERATURE_ENABLED: "true",
      DISCOVERY_LITERATURE_SOURCES: "arxiv",
    });
    db.literatureWatchState.set("__literature_run__|machine learning AND dataset", {
      source: "__literature_run__",
      query: "machine learning AND dataset",
      last_cursor: null,
      last_checked_at: null,
      created_at: 1_800_000_000,
      updated_at: 1_800_000_000,
      lease_owner: "another-run",
      lease_expires_at: 1_800_000_300,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLiteratureDiscovery(env, 1_800_000_001);

    expect(result).toMatchObject({ enabled: true, fetched: 0, created: 0, failed: 0, cursors: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps failed materializations in a durable retry/dead-letter ledger and reserves quota atomically", async () => {
    const { env, db } = makeEnv();
    const now = 1_800_000_000;
    await ensureLiteratureDailyQuota(env, { ownerUserId: "system-literature-watch", dayStart: now, limit: 1, initialCount: 0, now });
    expect(await reserveLiteratureDailyQuota(env, { ownerUserId: "system-literature-watch", dayStart: now, now })).toBe(true);
    expect(await reserveLiteratureDailyQuota(env, { ownerUserId: "system-literature-watch", dayStart: now, now })).toBe(false);
    expect(await releaseLiteratureDailyQuota(env, { ownerUserId: "system-literature-watch", dayStart: now, now })).toBe(true);
    const record = JSON.stringify({ source: "arxiv", sourceRef: "2401.00003", canonicalRef: "https://arxiv.org/abs/2401.00003", title: "Retry me", authors: [], year: 2024, venue: "arXiv", abstract: "" });
    await recordLiteratureFailure(env, { failureId: "failure-1", source: "arxiv", query: "q", sourceRef: "2401.00003", recordJson: record, nextRetryAt: now, error: "transient", now });
    const due = await listDueLiteratureFailures(env, { source: "arxiv", query: "q", now });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ attempts: 1, status: "pending" });
    await recordLiteratureFailure(env, { failureId: "failure-1", source: "arxiv", query: "q", sourceRef: "2401.00003", recordJson: record, nextRetryAt: now, error: "still failing", maxAttempts: 2, now: now + 1 });
    expect(db.literatureWatchFailures.get("arxiv|q|2401.00003")?.status).toBe("dead");
    expect(await resolveLiteratureFailure(env, { source: "arxiv", query: "q", sourceRef: "2401.00003" })).toBe(true);
  });

  it("rejects an oversized provider response before parsing it", async () => {
    const { env } = makeEnv({
      DISCOVERY_LITERATURE_ENABLED: "true",
      DISCOVERY_LITERATURE_SOURCES: "arxiv",
      DISCOVERY_LITERATURE_MAX_PER_RUN: "1",
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runLiteratureDiscovery(env, 1_800_100_000);
    expect(result).toMatchObject({ fetched: 0, created: 0, failed: 1, cursors: { arxiv: null } });
    vi.unstubAllGlobals();
  });
});
