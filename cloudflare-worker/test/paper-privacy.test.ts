import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import { analyzePaperImage } from "../src/tools";
import { createPaperProcessingAttempt, createPaperResource, linkPaperResource } from "../src/db";
import { handlePaperResourceApi } from "../src/paper-resources";
import { runPaperResourceCleanup } from "../src/paper-cleanup";
import { makeEnv } from "./fake-d1";

const ALICE: AuthedUser = { userId: "alice", email: "alice@example.com", sid: "sid-a" };
const BOB: AuthedUser = { userId: "bob", email: "bob@example.com", sid: "sid-b" };

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  failDeletes = false;

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer>; size: number; httpMetadata: { contentType: string } } | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: new Response(bytes).body!,
      arrayBuffer: async () => bytes.slice().buffer,
      size: bytes.byteLength,
      httpMetadata: { contentType: key.endsWith(".png") ? "image/png" : "application/json" },
    };
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("simulated R2 failure");
    this.objects.delete(key);
  }

  async list(options: { prefix?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> {
    const prefix = options.prefix ?? "";
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function readyImageResource(env: Env, db: ReturnType<typeof makeEnv>["db"], bucket: MemoryBucket, resourceId: string, sessionId: string, userId: string) {
  const resource = await createPaperResource(env, {
    resource_id: resourceId,
    session_id: sessionId,
    user_id: userId,
    source_kind: "arxiv",
    source_ref: "2401.00001",
    canonical_ref: "2401.00001",
    title: "Figure resource",
  });
  await linkPaperResource(env, sessionId, resourceId, userId, "read");
  const row = db.paperResources.get(resourceId)!;
  row.status = "ready";
  row.image_manifest_key = `paper/${resourceId}/images/manifest.json`;
  row.image_count = 1;
  const imageId = "page-0001-image-0001";
  bucket.objects.set(row.image_manifest_key, new TextEncoder().encode(JSON.stringify({ resource_id: resourceId, images: [{ image_id: imageId, page: 1, width: 100, height: 80, content_type: "image/png", size_bytes: 4, sha256: "a".repeat(64) }] })));
  bucket.objects.set(`paper/${resourceId}/images/page-0001/image-0001.png`, new Uint8Array([137, 80, 78, 71]));
  return row;
}

afterEach(() => vi.restoreAllMocks());

describe("Paper image privacy and delivery", () => {
  it("serves one manifest-selected image only to its owning session", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const row = await readyImageResource(env, db, bucket, "resource-image", "s1", "alice");

    const owner = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}/image?session_id=s1&image_id=page-0001-image-0001`), env, ALICE);
    expect(owner?.status).toBe(200);
    expect(owner?.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await owner!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect([...owner!.headers.keys()].some((key) => key.includes("key"))).toBe(false);

    db.seedChatSession("s2", "bob");
    const crossUser = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}/image?session_id=s2&image_id=page-0001-image-0001`), env, BOB);
    expect(crossUser?.status).toBe(404);
    const guessed = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}/image?session_id=s1&image_id=page-9999-image-0001`), env, ALICE);
    expect(guessed?.status).toBe(404);

    bucket.objects.set(`paper/${row.resource_id}/images/page-0001/image-0001.png`, new Uint8Array(8 * 1024 * 1024 + 1));
    const giant = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}/image?session_id=s1&image_id=page-0001-image-0001`), env, ALICE);
    expect(giant?.status).toBe(413);
  });
});

describe("Paper image analysis egress policy", () => {
  it("records bounded provider egress and provenance only when enabled", async () => {
    const { env, db } = makeEnv({
      PAPER_IMAGE_ANALYSIS_EGRESS: "enabled",
      MODEL_BASE_URL: "https://api.moonshot.cn/v1",
      MODEL_ID: "kimi-k2.6",
      MODEL_API_KEY: "kimi-test-key",
    });
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const row = await readyImageResource(env, db, bucket, "resource-analysis", "s1", "alice");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kimi-test-key");
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; messages?: Array<{ content?: Array<{ type?: string; image_url?: { url?: string } }> }> };
      expect(body.model).toBe("kimi-k2.6");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content).toEqual([
        { type: "text", text: "describe the trend" },
        { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) , detail: "high" } },
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "A figure with a plotted trend." } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = JSON.parse(await analyzePaperImage(env, "s1", "alice", row.resource_id, "page-0001-image-0001", "describe the trend", "high"));
    expect(result).toMatchObject({ mode: "image_analysis", status: "succeeded", resource_id: row.resource_id, image_id: "page-0001-image-0001", page: 1, provenance: { resource_id: row.resource_id, image_id: "page-0001-image-0001", page: 1 }, text: "A figure with a plotted trend." });
    expect(db.paperAuditEvents).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "image_analysis", outcome: "succeeded", resource_id: row.resource_id })]));
  });

  it("denies egress by policy and never calls the provider", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const row = await readyImageResource(env, db, bucket, "resource-denied", "s1", "alice");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = JSON.parse(await analyzePaperImage(env, "s1", "alice", row.resource_id, "page-0001-image-0001", "describe", "low"));
    expect(result).toMatchObject({ error: "paper_image_egress_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.paperAuditEvents).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "image_analysis", outcome: "denied", error_code: "PAPER_IMAGE_EGRESS_DENIED" })]));
  });
});

describe("Paper resource deletion and cancellation", () => {
  it("revokes image access, schedules cleanup, and deletes processing resources safely", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const ready = await readyImageResource(env, db, bucket, "resource-delete", "s1", "alice");
    const deleted = await handlePaperResourceApi(request(`/api/paper/resources/${ready.resource_id}?session_id=s1`, { method: "DELETE" }), env, ALICE);
    expect(deleted?.status).toBe(200);
    expect(db.paperResources.get(ready.resource_id)?.status).toBe("deleted");
    expect(db.paperCleanupJobs.get(ready.resource_id)).toMatchObject({ status: "pending" });
    const afterDelete = await handlePaperResourceApi(request(`/api/paper/resources/${ready.resource_id}/image?session_id=s1&image_id=page-0001-image-0001`), env, ALICE);
    expect(afterDelete?.status).toBe(410);

    const processing = await readyImageResource(env, db, bucket, "resource-processing-delete", "s1", "alice");
    processing.status = "downloading";
    const attempt = await createPaperProcessingAttempt(env, { attempt_id: "attempt-delete", resource_id: processing.resource_id, processor_id: "processor-1", lease_token_hash: "b".repeat(64), fencing_epoch: 1, lease_expires_at: Math.floor(Date.now() / 1000) + 300 });
    const processingDelete = await handlePaperResourceApi(request(`/api/paper/resources/${processing.resource_id}?session_id=s1`, { method: "DELETE" }), env, ALICE);
    expect(processingDelete?.status).toBe(200);
    expect(db.paperResources.get(processing.resource_id)?.status).toBe("deleted");
    expect(db.paperProcessingAttempts.get(attempt.attempt_id)?.status).toBe("cancelled");
    expect(db.paperCleanupJobs.get(processing.resource_id)).toMatchObject({ status: "pending" });

    const cancellable = await readyImageResource(env, db, bucket, "resource-cancel-route", "s1", "alice");
    cancellable.status = "downloading";
    const cancelAttempt = await createPaperProcessingAttempt(env, { attempt_id: "attempt-cancel-route", resource_id: cancellable.resource_id, processor_id: "processor-2", lease_token_hash: "c".repeat(64), fencing_epoch: 1, lease_expires_at: Math.floor(Date.now() / 1000) + 300 });
    const cancelled = await handlePaperResourceApi(request(`/api/paper/resources/${cancellable.resource_id}/cancel?session_id=s1`, { method: "POST" }), env, ALICE);
    expect(cancelled?.status).toBe(200);
    expect(db.paperResources.get(cancellable.resource_id)?.status).toBe("cancelled");
    expect(db.paperProcessingAttempts.get(cancelAttempt.attempt_id)?.status).toBe("cancelled");

    expect(await runPaperResourceCleanup(env, Math.floor(Date.now() / 1000))).toBe(2);
    expect([...bucket.objects.keys()].some((key) => key.startsWith(`paper/${ready.resource_id}/`))).toBe(false);
    expect([...bucket.objects.keys()].some((key) => key.startsWith(`paper/${processing.resource_id}/`))).toBe(false);
    expect(await runPaperResourceCleanup(env, Math.floor(Date.now() / 1000))).toBe(0);
  });

  it("keeps an R2 cleanup orphan retryable after a transient failure", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const row = await readyImageResource(env, db, bucket, "resource-retry-cleanup", "s1", "alice");
    const deleted = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}?session_id=s1`, { method: "DELETE" }), env, ALICE);
    expect(deleted?.status).toBe(200);
    bucket.failDeletes = true;
    const now = Math.floor(Date.now() / 1000);
    expect(await runPaperResourceCleanup(env, now)).toBe(0);
    expect(db.paperCleanupJobs.get(row.resource_id)).toMatchObject({ status: "failed", last_error_code: "PAPER_CLEANUP_FAILED" });
    bucket.failDeletes = false;
    db.paperCleanupJobs.get(row.resource_id)!.next_attempt_at = now;
    expect(await runPaperResourceCleanup(env, now)).toBe(1);
    expect(db.paperCleanupJobs.get(row.resource_id)?.status).toBe("completed");

    const stale = await readyImageResource(env, db, bucket, "resource-stale-cleanup", "s1", "alice");
    const staleDelete = await handlePaperResourceApi(request(`/api/paper/resources/${stale.resource_id}?session_id=s1`, { method: "DELETE" }), env, ALICE);
    expect(staleDelete?.status).toBe(200);
    const staleJob = db.paperCleanupJobs.get(stale.resource_id)!;
    staleJob.status = "running";
    staleJob.updated_at = now - 301;
    expect(await runPaperResourceCleanup(env, now)).toBe(1);
    expect(db.paperCleanupJobs.get(stale.resource_id)?.status).toBe("completed");
  });
});
