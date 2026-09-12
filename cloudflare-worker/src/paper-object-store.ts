import type { Env } from "./env";

export type PaperObjectKind = "source_pdf" | "text_pages" | "text_manifest" | "image" | "image_manifest";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const PAPER_OBJECT_KEY = /^paper\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/(?:source\.pdf|text\/pages\.jsonl|text\/manifest\.json|images\/manifest\.json|images\/page-\d{4}\/image-\d{4}\.png)$/;
const STAGED_PAPER_OBJECT_KEY = /^paper\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/attempts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/epoch-\d+\/(?:source\.pdf|text\/pages\.jsonl|text\/manifest\.json|images\/manifest\.json|images\/page-\d{4}\/image-\d{4}\.png)$/;

export interface PaperObjectVersion {
  attemptId: string;
  fencingEpoch: number;
}

/**
 * Return the canonical key for user-uploaded objects, or an attempt-isolated
 * key for Processor output. Processor output must never be written directly
 * to a key that a later fenced attempt can also mutate.
 */
export function paperObjectKey(resourceId: string, kind: PaperObjectKind, objectId?: string, version?: PaperObjectVersion): string | null {
  if (!SAFE_ID.test(resourceId)) return null;
  const suffix = kind === "source_pdf" ? "source.pdf"
    : kind === "text_pages" ? "text/pages.jsonl"
      : kind === "text_manifest" ? "text/manifest.json"
        : kind === "image_manifest" ? "images/manifest.json"
          : (() => {
            const match = objectId?.match(/^(page-\d{4})-(image-\d{4})$/);
            return match ? `images/${match[1]}/${match[2]}.png` : null;
          })();
  if (!suffix) return null;
  if (!version) return `paper/${resourceId}/${suffix}`;
  if (!SAFE_ID.test(version.attemptId) || !Number.isSafeInteger(version.fencingEpoch) || version.fencingEpoch <= 0) return null;
  return `paper/${resourceId}/attempts/${version.attemptId}/epoch-${version.fencingEpoch}/${suffix}`;
}

function isSafePaperObjectKey(key: string): boolean {
  return PAPER_OBJECT_KEY.test(key) || STAGED_PAPER_OBJECT_KEY.test(key);
}

/**
 * Narrow server-side R2 access for Paper resources. Callers select a fixed
 * logical object kind; callers never supply or receive an R2 key. Ordinary
 * resource reads have no list/prefix API; the scheduler-only cleanup helper
 * below is the sole constrained namespace traversal.
 */
export async function getPaperObject(env: Env, resourceId: string, kind: PaperObjectKind, objectId?: string): Promise<R2ObjectBody | null> {
  if (!env.RESOURCE_BUCKET) return null;
  const key = paperObjectKey(resourceId, kind, objectId);
  return key ? env.RESOURCE_BUCKET.get(key) : null;
}

/** Read a server-persisted object pointer without accepting a caller key. */
export async function getPaperObjectAtKey(env: Env, key: string | null | undefined): Promise<R2ObjectBody | null> {
  if (!env.RESOURCE_BUCKET || !key || !isSafePaperObjectKey(key)) return null;
  return env.RESOURCE_BUCKET.get(key);
}

export async function putPaperObject(
  env: Env,
  resourceId: string,
  kind: PaperObjectKind,
  value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  contentType: string,
  objectId?: string,
  version?: PaperObjectVersion,
): Promise<boolean> {
  if (!env.RESOURCE_BUCKET) return false;
  const key = paperObjectKey(resourceId, kind, objectId, version);
  if (!key) return false;
  await env.RESOURCE_BUCKET.put(key, value, {
    httpMetadata: { contentType },
  });
  return true;
}

export async function deletePaperObjects(env: Env, resourceId: string): Promise<number> {
  if (!env.RESOURCE_BUCKET || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(resourceId)) throw new Error("Paper cleanup storage is unavailable");
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < 10; page += 1) {
    const listing = await env.RESOURCE_BUCKET.list({ prefix: `paper/${resourceId}/`, limit: 1_000, ...(cursor ? { cursor } : {}) });
    for (const object of listing.objects) {
      await env.RESOURCE_BUCKET.delete(object.key);
      deleted += 1;
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return deleted;
}
