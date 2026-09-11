import type { Env } from "./env";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export type DiscoveryObjectKind = "paper_profile" | "paper_overview" | "dataset_source" | "dataset_profile" | "evaluation";

/** Return a bounded filename suitable for a server-generated dataset key. */
export function safeDiscoveryFilename(value: string, fallback = "data.bin"): string {
  const basename = value.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const normalized = basename.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 255);
  return SAFE_FILENAME.test(normalized) ? normalized : fallback;
}

export function discoveryObjectKey(kind: DiscoveryObjectKind, input: { resourceId?: string; collectionId?: string; matchId?: string; filename?: string }): string | null {
  if (kind === "paper_profile" && input.resourceId && SAFE_ID.test(input.resourceId)) return `paper/${input.resourceId}/profile/paper_profile.v1.json`;
  if (kind === "paper_overview" && input.resourceId && SAFE_ID.test(input.resourceId)) return `paper/${input.resourceId}/profile/overview.v1.md`;
  if (kind === "dataset_source" && input.collectionId && SAFE_ID.test(input.collectionId) && input.filename && SAFE_FILENAME.test(input.filename)) return `datasets/${input.collectionId}/source/${input.filename}`;
  if (kind === "dataset_profile" && input.collectionId && SAFE_ID.test(input.collectionId)) return `datasets/${input.collectionId}/profile/dataset_profile.v1.json`;
  if (kind === "evaluation" && input.matchId && SAFE_ID.test(input.matchId)) return `discovery/${input.matchId}/evaluation.v1.json`;
  return null;
}

async function putKey(env: Env, key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, contentType: string): Promise<boolean> {
  if (!env.RESOURCE_BUCKET) return false;
  await env.RESOURCE_BUCKET.put(key, value, { httpMetadata: { contentType } });
  return true;
}

export async function getDiscoveryObject(env: Env, kind: DiscoveryObjectKind, input: Parameters<typeof discoveryObjectKey>[1]): Promise<R2ObjectBody | null> {
  const key = discoveryObjectKey(kind, input);
  return env.RESOURCE_BUCKET && key ? env.RESOURCE_BUCKET.get(key) : null;
}

export async function putDiscoveryObject(
  env: Env,
  kind: DiscoveryObjectKind,
  input: Parameters<typeof discoveryObjectKey>[1],
  value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  contentType: string,
): Promise<boolean> {
  const key = discoveryObjectKey(kind, input);
  return key ? putKey(env, key, value, contentType) : false;
}

export async function deleteDiscoveryObject(env: Env, kind: DiscoveryObjectKind, input: Parameters<typeof discoveryObjectKey>[1]): Promise<boolean> {
  const key = discoveryObjectKey(kind, input);
  if (!env.RESOURCE_BUCKET || !key) return false;
  await env.RESOURCE_BUCKET.delete(key);
  return true;
}
