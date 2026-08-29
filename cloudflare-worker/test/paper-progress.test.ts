import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import {
  createPaperRequestContinuation,
  recordPaperAuditEvent,
  revokePaperResourceLink,
} from "../src/db";
import { handlePaperContinuation } from "../src/chat";
import { handlePaperResourceApi } from "../src/paper-resources";
import { makeEnv } from "./fake-d1";

const ALICE: AuthedUser = { userId: "alice", email: "alice@example.com", sid: "sid-a" };
const BOB: AuthedUser = { userId: "bob", email: "bob@example.com", sid: "sid-b" };

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function createResource(env: Env, user: AuthedUser, sessionId: string): Promise<string> {
  const response = await handlePaperResourceApi(
    request("/api/paper/resources", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, source_kind: "arxiv", source_ref: "2401.00001", title: "Paper" }),
    }),
    env,
    user,
  );
  expect(response?.status).toBe(201);
  return String((await response!.json() as { resource_id: string }).resource_id);
}

async function addContinuationAndMaterializeEvent(env: Env, resourceId: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const continuation = await createPaperRequestContinuation(env, {
    continuationId: "continuation-progress-1",
    sessionId: "s1",
    userId: "alice",
    turnId: "client:paper-progress-1",
    clientRequestId: "paper-progress-1",
    resource: { resource_id: resourceId, status: "requested" },
    now,
  });
  expect(await recordPaperAuditEvent(env, {
    event_id: "materialize-event-1",
    resource_id: resourceId,
    attempt_id: null,
    stage: "materialize",
    outcome: "succeeded",
    error_code: null,
    metadata_json: "{}",
    created_at: now,
  })).toBe(true);
  return continuation.continuation_id;
}

async function readProgress(env: Env, user: AuthedUser, resourceId: string, sessionId: string): Promise<Response> {
  return (await handlePaperResourceApi(
    request(`/api/paper/resources/${resourceId}/progress?session_id=${encodeURIComponent(sessionId)}`),
    env,
    user,
  ))!;
}

describe("PAPER-FIX-02 paper progress read model", () => {
  it("keeps materialize invocation success distinct from a resource that is still processing", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resourceId = await createResource(env, ALICE, "s1");
    const continuationId = await addContinuationAndMaterializeEvent(env, resourceId);

    const response = await readProgress(env, ALICE, resourceId, "s1");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      resource: { resource_id: resourceId, status: "requested", stage: "requested", page_count: null, image_count: null },
      materialize: { invocation_status: "succeeded", resource_ready: false, invocation_event_id: "materialize-event-1" },
      correlation: { continuations: [{ continuation_id: continuationId, original_turn_id: "client:paper-progress-1", status: "waiting" }] },
      resume: { available: false, reason_code: "PAPER_RESOURCE_NOT_READY" },
    });
    expect(body).not.toHaveProperty("pdf_object_key");
    expect(body).not.toHaveProperty("text_manifest_key");
    expect(body).not.toHaveProperty("metadata_json");
    expect(body).not.toHaveProperty("source_ref");
  });

  it("returns a refresh-stable ready snapshot and a bounded continuation action", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resourceId = await createResource(env, ALICE, "s1");
    const continuationId = await addContinuationAndMaterializeEvent(env, resourceId);
    const resource = db.paperResources.get(resourceId)!;
    const now = Math.floor(Date.now() / 1000);
    resource.status = "ready";
    resource.page_count = 4;
    resource.image_count = 2;
    resource.ready_at = now;
    resource.updated_at = now;
    db.paperRequestContinuations.get(continuationId)!.status = "ready";
    db.paperRequestContinuations.get(continuationId)!.updated_at = now;
    db.paperRequestContinuations.get(continuationId)!.expires_at = now + 3600;

    const first = await readProgress(env, ALICE, resourceId, "s1");
    const second = await readProgress(env, ALICE, resourceId, "s1");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    expect(secondBody).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      resource: { status: "ready", stage: "ready", page_count: 4, image_count: 2 },
      materialize: { invocation_status: "succeeded", resource_ready: true },
      resume: {
        available: true,
        continuation_id: continuationId,
        method: "POST",
        path: `/api/paper/continuations/${continuationId}`,
        body: { session_id: "s1" },
      },
    });
  });

  it("projects every supported resource lifecycle status as both status and stage", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resourceId = await createResource(env, ALICE, "s1");
    const resource = db.paperResources.get(resourceId)!;
    const statuses = ["requested", "downloading", "extracting", "uploading", "ready", "failed", "cancelled"] as const;
    for (const [index, status] of statuses.entries()) {
      resource.status = status;
      resource.updated_at = 200 + index;
      const response = await readProgress(env, ALICE, resourceId, "s1");
      expect(response.status).toBe(200);
      const body = await response.json() as { resource: { status: string; stage: string }; materialize: { invocation_status: string } };
      expect(body.resource).toMatchObject({ status, stage: status });
      if (index === 0) expect(body.materialize.invocation_status).toBe("not_recorded");
    }
  });

  it("exposes only a safe bounded failure and never makes failed work resumable", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resourceId = await createResource(env, ALICE, "s1");
    const continuationId = await addContinuationAndMaterializeEvent(env, resourceId);
    const resource = db.paperResources.get(resourceId)!;
    resource.status = "failed";
    resource.error_code = "PAPER_PARSE_FAILED";
    resource.error_message_safe = "parser failed at /tmp/private/source.pdf";
    resource.updated_at = 110;
    db.paperRequestContinuations.get(continuationId)!.status = "failed";
    db.paperRequestContinuations.get(continuationId)!.last_error_code = "PAPER_PARSE_FAILED";

    const response = await readProgress(env, ALICE, resourceId, "s1");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      resource: { status: "failed", stage: "failed", error: { code: "PAPER_PARSE_FAILED", message: "Paper processing failed." } },
      resume: { available: false, reason_code: "PAPER_RESOURCE_FAILED" },
    });
    expect(body).not.toHaveProperty("error_message_safe");
    expect(body).not.toHaveProperty("pdf_object_key");
  });

  it("uses the same non-enumerating ownership boundary for foreign, guessed, stale, and deleted resources", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.seedChatSession("s2", "bob");
    const resourceId = await createResource(env, ALICE, "s1");

    expect((await readProgress(env, BOB, resourceId, "s2")).status).toBe(404);
    expect((await readProgress(env, ALICE, "not-a-real-resource", "s1")).status).toBe(404);
    expect(await revokePaperResourceLink(env, "s1", resourceId, "alice")).toBe(true);
    expect((await readProgress(env, ALICE, resourceId, "s1")).status).toBe(404);

    const deletedResourceId = await createResource(env, ALICE, "s1");
    db.paperResources.get(deletedResourceId)!.status = "deleted";
    expect((await readProgress(env, ALICE, deletedResourceId, "s1")).status).toBe(410);
  });

  it("rejects a duplicate resume while the owner continuation lease is active", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    const resourceId = await createResource(env, ALICE, "s1");
    const continuationId = await addContinuationAndMaterializeEvent(env, resourceId);
    const resource = db.paperResources.get(resourceId)!;
    resource.status = "ready";
    const continuation = db.paperRequestContinuations.get(continuationId)!;
    continuation.status = "running";
    continuation.active_turn_id = "active-run";
    const now = Math.floor(Date.now() / 1000);
    continuation.lease_expires_at = now + 300;
    continuation.expires_at = now + 3600;

    const response = await handlePaperContinuation(
      request(`/api/paper/continuations/${continuationId}`, {
        method: "POST",
        body: JSON.stringify({ session_id: "s1" }),
      }),
      env,
      ALICE,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PAPER_CONTINUATION_IN_PROGRESS" } });
  });
});
