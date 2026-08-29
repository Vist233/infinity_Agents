import { PAPER_CACHE_TTL_SECONDS, modelProvider, type Env } from "./env";
import {
  authorizePapers,
  cacheGet,
  cacheSet,
  createPaperResource,
  findOwnedPaperResourceBySource,
  getOwnedPaperResource,
  isPaperAuthorized,
  linkPaperResource,
  recordPaperAuditEvent,
  type PaperResourceRow,
  type PaperSourceKind,
} from "./db";
import { getPaperObject } from "./paper-object-store";

// Pure-HTTP implementation of Analysis' search_paper / read_paper tools.
// Sources: arXiv Atom API + PubMed E-utilities. PDF parsing remains in the
// dedicated Processor; Edge reads only authorized R2-backed manifests/pages.
// Access control: a paper may only be read in a session if it was surfaced by
// search (or a prior read) in that same session.

const ARXIV_API = "http://export.arxiv.org/api/query";
const PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const MAX_PAPER_PAGES_BYTES = 8 * 1024 * 1024;
const MAX_PAPER_MANIFEST_BYTES = 256 * 1024;
const MAX_PAGE_SELECTION = 100;
const MAX_SEARCH_QUERY_CHARS = 128;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_IMAGE_PROMPT_CHARS = 1_000;
const ARXIV_ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i;

export type PaperAvailability =
  | { kind: "materializable" }
  | {
      kind: "abstract_only";
      reason_code: "PUBMED_PMC_NOT_RESOLVED";
      message: "No eligible PMCID was resolved for this PubMed result.";
    };

const PUBMED_PMC_NOT_RESOLVED = {
  kind: "abstract_only",
  reason_code: "PUBMED_PMC_NOT_RESOLVED",
  message: "No eligible PMCID was resolved for this PubMed result.",
} as const satisfies PaperAvailability;

export interface PaperRecord {
  source: "arxiv" | "pubmed";
  ref: string; // canonical id used for read_paper, e.g. "arxiv:2103.03404" / "pubmed:12345678"
  paper_ref: string;
  title: string;
  authors: string[];
  url: string;
  pdf_url?: string;
  published?: string | null;
  summary?: string;
  availability: PaperAvailability;
}

export type PaperReadMode = "text" | "search" | "outline" | "images";

export interface PaperReadInput {
  resource_id?: string;
  mode?: PaperReadMode;
  paper_ref?: string;
  pages?: number[] | { from: number; to: number };
  query?: string;
  regex?: boolean;
  max_chars?: number;
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
      paper_ref: `arxiv:${shortId}`,
      title: title.replace(/\s+/g, " ").trim(),
      authors,
      url: idUrl,
      pdf_url: pdfUrl ?? `https://arxiv.org/pdf/${shortId}`,
      published,
      summary: truncate(summary),
      availability: { kind: "materializable" },
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
        paper_ref: `pubmed:${id}`,
        title: String(item.title ?? "(untitled)").replace(/\s+/g, " ").trim(),
        authors,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        published: item.pubdate ?? null,
        summary: truncate(item.title ?? ""),
        availability: { ...PUBMED_PMC_NOT_RESOLVED },
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

function normalizeCachedPaperRecord(record: PaperRecord): PaperRecord {
  const paperRef = record.paper_ref ?? record.ref;
  if (record.source === "pubmed" && !/^pubmed:PMC\d+$/i.test(paperRef)) {
    return { ...record, paper_ref: paperRef, availability: { ...PUBMED_PMC_NOT_RESOLVED } };
  }
  return {
    ...record,
    paper_ref: paperRef,
    availability: record.availability ?? { kind: "materializable" },
  };
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
    records = (JSON.parse(cached) as PaperRecord[]).map(normalizeCachedPaperRecord);
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

async function readAbstract(env: Env, sessionId: string, ref: string): Promise<string> {
  const cleanRef = ref.trim();
  if (!cleanRef) return JSON.stringify({ error: "paper_ref_required" });
  const authorized = await isPaperAuthorized(env, sessionId, cleanRef);
  if (!authorized) {
    return JSON.stringify({
      error: "paper_not_authorized_for_session",
      message: "Only papers found via search_paper in this session may be read. Search first."
    });
  }

  const cacheKey = `read:v1:${cleanRef}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return JSON.stringify({ mode: "abstract", ...JSON.parse(cached) });

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
      ? JSON.stringify({ ref: cleanRef, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, abstract, availability: { ...PUBMED_PMC_NOT_RESOLVED } })
      : JSON.stringify({ error: `Paper ${cleanRef} not found` });
  } else {
    result = JSON.stringify({ error: `Unsupported ref: ${cleanRef}` });
  }

  await cacheSet(env, cacheKey, result, PAPER_CACHE_TTL_SECONDS);
  const parsed = JSON.parse(result) as Record<string, unknown>;
  return JSON.stringify({ mode: "abstract", ...parsed });
}

function sourceForPaperRef(paperRef: string): { sourceKind: PaperSourceKind; sourceRef: string; canonicalRef: string } | null {
  const match = paperRef.match(/^arxiv:(.+)$/i);
  if (match && ARXIV_ID_PATTERN.test(match[1])) {
    const identifier = match[1];
    return { sourceKind: "arxiv", sourceRef: identifier, canonicalRef: identifier };
  }
  const pmc = paperRef.match(/^pubmed:(PMC\d+)$/i);
  if (pmc) {
    const identifier = pmc[1].toUpperCase();
    return { sourceKind: "pubmed_pmc", sourceRef: identifier, canonicalRef: identifier };
  }
  return null;
}

function pubmedAbstractOnlyResult(paperRef: string): string {
  return JSON.stringify({
    error: "paper_pubmed_full_text_unavailable",
    paper_ref: paperRef,
    availability: "abstract_only",
    reason_code: PUBMED_PMC_NOT_RESOLVED.reason_code,
    message: "This PubMed result is abstract-only until an eligible PMCID is resolved; no PDF resource was created.",
  });
}

function processingResult(resource: PaperResourceRow, reused = false): string {
  return JSON.stringify({
    mode: "processing",
    resource_id: resource.resource_id,
    status: resource.status,
    source: resource.source_kind,
    ...(reused ? { reused: true } : {}),
    ...(resource.error_code ? { error_code: resource.error_code } : {}),
    message: resource.status === "failed"
      ? "Paper processing failed; do not retry the same request in a loop."
      : "Paper processing is durable; report progress and continue after it becomes ready."
  });
}

/** Create or reuse the session-owned durable resource for a surfaced paper. */
export async function materializePaper(env: Env, sessionId: string, userId: string, paperRef: string): Promise<string> {
  const cleanRef = paperRef.trim();
  if (!cleanRef) return JSON.stringify({ error: "paper_ref_required" });
  if (!(await isPaperAuthorized(env, sessionId, cleanRef))) {
    return JSON.stringify({ error: "paper_not_authorized_for_session", message: "Search for the paper in this session first." });
  }
  if (/^pubmed:\d+$/i.test(cleanRef)) return pubmedAbstractOnlyResult(cleanRef);
  const source = sourceForPaperRef(cleanRef);
  if (!source) {
    return JSON.stringify({ error: "paper_source_not_eligible", message: "Only canonical arXiv or eligible PMC references can be materialized." });
  }
  const existing = await findOwnedPaperResourceBySource(env, {
    sessionId,
    userId,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
  });
  if (existing) {
    await recordPaperAuditEvent(env, { resource_id: existing.resource_id, attempt_id: null, stage: "materialize", outcome: "succeeded", error_code: null, metadata_json: JSON.stringify({ reused: true }), created_at: Math.floor(Date.now() / 1000) });
    return processingResult(existing, true);
  }

  try {
    const resource = await createPaperResource(env, {
      resource_id: crypto.randomUUID(),
      session_id: sessionId,
      user_id: userId,
      source_kind: source.sourceKind,
      source_ref: source.sourceRef,
      canonical_ref: source.canonicalRef,
      title: null,
    });
    if (!(await linkPaperResource(env, sessionId, resource.resource_id, userId, "read"))) {
      return JSON.stringify({ error: "paper_resource_link_failed" });
    }
    await recordPaperAuditEvent(env, { resource_id: resource.resource_id, attempt_id: null, stage: "materialize", outcome: "succeeded", error_code: null, metadata_json: "{}", created_at: Math.floor(Date.now() / 1000) });
    return processingResult(resource);
  } catch {
    return JSON.stringify({ error: "paper_materialization_failed" });
  }
}

async function readObjectBytes(env: Env, resourceId: string, kind: "text_pages" | "text_manifest" | "image_manifest" | "image", maximumBytes: number, objectId?: string): Promise<Uint8Array | null> {
  const object = await getPaperObject(env, resourceId, kind, objectId ?? (kind === "text_pages" ? "pages" : undefined));
  if (!object) return null;
  if (object.size > maximumBytes) throw new Error("paper object exceeds the tool limit");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("paper object exceeds the tool limit");
  return bytes;
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("provider response exceeds limit");
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseTextPages(bytes: Uint8Array): Array<{ page: number; text: string }> | null {
  const pages: Array<{ page: number; text: string }> = [];
  const lines = new TextDecoder().decode(bytes).split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    if (pages.length >= 10_000) return null;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const page = value.page;
      const text = value.text;
      if (!Number.isSafeInteger(page) || Number(page) <= 0 || typeof text !== "string") return null;
      pages.push({ page: Number(page), text });
    } catch {
      return null;
    }
  }
  return pages.sort((left, right) => left.page - right.page);
}

function parsePageManifest(bytes: Uint8Array, resourceId: string): Set<number> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (value.resource_id !== resourceId || !Array.isArray(value.pages) || value.pages.length > 10_000) return null;
    const pages = new Set<number>();
    for (const item of value.pages) {
      if (!item || typeof item !== "object") return null;
      const page = (item as Record<string, unknown>).page;
      if (!Number.isSafeInteger(page) || Number(page) <= 0) return null;
      pages.add(Number(page));
    }
    return pages;
  } catch {
    return null;
  }
}

type PaperImage = { image_id: string; page: number; width?: number; height?: number; content_type?: string; size_bytes?: number; sha256?: string };

function parseImageManifest(bytes: Uint8Array, resourceId: string): PaperImage[] | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (value.resource_id !== resourceId || !Array.isArray(value.images) || value.images.length > 100_000) return null;
    const images: PaperImage[] = [];
    for (const item of value.images) {
      if (!item || typeof item !== "object") return null;
      const image = item as Record<string, unknown>;
      if (typeof image.image_id !== "string" || !/^page-\d{4}-image-\d{4}$/.test(image.image_id)
        || !Number.isSafeInteger(image.page) || Number(image.page) <= 0) return null;
      images.push({
        image_id: image.image_id,
        page: Number(image.page),
        ...(Number.isSafeInteger(image.width) ? { width: Number(image.width) } : {}),
        ...(Number.isSafeInteger(image.height) ? { height: Number(image.height) } : {}),
        ...(typeof image.content_type === "string" ? { content_type: image.content_type.slice(0, 64) } : {}),
        ...(Number.isSafeInteger(image.size_bytes) ? { size_bytes: Number(image.size_bytes) } : {}),
        ...(typeof image.sha256 === "string" && /^[0-9a-f]{64}$/i.test(image.sha256) ? { sha256: image.sha256.toLowerCase() } : {}),
      });
    }
    return images;
  } catch {
    return null;
  }
}

function selectedPages(input: PaperReadInput, pageNumbers: Set<number>): number[] | string {
  const value = input.pages;
  if (value == null) {
    const all = [...pageNumbers].sort((left, right) => left - right);
    return all.length <= MAX_PAGE_SELECTION ? all : "paper_page_selection_required";
  }
  let pages: number[];
  if (Array.isArray(value)) {
    pages = value;
  } else if (value && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && value.from > 0 && value.to >= value.from) {
    if (value.to - value.from + 1 > MAX_PAGE_SELECTION) return "paper_page_selection_too_large";
    pages = Array.from({ length: value.to - value.from + 1 }, (_unused, index) => value.from + index);
  } else {
    return "paper_pages_invalid";
  }
  if (pages.length === 0 || pages.length > MAX_PAGE_SELECTION || pages.some((page) => !Number.isSafeInteger(page) || page <= 0)) return "paper_pages_invalid";
  const unique = [...new Set(pages)].sort((left, right) => left - right);
  return unique.every((page) => pageNumbers.has(page)) ? unique : "paper_page_not_in_manifest";
}

function searchPattern(query: string, regex: boolean): RegExp | string {
  if (!query || query.length > MAX_SEARCH_QUERY_CHARS) return "paper_query_invalid";
  if (!regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  if (/(?:\\\d|\\k|\(\?[=!<]|\([^)]*[+*][^)]*\)[+*])/.test(query)) return "paper_regex_unsafe";
  try {
    return new RegExp(query, "iu");
  } catch {
    return "paper_regex_invalid";
  }
}

function excerpt(text: string, start: number, maxChars: number): string {
  const begin = Math.max(0, start - 120);
  return text.slice(begin, begin + Math.min(400, maxChars)).replace(/\s+/g, " ").trim();
}

/**
 * Read a durable resource. The three-argument form remains a compatibility
 * adapter for legacy abstract reads; resource reads always carry user/session
 * ownership and an explicit mode.
 */
export async function readPaper(env: Env, sessionId: string, userIdOrRef: string, input?: PaperReadInput): Promise<string> {
  if (input === undefined) return readAbstract(env, sessionId, userIdOrRef);
  const resourceId = String(input.resource_id ?? "").trim();
  const paperRef = String(input.paper_ref ?? "").trim();
  if (!resourceId && paperRef) return readAbstract(env, sessionId, paperRef);
  if (!resourceId) return JSON.stringify({ error: "paper_resource_id_required" });
  const resource = await getOwnedPaperResource(env, resourceId, sessionId, userIdOrRef);
  if (!resource) return JSON.stringify({ error: "paper_resource_not_authorized", message: "This paper resource is not owned by the current user/session." });
  if (resource.status === "deleted") return JSON.stringify({ error: "paper_resource_deleted" });
  if (resource.status !== "ready") return processingResult(resource);
  const mode = input.mode;
  if (mode !== "text" && mode !== "search" && mode !== "outline" && mode !== "images") return JSON.stringify({ error: "paper_mode_invalid" });

  if (mode === "images") {
    let bytes: Uint8Array | null;
    try { bytes = await readObjectBytes(env, resourceId, "image_manifest", MAX_PAPER_MANIFEST_BYTES); } catch { return JSON.stringify({ error: "paper_manifest_too_large" }); }
    const images = bytes ? parseImageManifest(bytes, resourceId) : null;
    if (!images) return JSON.stringify({ error: "paper_image_manifest_invalid" });
    return JSON.stringify({ mode: "full_text", operation: "images", resource_id: resourceId, images: images.slice(0, 100) });
  }

  let manifestBytes: Uint8Array | null;
  try { manifestBytes = await readObjectBytes(env, resourceId, "text_manifest", MAX_PAPER_MANIFEST_BYTES); } catch { return JSON.stringify({ error: "paper_manifest_too_large" }); }
  const manifestPages = manifestBytes ? parsePageManifest(manifestBytes, resourceId) : null;
  if (!manifestPages) return JSON.stringify({ error: "paper_text_manifest_invalid" });
  let pageBytes: Uint8Array | null;
  try { pageBytes = await readObjectBytes(env, resourceId, "text_pages", MAX_PAPER_PAGES_BYTES); } catch { return JSON.stringify({ error: "paper_text_pages_too_large" }); }
  const pages = pageBytes ? parseTextPages(pageBytes) : null;
  if (!pages) return JSON.stringify({ error: "paper_text_pages_invalid" });
  const availablePages = new Set(pages.map((page) => page.page));
  if ([...manifestPages].some((page) => !availablePages.has(page))) return JSON.stringify({ error: "paper_text_pages_missing" });
  const selection = selectedPages(input, manifestPages);
  if (typeof selection === "string") return JSON.stringify({ error: selection });
  const selected = pages.filter((page) => selection.includes(page.page));
  const maxCharsValue = input.max_chars;
  const maxChars = Number.isSafeInteger(maxCharsValue) ? Math.max(100, Math.min(Number(maxCharsValue), MAX_TOOL_RESULT_CHARS)) : 8_000;

  if (mode === "text") {
    let used = 0;
    const output = selected.map((page) => {
      const remaining = Math.max(0, maxChars - used);
      const text = page.text.slice(0, remaining);
      used += text.length;
      return { page: page.page, text };
    });
    return JSON.stringify({ mode: "full_text", operation: "text", resource_id: resourceId, pages: output, citations: output.map((page) => ({ resource_id: resourceId, page: page.page, excerpt: page.text.slice(0, 400) })) });
  }

  if (mode === "outline") {
    const outline: Array<{ resource_id: string; page: number; heading: string }> = [];
    for (const page of selected) {
      for (const line of page.text.split(/\r?\n/)) {
        const heading = line.trim();
        if (heading && (/^\d+(?:\.\d+)*[.)]?\s+/.test(heading) || /^[A-Z][A-Z0-9\s]{5,}$/.test(heading))) {
          outline.push({ resource_id: resourceId, page: page.page, heading: heading.slice(0, 200) });
        }
        if (outline.length >= 200) break;
      }
    }
    return JSON.stringify({ mode: "full_text", operation: "outline", resource_id: resourceId, outline });
  }

  const query = String(input.query ?? "").trim();
  const pattern = searchPattern(query, input.regex === true);
  if (typeof pattern === "string") return JSON.stringify({ error: pattern });
  const citations: Array<{ resource_id: string; page: number; excerpt: string }> = [];
  for (const page of selected) {
    const match = pattern.exec(page.text);
    if (match && citations.length < 100) citations.push({ resource_id: resourceId, page: page.page, excerpt: excerpt(page.text, match.index, maxChars) });
  }
  return JSON.stringify({ mode: "full_text", operation: "search", resource_id: resourceId, query, citations });
}

export async function analyzePaperImage(
  env: Env,
  sessionId: string,
  userId: string,
  resourceId: string,
  imageId: string,
  prompt: string,
  detail: string,
): Promise<string> {
  const resource = await getOwnedPaperResource(env, resourceId.trim(), sessionId, userId);
  if (!resource) return JSON.stringify({ error: "paper_resource_not_authorized" });
  if (resource.status !== "ready") return processingResult(resource);
  if (!/^page-\d{4}-image-\d{4}$/.test(imageId)) return JSON.stringify({ error: "paper_image_id_invalid" });
  const cleanPrompt = prompt.trim().slice(0, MAX_IMAGE_PROMPT_CHARS);
  if (!cleanPrompt) return JSON.stringify({ error: "paper_image_prompt_required" });
  if (detail !== "low" && detail !== "high") return JSON.stringify({ error: "paper_image_detail_invalid" });
  let bytes: Uint8Array | null;
  try { bytes = await readObjectBytes(env, resourceId, "image_manifest", MAX_PAPER_MANIFEST_BYTES); } catch { return JSON.stringify({ error: "paper_manifest_too_large" }); }
  const image = bytes ? parseImageManifest(bytes, resourceId)?.find((candidate) => candidate.image_id === imageId) : null;
  if (!image) return JSON.stringify({ error: "paper_image_not_in_manifest" });
  if (env.PAPER_IMAGE_ANALYSIS_EGRESS !== "enabled") {
    await recordPaperAuditEvent(env, { resource_id: resourceId, attempt_id: null, stage: "image_analysis", outcome: "denied", error_code: "PAPER_IMAGE_EGRESS_DENIED", metadata_json: JSON.stringify({ detail, image_id: imageId }), created_at: Math.floor(Date.now() / 1000) });
    return JSON.stringify({ error: "paper_image_egress_denied", message: "Image analysis egress is disabled by policy." });
  }
  let imageBytes: Uint8Array | null;
  try { imageBytes = await readObjectBytes(env, resourceId, "image", 8 * 1024 * 1024, imageId); } catch {
    await recordPaperAuditEvent(env, { resource_id: resourceId, attempt_id: null, stage: "image_analysis", outcome: "failed", error_code: "PAPER_IMAGE_TOO_LARGE", metadata_json: JSON.stringify({ detail, image_id: imageId }), created_at: Math.floor(Date.now() / 1000) });
    return JSON.stringify({ error: "paper_image_too_large" });
  }
  if (!imageBytes) return JSON.stringify({ error: "paper_image_not_found" });
  const analysisRequestId = crypto.randomUUID();
  const provider = modelProvider(env);
  const auditMetadata = JSON.stringify({ detail, image_id: imageId, size_bytes: imageBytes.byteLength, provider_model: provider.model.slice(0, 128) });
  await recordPaperAuditEvent(env, { event_id: `paper-image-start:${analysisRequestId}`, resource_id: resourceId, attempt_id: null, stage: "image_analysis", outcome: "started", error_code: null, metadata_json: auditMetadata, created_at: Math.floor(Date.now() / 1000) });
  const encoded: string[] = [];
  // 0x7ffe is divisible by three, so concatenating chunk encodings preserves
  // valid base64 boundaries without constructing a second multi-megabyte copy.
  for (let offset = 0; offset < imageBytes.byteLength; offset += 0x7ffe) {
    let binary = "";
    const chunk = imageBytes.subarray(offset, Math.min(offset + 0x7ffe, imageBytes.byteLength));
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded.push(btoa(binary));
  }
  const contentType = image.content_type && ["image/png", "image/jpeg", "image/jp2"].includes(image.content_type) ? image.content_type : "image/png";
  let text: string | null = null;
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: [{ type: "text", text: cleanPrompt }, { type: "image_url", image_url: { url: `data:${contentType};base64,${encoded.join("")}`, detail } }] }],
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await boundedResponseText(response, 64 * 1024);
    if (response.ok && raw) {
      const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      text = typeof content === "string" ? content.trim().slice(0, 4_000) : null;
    }
  } catch {
    text = null;
  }
  if (!text) {
    await recordPaperAuditEvent(env, { event_id: `paper-image-failed:${analysisRequestId}`, resource_id: resourceId, attempt_id: null, stage: "image_analysis", outcome: "failed", error_code: "PAPER_IMAGE_ANALYSIS_FAILED", metadata_json: auditMetadata, created_at: Math.floor(Date.now() / 1000) });
    return JSON.stringify({ error: "paper_image_analysis_failed", analysis_request_id: analysisRequestId });
  }
  await recordPaperAuditEvent(env, { event_id: `paper-image-success:${analysisRequestId}`, resource_id: resourceId, attempt_id: null, stage: "image_analysis", outcome: "succeeded", error_code: null, metadata_json: auditMetadata, created_at: Math.floor(Date.now() / 1000) });
  return JSON.stringify({
    mode: "image_analysis",
    status: "succeeded",
    analysis_request_id: analysisRequestId,
    resource_id: resourceId,
    image_id: image.image_id,
    page: image.page,
    detail,
    prompt: cleanPrompt,
    text,
    provenance: { resource_id: resourceId, image_id: image.image_id, page: image.page },
    message: "Image analysis completed with resource and page provenance.",
  });
}

// OpenAI-compatible tool schemas advertised to StepFun.
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "request_task_creation",
      description:
        "Prepare a readable task draft and open the inline confirmation card only when the user explicitly asks to create, submit, run, or queue a background analysis. Do not use this for a paper-method question. Draft the execution document yourself when the method is known, so the user can review/edit it in the card; the user still supplies or confirms the ZIP dataset. The tool does not create a task until the card is submitted.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A concise, user-readable task title. Default it from the execution document or research goal, not an internal ID." },
          analysis_type: { type: "string", description: "The proposed analysis type, for example generic, biopython, scanpy, or trait_extraction." },
          research_question: { type: "string", description: "The scientific question, expected comparison, and concrete output the task should answer." },
          method_document_name: { type: "string", description: "Optional suggested execution-document filename. The document itself is reviewed in the card." },
          method_document_content: { type: "string", description: "A concise, reproducible Markdown execution document drafted from the user's goal and known method. Include inputs, steps, deliverables, and acceptance checks; never include secrets." },
          dataset_name: { type: "string", description: "Optional suggested ZIP dataset filename or dataset description." }
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
        "Search academic papers on arXiv and PubMed. arXiv results are materializable; PubMed results are abstract-only unless a separately resolved eligible PMCID is returned, and include an availability reason.",
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
      name: "materialize_paper",
      description:
        "Create or reuse a durable, session-owned PDF resource for an authorized canonical arXiv or eligible PMC paper. Returns processing progress; it never pretends a pending or failed resource is readable full text.",
      parameters: {
        type: "object",
        properties: {
          paper_ref: { type: "string", description: "Canonical paper ref from search_paper, such as arxiv:2401.00001." }
        },
        required: ["paper_ref"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_paper",
      description:
        "Read a session-owned materialized paper. For full text, resource_id and mode are required; mode is text, search, outline, or images. A paper_ref without resource_id is an explicitly labeled abstract read and never a PDF fallback.",
      parameters: {
        type: "object",
        properties: {
          paper_ref: { type: "string", description: "Authorized paper ref for an abstract read." },
          resource_id: { type: "string", description: "Opaque resource ID returned by materialize_paper." },
          mode: { type: "string", enum: ["text", "search", "outline", "images"] },
          pages: { description: "A bounded page number array or {from,to} range." },
          query: { type: "string", description: "Bounded search text; literal by default." },
          regex: { type: "boolean", description: "Use the bounded safe regex policy for query." },
          max_chars: { type: "integer", description: "Maximum returned text characters." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_paper_image",
      description:
        "Queue analysis for one image in a ready, session-owned paper resource. Returns only bounded metadata and resource/page/image provenance; no server path or storage key is exposed.",
      parameters: {
        type: "object",
        properties: {
          resource_id: { type: "string", description: "Opaque resource ID returned by materialize_paper." },
          image_id: { type: "string", description: "Manifest image ID, for example page-0001-image-0001." },
          prompt: { type: "string", description: "Bounded image-analysis question." },
          detail: { type: "string", enum: ["low", "high"], default: "low" }
        },
        required: ["resource_id", "image_id", "prompt"]
      }
    }
  }
] as const;

export async function runTool(
  env: Env,
  sessionId: string,
  userId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name === "request_task_creation") {
    return JSON.stringify({
      status: "confirmation_required",
      message: "A task draft is ready for the user to review. The task will be created only after the execution document and ZIP dataset are submitted through the confirmation card."
    });
  }
  if (name === "search_paper") {
    return searchPaper(env, sessionId, String(args.query ?? ""), Number(args.num_results ?? 10));
  }
  if (name === "materialize_paper") {
    return materializePaper(env, sessionId, userId, String(args.paper_ref ?? args.ref ?? ""));
  }
  if (name === "read_paper") {
    return readPaper(env, sessionId, userId, {
      resource_id: typeof args.resource_id === "string" ? args.resource_id : undefined,
      paper_ref: typeof args.paper_ref === "string" ? args.paper_ref : (typeof args.ref === "string" ? args.ref : undefined),
      mode: args.mode as PaperReadMode | undefined,
      pages: Array.isArray(args.pages) ? args.pages.filter((page): page is number => typeof page === "number") : (args.pages as PaperReadInput["pages"] | undefined),
      query: typeof args.query === "string" ? args.query : undefined,
      regex: args.regex === true,
      max_chars: typeof args.max_chars === "number" ? args.max_chars : undefined,
    });
  }
  if (name === "analyze_paper_image") {
    return analyzePaperImage(
      env,
      sessionId,
      userId,
      String(args.resource_id ?? ""),
      String(args.image_id ?? ""),
      String(args.prompt ?? ""),
      String(args.detail ?? "low"),
    );
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}
