import type { Env } from "./env";

export type PaperObjectKind = "source_pdf" | "text_pages" | "text_manifest" | "image" | "image_manifest";

function paperObjectKey(resourceId: string, kind: PaperObjectKind, objectId?: string): string | null {
  if (kind === "source_pdf") return `paper/${resourceId}/source.pdf`;
  if (kind === "text_pages") return `paper/${resourceId}/text/pages.jsonl`;
  if (kind === "text_manifest") return `paper/${resourceId}/text/manifest.json`;
  if (kind === "image_manifest") return `paper/${resourceId}/images/manifest.json`;
  const match = objectId?.match(/^(page-\d{4})-(image-\d{4})$/);
  if (!match) return null;
  return `paper/${resourceId}/images/${match[1]}/${match[2]}.png`;
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

export async function putPaperObject(
  env: Env,
  resourceId: string,
  kind: PaperObjectKind,
  value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  contentType: string,
  objectId?: string,
): Promise<boolean> {
  if (!env.RESOURCE_BUCKET) return false;
  const key = paperObjectKey(resourceId, kind, objectId);
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
