import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import { createPaperResource, linkPaperResource } from "../src/db";
import { handlePaperProcessorApi } from "../src/paper-processor";
import { isPaperProcessorNamespacePath, isPaperProcessorProtocolRoute } from "../src/paper-processor-access";
import { Sha256 } from "../src/sha256";
import { makeEnv } from "./fake-d1";

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpMetadata: { contentType: string } }> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("object not found");
    return {
      body: new Response(bytes).body!,
      httpMetadata: { contentType: "application/json" },
    };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream): Promise<void> {
    if (value instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = value.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.byteLength; }
      this.objects.set(key, total);
      return;
    }
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10", ...(init.headers ?? {}) },
  });
}

async function connect(env: Env, instanceId: string) {
  const response = await handlePaperProcessorApi(request("/api/paper-processor/connect", {
    method: "POST",
    headers: { "x-paper-processor-id": "processor-1", "x-paper-processor-token": "bootstrap-secret" },
    body: JSON.stringify({ instance_id: instanceId }),
  }), env);
  expect(response?.status).toBe(200);
  return await response!.json() as { processor_session_id: string; processor_session_token: string };
}

function processorHeaders(sessionToken: string, leaseToken?: string): HeadersInit {
  return {
    "x-paper-processor-session": sessionToken,
    ...(leaseToken ? { "x-paper-processor-lease-token": leaseToken } : {}),
  };
}

function controlRequest(sessionToken: string, operation: string, fields: Record<string, unknown> = {}, leaseToken?: string): Request {
  return request("/api/paper-processor/control", {
    method: "POST",
    headers: processorHeaders(sessionToken, leaseToken),
    body: JSON.stringify({ operation, ...fields }),
  });
}

function uploadRequest(sessionToken: string, leaseToken: string, attemptId: string, resourceId: string, fencingEpoch: number, kind: string, body: Uint8Array, objectId?: string, contentType = "application/json"): Request {
  const envelope = { operation: "upload", attempt_id: attemptId, resource_id: resourceId, fencing_epoch: fencingEpoch, kind, ...(objectId === undefined ? {} : { object_id: objectId }) };
  return request("/api/paper-processor/object", {
    method: "PUT",
    headers: {
      ...processorHeaders(sessionToken, leaseToken),
      "content-type": contentType,
      "x-paper-processor-envelope": JSON.stringify(envelope),
      "x-paper-object-sha256": new Sha256().update(body).digestHex(),
    },
    body,
  });
}

describe("dedicated Paper Processor control protocol", () => {
  it("connects, claims one resource, renews, uploads, and finalizes exactly once", async () => {
    const bucket = new MemoryBucket();
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const resource = await createPaperResource(env, { resource_id: "resource-1", session_id: "s1", user_id: "alice", source_kind: "arxiv", source_ref: "2401.00001", canonical_ref: "2401.00001", title: "Paper" });
    await linkPaperResource(env, "s1", resource.resource_id, "alice", "read");

    const session = await connect(env, "instance-1");
    const poll = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(session.processor_session_token), body: "{}" }), env);
    expect(poll?.status).toBe(200);
    const grant = await poll!.json() as { resource_id: string; attempt_id: string; lease_token: string; fencing_epoch: number; lease_expires_at: number };
    expect(grant).toMatchObject({ resource_id: "resource-1", attempt_id: expect.any(String), lease_token: expect.any(String), fencing_epoch: 1 });
    expect(grant).not.toHaveProperty("r2_key");

    const input = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "input", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: grant.fencing_epoch }, grant.lease_token), env);
    expect(input?.status).toBe(200);
    expect(await input!.json()).toMatchObject({ resource_id: "resource-1", source_kind: "arxiv", source_ref: "2401.00001" });

    expect((await handlePaperProcessorApi(controlRequest(session.processor_session_token, "stage", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: 1, stage: "extracting" }, grant.lease_token), env))?.status).toBe(200);
    expect((await handlePaperProcessorApi(controlRequest(session.processor_session_token, "stage", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: 1, stage: "uploading" }, grant.lease_token), env))?.status).toBe(200);

    const textPages = new TextEncoder().encode('{"page":1,"text":"text"}\n');
    const textPagesUpload = await handlePaperProcessorApi(uploadRequest(session.processor_session_token, grant.lease_token, grant.attempt_id, "resource-1", 1, "text_pages", textPages, "pages"), env);
    expect(textPagesUpload?.status).toBe(200);
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const imageUpload = await handlePaperProcessorApi(uploadRequest(session.processor_session_token, grant.lease_token, grant.attempt_id, "resource-1", 1, "image", imageBytes, "page-0001-image-0001", "image/png"), env);
    expect(imageUpload?.status).toBe(200);
    expect(bucket.objects.has("paper/resource-1/text/pages.jsonl")).toBe(true);
    expect(bucket.objects.has("paper/resource-1/images/page-0001/image-0001.png")).toBe(true);
    const manifest = { resource_id: "resource-1", parser_version: "paper-processor-test", page_count: 1, pages: [{ page: 1, text_bytes: 4, images: ["page-0001-image-0001"] }], images: [{ image_id: "page-0001-image-0001", page: 1 }] };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const upload = await handlePaperProcessorApi(uploadRequest(session.processor_session_token, grant.lease_token, grant.attempt_id, "resource-1", 1, "text_manifest", manifestBytes), env);
    expect(upload?.status).toBe(200);
    const renewed = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "renew", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: 1 }, grant.lease_token), env);
    expect(renewed?.status).toBe(200);

    const finalize = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "finalize", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: 1, manifest }, grant.lease_token), env);
    expect(finalize?.status).toBe(200);
    expect(await finalize!.json()).toMatchObject({ resource_id: "resource-1", status: "ready" });
    expect(db.paperResources.get("resource-1")?.status).toBe("ready");
    expect(db.paperAuditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_id: "resource-1", stage: "extraction", outcome: "started" }),
      expect.objectContaining({ resource_id: "resource-1", stage: "upload", outcome: "started" }),
      expect.objectContaining({ resource_id: "resource-1", stage: "upload", outcome: "succeeded" }),
    ]));
    const duplicate = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "finalize", { attempt_id: grant.attempt_id, resource_id: "resource-1", fencing_epoch: 1, manifest }, grant.lease_token), env);
    expect(duplicate?.status).toBe(409);
  });

  it("rejects a second claim, stale renewal, resource/attempt swaps, cancellation, and broad listing", async () => {
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    db.seedChatSession("s1", "alice");
    for (const id of ["resource-1", "resource-2"]) {
      const resource = await createPaperResource(env, { resource_id: id, session_id: "s1", user_id: "alice", source_kind: "arxiv", source_ref: id, canonical_ref: id, title: id });
      await linkPaperResource(env, "s1", resource.resource_id, "alice", "read");
    }
    const firstSession = await connect(env, "instance-1");
    const firstPoll = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(firstSession.processor_session_token), body: "{}" }), env);
    const firstGrant = await firstPoll!.json() as { attempt_id: string; resource_id: string; lease_token: string; fencing_epoch: number };
    const secondSession = await connect(env, "instance-2");
    const secondPoll = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(secondSession.processor_session_token), body: "{}" }), env);
    expect(await secondPoll!.json()).toEqual({ resource: null });

    const swappedInput = await handlePaperProcessorApi(controlRequest(firstSession.processor_session_token, "input", { attempt_id: firstGrant.attempt_id, resource_id: "resource-2", fencing_epoch: 1 }, firstGrant.lease_token), env);
    expect(swappedInput?.status).toBe(409);
    const wrongAttempt = await handlePaperProcessorApi(controlRequest(firstSession.processor_session_token, "renew", { attempt_id: "not-the-attempt", resource_id: firstGrant.resource_id, fencing_epoch: 1 }, firstGrant.lease_token), env);
    expect(wrongAttempt?.status).toBe(409);

    db.paperProcessingAttempts.get(firstGrant.attempt_id)!.lease_expires_at = 1;
    const stale = await handlePaperProcessorApi(controlRequest(firstSession.processor_session_token, "renew", { attempt_id: firstGrant.attempt_id, resource_id: firstGrant.resource_id, fencing_epoch: 1 }, firstGrant.lease_token), env);
    expect(stale?.status).toBe(409);

    const cancelled = await handlePaperProcessorApi(controlRequest(firstSession.processor_session_token, "cancel", { attempt_id: firstGrant.attempt_id, resource_id: firstGrant.resource_id, fencing_epoch: 1 }, firstGrant.lease_token), env);
    expect(cancelled?.status).toBe(409);
    const broad = await handlePaperProcessorApi(request("/api/paper-processor/resources", { method: "GET", headers: processorHeaders(firstSession.processor_session_token) }), env);
    expect(broad?.status).toBe(403);
    expect(await broad!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_SOURCE_FORBIDDEN" } });
  });

  it("cancels an active attempt once and rejects the expired session after restart", async () => {
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    db.seedChatSession("s1", "alice");
    const resource = await createPaperResource(env, { resource_id: "resource-cancel", session_id: "s1", user_id: "alice", source_kind: "arxiv", source_ref: "cancel-me", canonical_ref: "cancel-me", title: "Cancel" });
    await linkPaperResource(env, "s1", resource.resource_id, "alice", "read");
    const session = await connect(env, "instance-cancel");
    const polled = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(session.processor_session_token), body: "{}" }), env);
    const grant = await polled!.json() as { attempt_id: string; resource_id: string; lease_token: string; fencing_epoch: number };
    const cancelled = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "cancel", { attempt_id: grant.attempt_id, resource_id: grant.resource_id, fencing_epoch: grant.fencing_epoch }, grant.lease_token), env);
    expect(cancelled?.status).toBe(200);
    expect(db.paperResources.get(grant.resource_id)?.status).toBe("cancelled");
    const duplicate = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "cancel", { attempt_id: grant.attempt_id, resource_id: grant.resource_id, fencing_epoch: grant.fencing_epoch }, grant.lease_token), env);
    expect(duplicate?.status).toBe(409);
    const sessionRow = [...db.paperProcessorSessions.values()][0];
    sessionRow.expires_at = 1;
    const expired = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(session.processor_session_token), body: "{}" }), env);
    expect(expired?.status).toBe(401);
  });

  it("serves a private uploaded source only through the exact leased attempt", async () => {
    const bucket = new MemoryBucket();
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
    db.seedChatSession("s1", "alice");
    const resource = await createPaperResource(env, { resource_id: "resource-upload", session_id: "s1", user_id: "alice", source_kind: "user_upload", source_ref: "upload-1", canonical_ref: null, title: "Private" });
    await linkPaperResource(env, "s1", resource.resource_id, "alice", "upload");
    db.paperResources.get(resource.resource_id)!.pdf_object_key = `paper/${resource.resource_id}/source.pdf`;
    const source = new TextEncoder().encode("%PDF-1.7\nprivate source\n");
    bucket.objects.set(`paper/${resource.resource_id}/source.pdf`, source);
    const session = await connect(env, "instance-upload");
    const poll = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(session.processor_session_token), body: "{}" }), env);
    const grant = await poll!.json() as { resource_id: string; attempt_id: string; lease_token: string; fencing_epoch: number };
    const response = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "input_source", { attempt_id: grant.attempt_id, resource_id: grant.resource_id, fencing_epoch: grant.fencing_epoch }, grant.lease_token), env);
    expect(response?.status).toBe(200);
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(source);
  });

  it("does not accept a public Worker credential at Processor routes", async () => {
    const { env } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    const response = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: { "x-worker-credential": "public-worker-secret" }, body: "{}" }), env);
    expect(response?.status).toBe(401);
  });

  it("records a safe failure stage and prevents readiness", async () => {
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    db.seedChatSession("s1", "alice");
    const resource = await createPaperResource(env, { resource_id: "resource-fail", session_id: "s1", user_id: "alice", source_kind: "arxiv", source_ref: "2401.00002", canonical_ref: "2401.00002", title: "Bad PDF" });
    await linkPaperResource(env, "s1", resource.resource_id, "alice", "read");
    const session = await connect(env, "instance-fail");
    const poll = await handlePaperProcessorApi(request("/api/paper-processor/poll", { method: "POST", headers: processorHeaders(session.processor_session_token), body: "{}" }), env);
    const grant = await poll!.json() as { attempt_id: string; resource_id: string; fencing_epoch: number; lease_token: string };
    const failed = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "fail", { attempt_id: grant.attempt_id, resource_id: grant.resource_id, fencing_epoch: grant.fencing_epoch, error_code: "MALFORMED_PDF", error_message: "safe parser failure" }, grant.lease_token), env);
    expect(failed?.status).toBe(200);
    expect(db.paperResources.get(resource.resource_id)?.status).toBe("failed");
    expect(db.paperAuditEvents).toEqual(expect.arrayContaining([expect.objectContaining({ resource_id: resource.resource_id, stage: "download", outcome: "failed", error_code: "MALFORMED_PDF" })]));
    const duplicate = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "fail", { attempt_id: grant.attempt_id, resource_id: grant.resource_id, fencing_epoch: grant.fencing_epoch, error_code: "MALFORMED_PDF" }, grant.lease_token), env);
    expect(duplicate?.status).toBe(409);
  });

  it("fails closed for a non-zhangbot source, wrong bootstrap secret, and non-Processor path", async () => {
    const { env, db } = makeEnv({ PAPER_PROCESSOR_ID: "processor-1", PAPER_PROCESSOR_SOURCE_IP: "203.0.113.10", PAPER_PROCESSOR_SHARED_SECRET: "bootstrap-secret" });
    const wrongSource = await handlePaperProcessorApi(request("/api/paper-processor/connect", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.20", "x-paper-processor-id": "processor-1", "x-paper-processor-token": "bootstrap-secret" },
      body: JSON.stringify({ instance_id: "foreign-source" }),
    }), env);
    expect(wrongSource?.status).toBe(403);
    expect(await wrongSource!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_SOURCE_FORBIDDEN" } });
    expect(db.paperProcessorSessions.size).toBe(0);

    const missingSecret = await handlePaperProcessorApi(request("/api/paper-processor/connect", {
      method: "POST",
      headers: { "x-paper-processor-id": "processor-1" },
      body: JSON.stringify({ instance_id: "missing-secret" }),
    }), env);
    expect(missingSecret?.status).toBe(401);
    expect(await missingSecret!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_UNAUTHENTICATED" } });

    const wrongSecret = await handlePaperProcessorApi(request("/api/paper-processor/connect", {
      method: "POST",
      headers: { "x-paper-processor-id": "processor-1", "x-paper-processor-token": "wrong-bootstrap-secret" },
      body: JSON.stringify({ instance_id: "wrong-secret" }),
    }), env);
    expect(wrongSecret?.status).toBe(401);
    expect(await wrongSecret!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_UNAUTHENTICATED" } });
    expect(db.paperProcessorSessions.size).toBe(0);

    expect(isPaperProcessorNamespacePath("/api/papers/search")).toBe(false);
    expect(isPaperProcessorProtocolRoute("POST", "/api/paper-processor/connect")).toBe(true);
    expect(isPaperProcessorProtocolRoute("POST", "/api/paper-processor/poll")).toBe(true);
    expect(isPaperProcessorProtocolRoute("POST", "/api/paper-processor/control")).toBe(true);
    expect(isPaperProcessorProtocolRoute("PUT", "/api/paper-processor/object")).toBe(true);
    expect(isPaperProcessorProtocolRoute("POST", "/api/paper-processor/connect/extra")).toBe(false);
    expect(isPaperProcessorProtocolRoute("GET", "/api/paper-processor/attempts/a/input")).toBe(false);
    expect(isPaperProcessorProtocolRoute("POST", "/api/paper-processor/attempts/a/objects/text_manifest")).toBe(false);

    const session = await connect(env, "fixed-endpoint-negative");
    const wrongMethod = await handlePaperProcessorApi(request("/api/paper-processor/control", {
      method: "GET",
      headers: processorHeaders(session.processor_session_token),
    }), env);
    expect(wrongMethod?.status).toBe(403);
    expect(await wrongMethod!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_SOURCE_FORBIDDEN" } });

    const unknownOperation = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "unknown", { attempt_id: "attempt-1", resource_id: "resource-1", fencing_epoch: 1 }, "lease-token-long-enough"), env);
    expect(unknownOperation?.status).toBe(400);
    expect(await unknownOperation!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_OPERATION_NOT_ALLOWED" } });

    const extraControlField = await handlePaperProcessorApi(controlRequest(session.processor_session_token, "cancel", { attempt_id: "attempt-1", resource_id: "resource-1", fencing_epoch: 1, r2_key: "caller-selected" }, "lease-token-long-enough"), env);
    expect(extraControlField?.status).toBe(400);
    expect(await extraControlField!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_OPERATION_FIELDS_FORBIDDEN" } });
    expect(db.paperProcessorSessions.size).toBe(1);

    const retiredDynamicPath = await handlePaperProcessorApi(request("/api/paper-processor/attempts/attempt-1/renew", {
      method: "POST",
      headers: processorHeaders(session.processor_session_token, "lease-token-long-enough"),
      body: JSON.stringify({ resource_id: "resource-1", fencing_epoch: 1 }),
    }), env);
    expect(retiredDynamicPath?.status).toBe(403);
    expect(await retiredDynamicPath!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_SOURCE_FORBIDDEN" } });

    const unknownUpload = await handlePaperProcessorApi(request("/api/paper-processor/object", {
      method: "PUT",
      headers: {
        ...processorHeaders(session.processor_session_token, "lease-token-long-enough"),
        "x-paper-processor-envelope": JSON.stringify({ operation: "delete", attempt_id: "attempt-1", resource_id: "resource-1", fencing_epoch: 1, kind: "source_pdf" }),
        "x-paper-object-sha256": "0".repeat(64),
      },
      body: new Uint8Array([1]),
    }), env);
    expect(unknownUpload?.status).toBe(400);
    expect(await unknownUpload!.json()).toMatchObject({ error: { code: "PAPER_PROCESSOR_OPERATION_NOT_ALLOWED" } });
  });
});
