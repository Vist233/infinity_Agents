import type { Env } from "./env";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SAFE_SHA256 = /^[0-9a-f]{64}$/i;
const DISCOVERY_OBJECT_KEY = /^(?:paper\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/profile\/(?:paper_profile\.v1\.json|overview\.v1\.md)|datasets\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/(?:source\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}|profile\/dataset_profile\.v1\.json)|discovery\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/(?:evaluation\.v1\.json|method\.v1\.md|method-[0-9a-f]{64}\.md))$/i;
const STAGED_DISCOVERY_OBJECT_KEY = /^discovery\/staging\/(?:paper-profile|paper-overview|dataset-profile|evaluation)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/epoch-\d+\/(?:paper-profile\.v1\.json|paper-overview\.v1\.md|dataset-profile\.v1\.json|evaluation\.v1\.json)$/;

export type DiscoveryObjectKind = "paper_profile" | "paper_overview" | "dataset_source" | "dataset_profile" | "evaluation" | "method_materialized";

/** Return a bounded filename suitable for a server-generated dataset key. */
export function safeDiscoveryFilename(value: string, fallback = "data.bin"): string {
  const basename = value.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const normalized = basename.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 255);
  return SAFE_FILENAME.test(normalized) ? normalized : fallback;
}

export function discoveryObjectKey(kind: DiscoveryObjectKind, input: { resourceId?: string; collectionId?: string; matchId?: string; filename?: string; leaseOwner?: string; fencingEpoch?: number; contentSha256?: string }): string | null {
  const epoch = input.fencingEpoch;
  const stagedEpoch = typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
  if (input.leaseOwner && SAFE_ID.test(input.leaseOwner) && stagedEpoch !== null) {
    const target = kind === "paper_profile" || kind === "paper_overview" ? input.resourceId : kind === "dataset_profile" ? input.collectionId : kind === "evaluation" ? input.matchId : null;
    if (!target || !SAFE_ID.test(target)) return null;
    const name = kind === "paper_profile" ? "paper-profile" : kind === "paper_overview" ? "paper-overview" : kind === "dataset_profile" ? "dataset-profile" : kind === "evaluation" ? "evaluation" : null;
    if (!name) return null;
    const prefix = `discovery/staging/${name}/${target}/${input.leaseOwner}/epoch-${stagedEpoch}`;
    if (kind === "paper_profile") return `${prefix}/paper-profile.v1.json`;
    if (kind === "paper_overview") return `${prefix}/paper-overview.v1.md`;
    if (kind === "dataset_profile") return `${prefix}/dataset-profile.v1.json`;
    if (kind === "evaluation") return `${prefix}/evaluation.v1.json`;
    return null;
  }
  if (kind === "paper_profile" && input.resourceId && SAFE_ID.test(input.resourceId)) return `paper/${input.resourceId}/profile/paper_profile.v1.json`;
  if (kind === "paper_overview" && input.resourceId && SAFE_ID.test(input.resourceId)) return `paper/${input.resourceId}/profile/overview.v1.md`;
  if (kind === "dataset_source" && input.collectionId && SAFE_ID.test(input.collectionId) && input.filename && SAFE_FILENAME.test(input.filename)) return `datasets/${input.collectionId}/source/${input.filename}`;
  if (kind === "dataset_profile" && input.collectionId && SAFE_ID.test(input.collectionId)) return `datasets/${input.collectionId}/profile/dataset_profile.v1.json`;
  if (kind === "evaluation" && input.matchId && SAFE_ID.test(input.matchId)) return `discovery/${input.matchId}/evaluation.v1.json`;
  if (kind === "method_materialized" && input.matchId && SAFE_ID.test(input.matchId)) {
    return input.contentSha256 && SAFE_SHA256.test(input.contentSha256)
      ? `discovery/${input.matchId}/method-${input.contentSha256.toLowerCase()}.md`
      : `discovery/${input.matchId}/method.v1.md`;
  }
  return null;
}

function isSafeDiscoveryObjectKey(key: string): boolean {
  return DISCOVERY_OBJECT_KEY.test(key) || STAGED_DISCOVERY_OBJECT_KEY.test(key);
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

/** Read a D1-published Discovery object pointer without accepting a caller key. */
export async function getDiscoveryObjectAtKey(env: Env, key: string | null | undefined): Promise<R2ObjectBody | null> {
  if (!env.RESOURCE_BUCKET || !key || !isSafeDiscoveryObjectKey(key)) return null;
  return env.RESOURCE_BUCKET.get(key);
}

/** Delete a server-persisted Discovery pointer without accepting an arbitrary key. */
export async function deleteDiscoveryObjectAtKey(env: Env, key: string | null | undefined): Promise<boolean> {
  if (!env.RESOURCE_BUCKET || !key || !isSafeDiscoveryObjectKey(key)) return false;
  await env.RESOURCE_BUCKET.delete(key);
  return true;
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
