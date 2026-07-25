import { afterEach, describe, expect, it, vi } from "vitest";
import { readPaper, runTool, searchPaper } from "../src/tools";
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
    const out = JSON.parse(await runTool(env, "s1", "delete_everything", {}));
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
  it("surfaces papers, authorizes them, and then allows reading", async () => {
    const { env, db } = makeEnv();
    installFetchMock();

    const searchOut = JSON.parse(await searchPaper(env, "s1", "attention", 5));
    const refs = searchOut.map((r: { ref: string }) => r.ref);
    expect(refs).toContain("arxiv:2401.00001");
    expect(refs).toContain("pubmed:111");

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
});
