import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createPaperResource, linkPaperResource } from "../src/db";
import {
  analyzePaperImage,
  materializePaper,
  normalizeSearchPaperRecord,
  readPaper,
  runTool,
  searchPaper,
  type PaperRecord,
} from "../src/tools";
import { makeEnv } from "./fake-d1";

const ARXIV_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001</id>
    <title>Attention Is Somewhat All You Need</title>
    <summary>A study of attention mechanisms in sequence models.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/2401.00001"/>
  </entry>
</feed>`;

function makeResponse(body: string | object) {
  const isString = typeof body === "string";
  return {
    ok: true,
    status: 200,
    text: async () => (isString ? (body as string) : JSON.stringify(body)),
    json: async () => (isString ? JSON.parse(body as string) : body)
  } as unknown as Response;
}

function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("export.arxiv.org")) return makeResponse(ARXIV_XML);
    if (url.includes("esearch.fcgi")) return makeResponse({ esearchresult: { idlist: ["111"] } });
    if (url.includes("esummary.fcgi")) {
      return makeResponse({
        result: { "111": { title: "A PubMed Paper", authors: [{ name: "Jane Doe" }], pubdate: "2023" } }
      });
    }
    if (url.includes("efetch.fcgi")) return makeResponse("Full PubMed abstract text.");
    return makeResponse("");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTool", () => {
  it("returns an error for an unknown tool", async () => {
    const { env } = makeEnv();
    const out = JSON.parse(await runTool(env, "s1", "user-1", "delete_everything", {}));
    expect(out.error).toContain("Unknown tool");
  });
});

describe("read_paper authorization gate", () => {
  it("refuses to read a paper not surfaced in the session (no network)", async () => {
    const { env } = makeEnv();
    const fetchMock = installFetchMock();

    const out = JSON.parse(await readPaper(env, "s1", "arxiv:2401.00001"));
    expect(out.error).toBe("paper_not_authorized_for_session");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("search_paper + read_paper flow", () => {
  it("normalizes sparse fresh records without making a PMID look like a PMCID", () => {
    const arxiv = normalizeSearchPaperRecord({
      source: "arxiv",
      ref: "arxiv:2401.00001",
      title: "Attention Is Somewhat All You Need",
      authors: [],
      url: "https://arxiv.org/abs/2401.00001",
    } as unknown as PaperRecord);
    expect(arxiv).toMatchObject({
      paper_ref: "arxiv:2401.00001",
      availability: { kind: "materializable" },
    });

    const pubmed = normalizeSearchPaperRecord({
      source: "pubmed",
      ref: "pubmed:111",
      title: "A PubMed Paper",
      authors: [],
      url: "https://pubmed.ncbi.nlm.nih.gov/111/",
    } as unknown as PaperRecord);
    expect(pubmed).toMatchObject({
      paper_ref: "pubmed:111",
      availability: {
        kind: "abstract_only",
        reason_code: "PUBMED_PMC_NOT_RESOLVED",
      },
    });
    expect(pubmed.paper_ref).not.toBe("pubmed:PMC111");
  });

  it("surfaces papers, authorizes them, and then allows reading", async () => {
    const { env, db } = makeEnv();
    installFetchMock();

    const searchOut = JSON.parse(await searchPaper(env, "s1", "attention", 5));
    const refs = searchOut.map((r: { ref: string }) => r.ref);
    expect(refs).toContain("arxiv:2401.00001");
    expect(refs).toContain("pubmed:111");
    expect(searchOut.find((r: { ref: string }) => r.ref === "arxiv:2401.00001")).toMatchObject({
      availability: { kind: "materializable" },
    });
    expect(searchOut.find((r: { ref: string }) => r.ref === "pubmed:111")).toMatchObject({
      availability: { kind: "abstract_only", reason_code: "PUBMED_PMC_NOT_RESOLVED" },
    });

    // Both refs are now authorized for the session.
    expect(db.paperAuth.has("s1|arxiv:2401.00001")).toBe(true);
    expect(db.paperAuth.has("s1|pubmed:111")).toBe(true);

    // A previously-surfaced paper can be read.
    const readOut = JSON.parse(await readPaper(env, "s1", "arxiv:2401.00001"));
    expect(readOut.title).toContain("Attention");
    expect(readOut.abstract).toContain("attention mechanisms");

    // But a different session cannot read it.
    const cross = JSON.parse(await readPaper(env, "other-session", "arxiv:2401.00001"));
    expect(cross.error).toBe("paper_not_authorized_for_session");
  });

  it("serves repeat searches from cache without re-hitting the network", async () => {
    const { env } = makeEnv();
    const fetchMock = installFetchMock();

    await searchPaper(env, "s1", "cached query", 4);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await searchPaper(env, "s1", "cached query", 4);
    // Second identical search hits the D1 cache: no additional fetches.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("marks a PMID-only PubMed result abstract-only and refuses materialization without creating a resource", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    installFetchMock();

    const search = JSON.parse(await searchPaper(env, "s1", "pubmed-only", 5)) as Array<Record<string, unknown>>;
    const pubmed = search.find((record) => record.ref === "pubmed:111");
    expect(pubmed).toMatchObject({
      paper_ref: "pubmed:111",
      availability: {
        kind: "abstract_only",
        reason_code: "PUBMED_PMC_NOT_RESOLVED",
      },
    });
    expect((pubmed as Record<string, unknown>).paper_ref).not.toBe("pubmed:PMC111");

    const cachedSearch = JSON.parse(await searchPaper(env, "s1", "pubmed-only", 5)) as Array<Record<string, unknown>>;
    expect(cachedSearch.find((record) => record.ref === "pubmed:111")).toMatchObject({
      availability: { kind: "abstract_only", reason_code: "PUBMED_PMC_NOT_RESOLVED" },
    });

    const materialize = JSON.parse(await materializePaper(env, "s1", "alice", "pubmed:111"));
    expect(materialize).toMatchObject({
      error: "paper_pubmed_full_text_unavailable",
      paper_ref: "pubmed:111",
      availability: "abstract_only",
      reason_code: "PUBMED_PMC_NOT_RESOLVED",
    });
    expect(db.paperResources).toHaveLength(0);

    const abstract = JSON.parse(await readPaper(env, "s1", "pubmed:111"));
    expect(abstract).toMatchObject({ mode: "abstract", ref: "pubmed:111" });
  });
});

class PaperBucket {
  objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata: { contentType: string } } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return { arrayBuffer: async () => value.slice().buffer, httpMetadata: { contentType: "application/json" } };
  }
}

function putJson(bucket: PaperBucket, key: string, value: unknown): void {
  bucket.objects.set(key, new TextEncoder().encode(JSON.stringify(value)));
}

describe("resource-aware Paper Workspace tools", () => {
  it("materializes an authorized paper once and reports durable processing state", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    installFetchMock();
    await searchPaper(env, "s1", "attention", 5);

    const first = JSON.parse(await materializePaper(env, "s1", "alice", "arxiv:2401.00001"));
    expect(first).toMatchObject({ mode: "processing", status: "requested", source: "arxiv" });
    expect(first.resource_id).toEqual(expect.any(String));
    const second = JSON.parse(await materializePaper(env, "s1", "alice", "arxiv:2401.00001"));
    expect(second).toMatchObject({ mode: "processing", status: "requested", resource_id: first.resource_id, reused: true });
    expect(db.paperResources).toHaveLength(1);

    const unauthorized = JSON.parse(await materializePaper(env, "other-session", "bob", "arxiv:2401.00001"));
    expect(unauthorized.error).toBe("paper_not_authorized_for_session");
  });

  it("reads text, literal search, outline, and images only from a ready manifest", async () => {
    const { env, db } = makeEnv();
    const bucket = new PaperBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const resource = await createResourceFixture(env, db, "resource-tools", "s1", "alice");
    const row = db.paperResources.get(resource.resource_id)!;
    row.status = "ready";
    row.text_manifest_key = `paper/${row.resource_id}/text/manifest.json`;
    row.image_manifest_key = `paper/${row.resource_id}/images/manifest.json`;
    row.page_count = 2;
    row.image_count = 1;
    putJson(bucket, `paper/${row.resource_id}/text/pages.jsonl`, { page: 1, text: "1 Introduction durable text" });
    bucket.objects.set(`paper/${row.resource_id}/text/pages.jsonl`, new TextEncoder().encode(
      '{"page":1,"text":"1 Introduction durable text"}\n{"page":2,"text":"Results include a significant finding"}\n',
    ));
    putJson(bucket, row.text_manifest_key, { resource_id: row.resource_id, page_count: 2, image_count: 1, pages: [{ page: 1 }, { page: 2 }], images: [{ image_id: "page-0001-image-0001", page: 1, width: 100, height: 80, content_type: "image/png" }] });
    putJson(bucket, row.image_manifest_key, { resource_id: row.resource_id, images: [{ image_id: "page-0001-image-0001", page: 1, width: 100, height: 80, content_type: "image/png" }] });
    bucket.objects.set(`paper/${row.resource_id}/images/page-0001/image-0001.png`, new Uint8Array([137, 80, 78, 71]));

    const text = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: row.resource_id, mode: "text", pages: [1] }));
    expect(text).toMatchObject({ mode: "full_text", resource_id: row.resource_id, pages: [{ page: 1 }] });
    const search = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: row.resource_id, mode: "search", query: "significant" }));
    expect(search.citations).toEqual([{ resource_id: row.resource_id, page: 2, excerpt: expect.stringContaining("significant") }]);
    const regexSearch = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: row.resource_id, mode: "search", query: "significant", regex: true }));
    expect(regexSearch.citations[0].page).toBe(2);
    const outline = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: row.resource_id, mode: "outline" }));
    expect(outline.outline).toEqual(expect.arrayContaining([{ resource_id: row.resource_id, page: 1, heading: "1 Introduction durable text" }]));
    const images = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: row.resource_id, mode: "images" }));
    expect(images.images[0]).toMatchObject({ image_id: "page-0001-image-0001", page: 1, width: 100, height: 80 });
    expect(images.images[0]).not.toHaveProperty("object_key");

    env.PAPER_IMAGE_ANALYSIS_EGRESS = "enabled";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "analysis" } }] }), { status: 200 })) as unknown as typeof fetch;
    const analyzed = JSON.parse(await analyzePaperImage(env, "s1", "alice", row.resource_id, "page-0001-image-0001", "describe", "low"));
    expect(analyzed).toMatchObject({ mode: "image_analysis", status: "succeeded", resource_id: row.resource_id, image_id: "page-0001-image-0001", page: 1, provenance: { resource_id: row.resource_id, image_id: "page-0001-image-0001", page: 1 } });
  });

  it("does not downgrade pending/failed resources or accept pages and images outside the manifest", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resource = await createResourceFixture(env, db, "resource-pending", "s1", "alice");
    const pending = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: resource.resource_id, mode: "text", pages: [1] }));
    expect(pending).toMatchObject({ mode: "processing", status: "requested" });
    db.paperResources.get(resource.resource_id)!.status = "failed";
    db.paperResources.get(resource.resource_id)!.error_code = "MALFORMED_PDF";
    const failed = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: resource.resource_id, mode: "text" }));
    expect(failed).toMatchObject({ mode: "processing", status: "failed", error_code: "MALFORMED_PDF" });
    const foreign = JSON.parse(await readPaper(env, "s2", "bob", { resource_id: resource.resource_id, mode: "text" }));
    expect(foreign.error).toBe("paper_resource_not_authorized");
    const bucket = new PaperBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    const row = db.paperResources.get(resource.resource_id)!;
    row.status = "ready";
    row.text_manifest_key = `paper/${row.resource_id}/text/manifest.json`;
    row.image_manifest_key = `paper/${row.resource_id}/images/manifest.json`;
    bucket.objects.set(`paper/${row.resource_id}/text/pages.jsonl`, new TextEncoder().encode('{"page":1,"text":"only page"}\n'));
    putJson(bucket, row.text_manifest_key, { resource_id: row.resource_id, pages: [{ page: 1 }] });
    putJson(bucket, row.image_manifest_key, { resource_id: row.resource_id, images: [] });
    const page = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: resource.resource_id, mode: "text", pages: [999] }));
    expect(page.error).toBe("paper_page_not_in_manifest");
    const unsafeRegex = JSON.parse(await readPaper(env, "s1", "alice", { resource_id: resource.resource_id, mode: "search", query: "(a+)+", regex: true }));
    expect(unsafeRegex.error).toBe("paper_regex_unsafe");
    const image = JSON.parse(await analyzePaperImage(env, "s1", "alice", resource.resource_id, "page-9999-image-0001", "describe", "high"));
    expect(image.error).toBe("paper_image_not_in_manifest");
  });
});

async function createResourceFixture(env: Env, db: ReturnType<typeof makeEnv>["db"], resourceId: string, sessionId: string, userId: string) {
  const resource = await createPaperResource(env, {
    resource_id: resourceId,
    session_id: sessionId,
    user_id: userId,
    source_kind: "arxiv",
    source_ref: "2401.00001",
    canonical_ref: "2401.00001",
    title: "Paper",
  });
  await linkPaperResource(env, sessionId, resource.resource_id, userId, "read");
  return resource;
}
