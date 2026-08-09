import type { Env } from "./env";
import { PAPER_CACHE_TTL_SECONDS } from "./env";
import { authorizePapers, cacheGet, cacheSet, isPaperAuthorized } from "./db";

// Pure-HTTP implementation of Analysis' search_paper / read_paper tools.
// Sources: arXiv Atom API + PubMed E-utilities. No PDF parsing (v1 reads
// abstract/metadata/web text only). Access control: a paper may only be read in
// a session if it was surfaced by search (or a prior read) in that same session.

const ARXIV_API = "http://export.arxiv.org/api/query";
const PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

export interface PaperRecord {
  source: "arxiv" | "pubmed";
  ref: string; // canonical id used for read_paper, e.g. "arxiv:2103.03404" / "pubmed:12345678"
  title: string;
  authors: string[];
  url: string;
  pdf_url?: string;
  published?: string | null;
  summary?: string;
}

function truncate(text: string, max = 500): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

// --- lightweight XML helpers for the arXiv Atom feed ---

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function extractAll(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

function parseArxivFeed(xml: string, limit: number): PaperRecord[] {
  const entries: PaperRecord[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && entries.length < limit) {
    const block = m[1];
    const idUrl = extractTag(block, "id") ?? "";
    const shortId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, "").trim();
    if (!shortId) continue;
    const title = extractTag(block, "title") ?? "(untitled)";
    const summary = extractTag(block, "summary") ?? "";
    const published = extractTag(block, "published");
    const authors = extractAll(block, "name").slice(0, 5);
    let pdfUrl: string | undefined;
    const linkMatch = block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i);
    if (linkMatch) pdfUrl = linkMatch[1];
    entries.push({
      source: "arxiv",
      ref: `arxiv:${shortId}`,
      title: title.replace(/\s+/g, " ").trim(),
      authors,
      url: idUrl,
      pdf_url: pdfUrl ?? `https://arxiv.org/pdf/${shortId}`,
      published,
      summary: truncate(summary)
    });
  }
  return entries;
}

async function searchArxiv(query: string, maxResults: number): Promise<PaperRecord[]> {
  const url = new URL(ARXIV_API);
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");
  try {
    const res = await fetch(url.toString(), { headers: { "user-agent": "infinity-agents/1.0" } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseArxivFeed(xml, maxResults);
  } catch {
    return [];
  }
}

async function searchPubmed(query: string, maxResults: number): Promise<PaperRecord[]> {
  try {
    const searchUrl = new URL(PUBMED_ESEARCH);
    searchUrl.searchParams.set("db", "pubmed");
    searchUrl.searchParams.set("term", query);
    searchUrl.searchParams.set("retmax", String(maxResults));
    searchUrl.searchParams.set("retmode", "json");
    const searchRes = await fetch(searchUrl.toString());
    if (!searchRes.ok) return [];
    const searchJson = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = searchJson.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const sumUrl = new URL(PUBMED_ESUMMARY);
    sumUrl.searchParams.set("db", "pubmed");
    sumUrl.searchParams.set("id", ids.join(","));
    sumUrl.searchParams.set("retmode", "json");
    const sumRes = await fetch(sumUrl.toString());
    if (!sumRes.ok) return [];
    const sumJson = (await sumRes.json()) as { result?: Record<string, any> };
    const result = sumJson.result ?? {};
    const records: PaperRecord[] = [];
    for (const id of ids) {
      const item = result[id];
      if (!item) continue;
      const authors: string[] = Array.isArray(item.authors)
        ? item.authors.map((a: any) => a?.name).filter(Boolean).slice(0, 5)
        : [];
      records.push({
        source: "pubmed",
        ref: `pubmed:${id}`,
        title: String(item.title ?? "(untitled)").replace(/\s+/g, " ").trim(),
        authors,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        published: item.pubdate ?? null,
        summary: truncate(item.title ?? "")
      });
    }
    return records;
  } catch {
    return [];
  }
}

function dedupe(records: PaperRecord[]): PaperRecord[] {
  const seen = new Set<string>();
  const out: PaperRecord[] = [];
  for (const r of records) {
    const key = r.ref || r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** search_paper tool implementation. Registers surfaced papers for the session. */
export async function searchPaper(
  env: Env,
  sessionId: string,
  query: string,
  numResults = 10
): Promise<string> {
  const q = String(query ?? "").trim();
  if (!q) return JSON.stringify({ error: "query cannot be empty" });
  const n = Math.max(1, Math.min(Number(numResults) || 10, 25));

  const cacheKey = `search:v1:${n}:${q.toLowerCase()}`;
  let records: PaperRecord[];
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    records = JSON.parse(cached) as PaperRecord[];
  } else {
    const half = Math.ceil(n / 2);
    const [arxiv, pubmed] = await Promise.all([
      searchArxiv(q, n),
      searchPubmed(q, half)
    ]);
    records = dedupe([...arxiv, ...pubmed]).slice(0, n);
    await cacheSet(env, cacheKey, JSON.stringify(records), PAPER_CACHE_TTL_SECONDS);
  }

  await authorizePapers(
    env,
    sessionId,
    records.map((r) => ({ ref: r.ref, source: r.source, title: r.title }))
  );

  return JSON.stringify(records, null, 2);
}

async function readArxivAbstract(shortId: string): Promise<PaperRecord | null> {
  const url = new URL(ARXIV_API);
  url.searchParams.set("id_list", shortId);
  url.searchParams.set("max_results", "1");
  const res = await fetch(url.toString(), { headers: { "user-agent": "infinity-agents/1.0" } });
  if (!res.ok) return null;
  const xml = await res.text();
  const parsed = parseArxivFeed(xml, 1);
  if (parsed.length === 0) return null;
  const record = parsed[0];
  // full (untruncated) abstract for reads
  const summary = extractTag(xml, "summary");
  if (summary) record.summary = summary.replace(/\s+/g, " ").trim();
  return record;
}

async function readPubmedAbstract(id: string): Promise<string | null> {
  const url = new URL(PUBMED_EFETCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", id);
  url.searchParams.set("rettype", "abstract");
  url.searchParams.set("retmode", "text");
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const text = await res.text();
  return text.trim() || null;
}

/**
 * read_paper tool implementation. Enforces per-session authorization: only
 * papers surfaced by search (or an earlier read) in this session may be read.
 */
export async function readPaper(env: Env, sessionId: string, ref: string): Promise<string> {
  const cleanRef = String(ref ?? "").trim();
  if (!cleanRef) return JSON.stringify({ error: "ref cannot be empty" });

  const authorized = await isPaperAuthorized(env, sessionId, cleanRef);
  if (!authorized) {
    return JSON.stringify({
      error: "paper_not_authorized_for_session",
      message: "Only papers found via search_paper in this session may be read. Search first."
    });
  }

  const cacheKey = `read:v1:${cleanRef}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  let result: string;
  if (cleanRef.startsWith("arxiv:")) {
    const shortId = cleanRef.slice("arxiv:".length);
    const record = await readArxivAbstract(shortId);
    result = record
      ? JSON.stringify({
          ref: cleanRef,
          title: record.title,
          authors: record.authors,
          published: record.published,
          url: record.url,
          pdf_url: record.pdf_url,
          abstract: record.summary
        })
      : JSON.stringify({ error: `Paper ${cleanRef} not found` });
  } else if (cleanRef.startsWith("pubmed:")) {
    const id = cleanRef.slice("pubmed:".length);
    const abstract = await readPubmedAbstract(id);
    result = abstract
      ? JSON.stringify({ ref: cleanRef, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, abstract })
      : JSON.stringify({ error: `Paper ${cleanRef} not found` });
  } else {
    result = JSON.stringify({ error: `Unsupported ref: ${cleanRef}` });
  }

  await cacheSet(env, cacheKey, result, PAPER_CACHE_TTL_SECONDS);
  return result;
}

// OpenAI-compatible tool schemas advertised to StepFun.
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "request_task_creation",
      description:
        "Request an inline confirmation card when the user wants to create a background Analysis/Coding task. This does not create the task; wait for the user to submit the requested files before claiming it is queued.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Suggested task title." },
          analysis_type: { type: "string", description: "Suggested analysis type, for example generic or trait_extraction." },
          research_question: { type: "string", description: "The question or goal the task should answer." },
          method_document_name: { type: "string", description: "Optional expected execution-document filename." },
          dataset_name: { type: "string", description: "Optional expected dataset filename." }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_paper",
      description:
        "Search academic papers on arXiv and PubMed. Returns normalized metadata including a `ref` field to pass to read_paper.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          num_results: { type: "integer", description: "Max results (1-25).", default: 10 }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_paper",
      description:
        "Read abstract and metadata for a paper. `ref` MUST come from a prior search_paper result in this session.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Paper ref, e.g. 'arxiv:2103.03404' or 'pubmed:12345678'." }
        },
        required: ["ref"]
      }
    }
  }
] as const;

export async function runTool(
  env: Env,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name === "request_task_creation") {
    return JSON.stringify({
      status: "confirmation_required",
      message: "The inline task confirmation card must be completed before this task can be created."
    });
  }
  if (name === "search_paper") {
    return searchPaper(env, sessionId, String(args.query ?? ""), Number(args.num_results ?? 10));
  }
  if (name === "read_paper") {
    return readPaper(env, sessionId, String(args.ref ?? ""));
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}
