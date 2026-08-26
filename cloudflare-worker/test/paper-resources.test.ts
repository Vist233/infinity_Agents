import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import {
  createPaperProcessingAttempt,
  createPaperResource,
  getOwnedPaperResource,
  revokePaperResourceLink,
  transitionPaperResource,
} from "../src/db";
import { handlePaperResourceApi } from "../src/paper-resources";
import { Sha256 } from "../src/sha256";
import { makeEnv } from "./fake-d1";

const ALICE: AuthedUser = { userId: "alice", email: "alice@example.com", sid: "sid-a" };
const BOB: AuthedUser = { userId: "bob", email: "bob@example.com", sid: "sid-b" };

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async put(key: string, value: string | Uint8Array): Promise<void> {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return { arrayBuffer: async () => value.slice().buffer };
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function createResource(env: Env, user: AuthedUser, sessionId: string) {
  const response = await handlePaperResourceApi(
    request("/api/paper/resources", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, source_kind: "arxiv", source_ref: "2401.00001", title: "Paper" }),
    }),
    env,
    user,
  );
  expect(response?.status).toBe(201);
  return await response!.json() as { resource_id: string; status: string };
}

describe("Paper resource metadata and object interface", () => {
  it("rejects the inactive approved_url source at the entry point before D1 resource creation", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const response = await handlePaperResourceApi(
      request("/api/paper/resources", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          source_kind: "approved_url",
          source_ref: "https://example.test/paper.pdf",
        }),
      }),
      env,
      ALICE,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: { message: "approved_url is not enabled in this release", code: "PAPER_APPROVED_URL_DISABLED" },
    });
    expect(db.paperResources).toHaveLength(0);
    expect(db.paperResourceLinks.size).toBe(0);
  });

  it("creates and reads a pending owned resource with a session link", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const created = await createResource(env, ALICE, "s1");
    expect(created.status).toBe("requested");
    expect(db.paperResourceLinks.size).toBe(1);

    const response = await handlePaperResourceApi(request(`/api/paper/resources/${created.resource_id}?session_id=s1`), env, ALICE);
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ resource_id: created.resource_id, status: "requested", source_kind: "arxiv" });
    expect(body).not.toHaveProperty("pdf_object_key");
    expect(body).not.toHaveProperty("text_manifest_key");
  });

  it("serves a ready manifest through the fixed object abstraction", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const created = await createResource(env, ALICE, "s1");
    const row = db.paperResources.get(created.resource_id)!;
    await transitionPaperResource(env, { resourceId: row.resource_id, expectedStatus: "requested", nextStatus: "downloading" });
    await transitionPaperResource(env, { resourceId: row.resource_id, expectedStatus: "downloading", nextStatus: "extracting" });
    await transitionPaperResource(env, { resourceId: row.resource_id, expectedStatus: "extracting", nextStatus: "uploading" });
    row.text_manifest_key = `paper/${row.resource_id}/text/manifest.json`;
    await bucket.put(row.text_manifest_key, JSON.stringify({ resource_id: row.resource_id, page_count: 2, object_key: "must-not-leak" }));
    await transitionPaperResource(env, { resourceId: row.resource_id, expectedStatus: "uploading", nextStatus: "ready" });

    const response = await handlePaperResourceApi(request(`/api/paper/resources/${row.resource_id}/manifest?session_id=s1`), env, ALICE);
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ resource_id: row.resource_id, page_count: 2 });
    expect(body).not.toHaveProperty("object_key");
  });

  it("rejects cross-user and guessed resource reads", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const created = await createResource(env, ALICE, "s1");
    db.seedChatSession("s2", "bob");
    const crossUser = await handlePaperResourceApi(request(`/api/paper/resources/${created.resource_id}?session_id=s2`), env, BOB);
    const guessed = await handlePaperResourceApi(request("/api/paper/resources/not-a-real-resource?session_id=s2"), env, BOB);
    expect(crossUser?.status).toBe(404);
    expect(guessed?.status).toBe(404);
  });

  it("fences stale processing attempts and rejects an invalid state jump", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const created = await createResource(env, ALICE, "s1");
    const attempt = await createPaperProcessingAttempt(env, {
      attempt_id: "attempt-1", resource_id: created.resource_id, processor_id: "processor-1", lease_token_hash: "a".repeat(64), fencing_epoch: 1, lease_expires_at: 10,
    });
    expect(attempt.status).toBe("claimed");
    await expect(transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "requested", nextStatus: "ready" })).resolves.toBe(false);
    await expect(transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "requested", nextStatus: "downloading", attemptId: "attempt-1", fencingEpoch: 1, now: 20 })).resolves.toBe(false);
    expect(db.paperResources.get(created.resource_id)?.status).toBe("requested");
  });

  it("rejects object-key traversal, deleted resources, and revoked links", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const created = await createResource(env, ALICE, "s1");
    const traversal = await handlePaperResourceApi(request(`/api/paper/resources/${created.resource_id}/object?session_id=s1&kind=../../secret`), env, ALICE);
    expect(traversal?.status).toBe(400);

    expect(await transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "requested", nextStatus: "downloading" })).toBe(true);
    expect(await transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "downloading", nextStatus: "extracting" })).toBe(true);
    expect(await transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "extracting", nextStatus: "uploading" })).toBe(true);
    expect(await transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "uploading", nextStatus: "ready" })).toBe(true);
    expect(await transitionPaperResource(env, { resourceId: created.resource_id, expectedStatus: "ready", nextStatus: "deleted" })).toBe(true);
    const deleted = await handlePaperResourceApi(request(`/api/paper/resources/${created.resource_id}?session_id=s1`), env, ALICE);
    expect(deleted?.status).toBe(410);

    const second = await createResource(env, ALICE, "s1");
    expect(await revokePaperResourceLink(env, "s1", second.resource_id, "alice")).toBe(true);
    const revoked = await getOwnedPaperResource(env, second.resource_id, "s1", "alice");
    expect(revoked).toBeNull();
  });

  it("accepts a bounded private PDF upload only for its owned pending resource", async () => {
    const { env, db } = makeEnv();
    const bucket = new MemoryBucket();
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const create = await handlePaperResourceApi(request("/api/paper/resources", { method: "POST", body: JSON.stringify({ session_id: "s1", source_kind: "user_upload", source_ref: "upload-1", purpose: "upload" }) }), env, ALICE);
    expect(create?.status).toBe(201);
    const resourceId = (await create!.json() as { resource_id: string }).resource_id;
    const pdf = new TextEncoder().encode("%PDF-1.7\nprivate fixture\n");
    const upload = await handlePaperResourceApi(request(`/api/paper/resources/${resourceId}/object?session_id=s1&kind=source_pdf`, { method: "PUT", headers: { "content-type": "application/pdf", "x-paper-object-sha256": new Sha256().update(pdf).digestHex() }, body: pdf }), env, ALICE);
    expect(upload?.status).toBe(200);
    expect(db.paperResources.get(resourceId)).toMatchObject({ source_kind: "user_upload", pdf_object_key: `paper/${resourceId}/source.pdf`, pdf_size_bytes: pdf.byteLength });
    const duplicate = await handlePaperResourceApi(request(`/api/paper/resources/${resourceId}/object?session_id=s1&kind=source_pdf`, { method: "PUT", body: pdf }), env, ALICE);
    expect(duplicate?.status).toBe(409);
  });
});
