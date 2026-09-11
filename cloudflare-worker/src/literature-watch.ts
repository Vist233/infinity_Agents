import type { Env } from "./env";
import { createChatSession, createPaperResource, deletePaperResource } from "./db";
import { countLiteraturePapersCreatedBetween, createPaperCatalog, findPublicPaperBySource, getLiteratureWatchState, saveLiteratureWatchState } from "./discovery-db";
import { hashText } from "./sha256";

const DEFAULT_QUERY = "machine learning AND dataset";
const PUBLIC_OWNER = "system-literature-watch";
const MAX_QUERY_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_ABSTRACT_LENGTH = 20_000;
const MAX_AUTHORS = 128;
const MAX_TIMEOUT_MS = 8_000;
const SOURCES = new Set(["arxiv", "europe_pmc"]);

export interface LiteratureRecord {
  source: "arxiv" | "europe_pmc";
  sourceRef: string;
  canonicalRef: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string;
}

export interface LiteratureRunSummary {
  enabled: boolean;
  fetched: number;
  created: number;
  duplicates: number;
  failed: number;
  cursors: Record<string, string | null>;
}

function bounded(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function xmlDecode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function xmlTag(value: string, tag: string): string {
  const match = value.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? xmlDecode(match[1].replace(/<[^>]+>/g, " ")) : "";
}

function normalizeRecord(record: LiteratureRecord): LiteratureRecord | null {
  const sourceRef = bounded(record.sourceRef, 255);
  const canonicalRef = bounded(record.canonicalRef, 512);
  const title = bounded(record.title, MAX_TITLE_LENGTH);
  if (!sourceRef || !canonicalRef || !title) return null;
  const authors = record.authors.map((author) => bounded(author, 255)).filter(Boolean).slice(0, MAX_AUTHORS);
  return { source: record.source, sourceRef, canonicalRef, title, authors, year: Number.isInteger(record.year) && (record.year === null || (record.year >= 1800 && record.year <= 2200)) ? record.year : null, venue: record.venue ? bounded(record.venue, 512) || null : null, abstract: bounded(record.abstract, MAX_ABSTRACT_LENGTH) };
}

export function parseArxivFeed(xml: string, limit = 10): { records: LiteratureRecord[]; nextCursor: string | null } {
  const entries = [...xml.slice(0, 2_000_000).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].slice(0, Math.min(100, Math.max(1, limit)));
  const records: LiteratureRecord[] = [];
  for (const entryMatch of entries) {
    const entry = entryMatch[0];
    // arXiv version suffixes are attached to the identifier (`2401.00001v2`)
    // rather than separated by a slash. Canonicalize both URL forms so a
    // revision cannot create a second public catalog entry.
    const idUrl = xmlTag(entry, "id").replace(/\/?v\d+$/i, "");
    const identifier = idUrl.match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+)$/i)?.[1] ?? "";
    if (!identifier) continue;
    const authors = [...entry.matchAll(/<author\b[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((match) => xmlDecode(match[1]));
    const published = xmlTag(entry, "published");
    const year = Number(published.slice(0, 4));
    const record = normalizeRecord({ source: "arxiv", sourceRef: identifier, canonicalRef: `https://arxiv.org/abs/${identifier}`, title: xmlTag(entry, "title"), authors, year: Number.isInteger(year) ? year : null, venue: "arXiv", abstract: xmlTag(entry, "summary") });
    if (record) records.push(record);
  }
  const next = xmlTag(xml.slice(-100_000), "opensearch:totalResults");
  return { records, nextCursor: next && Number.isFinite(Number(next)) ? String(records.length) : null };
}

export function parseEuropePmcResponse(value: unknown, limit = 10): { records: LiteratureRecord[]; nextCursor: string | null } {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const resultList = root.resultList && typeof root.resultList === "object" ? (root.resultList as Record<string, unknown>).result : [];
  const values = Array.isArray(resultList) ? resultList.slice(0, Math.min(100, Math.max(1, limit))) : [];
  const records: LiteratureRecord[] = [];
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pmcid = bounded(row.pmcid, 255).toUpperCase();
    const medId = bounded(row.id, 255);
    const sourceRef = pmcid.startsWith("PMC") ? pmcid : medId ? `MED:${medId}` : "";
    const canonicalRef = pmcid.startsWith("PMC") ? `https://europepmc.org/article/PMC/${pmcid}` : medId ? `https://europepmc.org/article/MED/${medId}` : "";
    const authors = bounded(row.authorString, 2_000).split(/,|;/).map((author) => author.trim()).filter(Boolean);
    const rawYear = Number(row.pubYear);
    const record = normalizeRecord({ source: "europe_pmc", sourceRef, canonicalRef, title: bounded(row.title, MAX_TITLE_LENGTH), authors, year: Number.isInteger(rawYear) ? rawYear : null, venue: bounded(row.journalTitle, 512) || null, abstract: bounded(row.abstractText, MAX_ABSTRACT_LENGTH) });
    if (record) records.push(record);
  }
  const next = bounded(root.nextCursorMark, 512) || null;
  return { records, nextCursor: next };
}

function enabled(env: Env): boolean {
  return String(env.DISCOVERY_LITERATURE_ENABLED ?? "").trim().toLowerCase() === "true";
}

function configuredLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function configuredSources(value: unknown): Array<"arxiv" | "europe_pmc"> {
  const raw = String(value ?? "arxiv,europe_pmc").split(",").map((item) => item.trim().toLowerCase()).filter((item): item is "arxiv" | "europe_pmc" => SOURCES.has(item));
  return [...new Set(raw)].slice(0, 2);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { accept: "application/json, application/atom+xml", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source: "arxiv" | "europe_pmc", query: string, cursor: string | null, limit: number): Promise<{ records: LiteratureRecord[]; nextCursor: string | null }> {
  if (source === "arxiv") {
    const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${Math.min(100_000, start)}&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`ARXIV_HTTP_${response.status}`);
    const parsed = parseArxivFeed(await response.text(), limit);
    return { records: parsed.records, nextCursor: String(start + parsed.records.length) };
  }
  const marker = cursor || "*";
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&query=${encodeURIComponent(query)}&pageSize=${limit}&cursorMark=${encodeURIComponent(marker)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`EUROPE_PMC_HTTP_${response.status}`);
  const parsed = parseEuropePmcResponse(await response.json(), limit);
  return parsed;
}

async function materializePublicPaper(env: Env, record: LiteratureRecord, now: number): Promise<"created" | "duplicate" | "failed"> {
  if (await findPublicPaperBySource(env, record.source === "arxiv" ? "arxiv" : "pubmed_pmc", record.sourceRef)) return "duplicate";
  const resourceId = `literature-resource-${crypto.randomUUID()}`;
  const paperId = `literature-paper-${hashText(`${record.source}:${record.sourceRef}`).slice(0, 40)}`;
  // The catalog identity is deterministic for observability, while the
  // session/resource IDs are fresh so an interrupted partial write can be
  // retried without colliding with a stale chat session row.
  const sessionId = `literature-session-${crypto.randomUUID()}`;
  let resourceCreated = false;
  try {
    await createChatSession(env, sessionId, PUBLIC_OWNER, `Literature: ${record.title.slice(0, 180)}`);
    await createPaperResource(env, { resource_id: resourceId, session_id: sessionId, user_id: PUBLIC_OWNER, source_kind: record.source === "arxiv" ? "arxiv" : "pubmed_pmc", source_ref: record.sourceRef, canonical_ref: record.canonicalRef, title: record.title });
    resourceCreated = true;
    const inserted = await createPaperCatalog(env, { paperId, ownerUserId: null, resourceId, visibility: "public", title: record.title, authorsJson: JSON.stringify(record.authors), year: record.year, venue: record.venue, now });
    if (inserted) return "created";
    // A concurrent watcher may win the catalog insert. Clean up only the
    // resource created by this attempt; the winning catalog remains intact.
    if (resourceCreated) await deletePaperResource(env, { resourceId, sessionId, userId: PUBLIC_OWNER, now });
    return (await findPublicPaperBySource(env, record.source === "arxiv" ? "arxiv" : "pubmed_pmc", record.sourceRef)) ? "duplicate" : "failed";
  } catch {
    if (resourceCreated) {
      try { await deletePaperResource(env, { resourceId, sessionId, userId: PUBLIC_OWNER, now }); } catch { /* best effort cleanup */ }
    }
    return "failed";
  }
}

/** Bounded, opt-in scheduled source watcher. Provider failures never block other sources. */
export async function runLiteratureDiscovery(env: Env, now = Math.floor(Date.now() / 1000)): Promise<LiteratureRunSummary> {
  const summary: LiteratureRunSummary = { enabled: enabled(env), fetched: 0, created: 0, duplicates: 0, failed: 0, cursors: {} };
  if (!summary.enabled) return summary;
  const query = bounded(env.DISCOVERY_LITERATURE_QUERY, MAX_QUERY_LENGTH) || DEFAULT_QUERY;
  const perRun = configuredLimit(env.DISCOVERY_LITERATURE_MAX_PER_RUN, 10, 25);
  const perDay = configuredLimit(env.DISCOVERY_LITERATURE_MAX_PER_DAY, 100, 500);
  const dayStart = Math.floor(now / 86_400) * 86_400;
  const alreadyCreatedToday = await countLiteraturePapersCreatedBetween(env, { ownerUserId: PUBLIC_OWNER, startAt: dayStart, endAt: dayStart + 86_400 });
  let dailyRemaining = Math.max(0, perDay - alreadyCreatedToday);
  let remaining = perRun;
  for (const source of configuredSources(env.DISCOVERY_LITERATURE_SOURCES)) {
    if (remaining <= 0 || dailyRemaining <= 0) break;
    const state = await getLiteratureWatchState(env, source, query);
    const cursor = state?.last_cursor ?? null;
    try {
      const fetchLimit = Math.min(remaining, dailyRemaining);
      const fetched = await fetchSource(source, query, cursor, fetchLimit);
      summary.fetched += fetched.records.length;
      let nextCursor = fetched.nextCursor;
      for (const record of fetched.records.slice(0, fetchLimit)) {
        const outcome = await materializePublicPaper(env, record, now);
        if (outcome === "created") {
          summary.created += 1;
          dailyRemaining -= 1;
        }
        else if (outcome === "duplicate") summary.duplicates += 1;
        else summary.failed += 1;
        remaining -= 1;
        if (remaining <= 0) break;
      }
      await saveLiteratureWatchState(env, { source, query, cursor: nextCursor, now });
      summary.cursors[source] = nextCursor;
    } catch {
      summary.failed += 1;
      summary.cursors[source] = cursor;
      // Keep the previous cursor so a transient source failure can be retried.
    }
  }
  // The counter is bounded by both the configured daily budget and the
  // provider page limit. The database count above is the authoritative part
  // of the daily cap; this clamp is a final defensive invariant.
  summary.created = Math.min(summary.created, perDay, alreadyCreatedToday > perDay ? 0 : perDay - alreadyCreatedToday);
  return summary;
}
