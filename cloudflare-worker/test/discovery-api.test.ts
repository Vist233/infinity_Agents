import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import { DISCOVERY_MAX_COLLECTION_BYTES, handleDiscoveryApi } from "../src/discovery";
import { makeEnv } from "./fake-d1";

const ALICE: AuthedUser = { userId: "alice", email: "alice@example.com", sid: "sid-a" };
const BOB: AuthedUser = { userId: "bob", email: "bob@example.com", sid: "sid-b" };

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    if (typeof value === "string") this.objects.set(key, new TextEncoder().encode(value));
    else if (value instanceof ArrayBuffer) this.objects.set(key, new Uint8Array(value));
    else this.objects.set(key, new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }

  async get(key: string): Promise<{ size: number; text(): Promise<string> } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return { size: value.byteLength, text: async () => new TextDecoder().decode(value) };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, init);
}

function pdfFile(name = "paper.pdf"): File {
  return new File([new TextEncoder().encode("%PDF-1.7\nfixture")], name, { type: "application/pdf" });
}

function csvFile(name = "wine.csv"): File {
  return new File(["a,b,quality\n1,2,3\n"], name, { type: "text/csv" });
}

async function upload(path: string, file: File, fields: Record<string, string> = {}): Promise<Request> {
  const form = new FormData();
  form.set("file", file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return request(path, { method: "POST", body: form });
}

function setup() {
  const { env, db } = makeEnv();
  const bucket = new MemoryBucket();
  env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];
  return { env, db, bucket };
}

describe("Discovery Paper and Data Collection APIs", () => {
  it("accepts a real PDF, creates a private Paper Catalog row, and deduplicates by SHA", async () => {
    const { env, db, bucket } = setup();
    const first = await handleDiscoveryApi(await upload("/api/discovery/papers", pdfFile(), { title: "A paper" }), env, ALICE);
    expect(first?.status).toBe(201);
    const firstBody = await first!.json() as Record<string, unknown>;
    expect(firstBody).toMatchObject({ title: "A paper", status: "requested", spam_status: "pending", duplicate: false });
    expect(firstBody).not.toHaveProperty("source_object_key");
    expect(db.paperCatalog.size).toBe(1);
    const resourceId = String(firstBody.source_resource_id);
    expect(db.paperResources.get(resourceId)).toMatchObject({ source_kind: "user_upload", pdf_object_key: `paper/${resourceId}/source.pdf` });
    expect(bucket.objects.has(`paper/${resourceId}/source.pdf`)).toBe(true);

    const duplicate = await handleDiscoveryApi(await upload("/api/discovery/papers", pdfFile(), { title: "Changed title" }), env, ALICE);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate!.json()).toMatchObject({ paper_id: firstBody.paper_id, duplicate: true });
    expect(db.paperCatalog.size).toBe(1);
  });

  it("rejects non-PDFs, over-limit declarations, and cross-user Paper reads", async () => {
    const { env } = setup();
    const invalid = await handleDiscoveryApi(await upload("/api/discovery/papers", csvFile()), env, ALICE);
    expect(invalid?.status).toBe(422);
    expect((await invalid!.json() as { error: { code: string } }).error.code).toBe("DISCOVERY_PAPER_NOT_PDF");

    const oversizedForm = new FormData();
    oversizedForm.set("file", pdfFile());
    const declaredTooLarge = await handleDiscoveryApi(request("/api/discovery/papers", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 * 1024 + 2 * 1024 * 1024) },
      body: oversizedForm,
    }), env, ALICE);
    expect(declaredTooLarge?.status).toBe(413);

    const valid = await handleDiscoveryApi(await upload("/api/discovery/papers", pdfFile()), env, ALICE);
    expect(valid?.status).toBe(201);
    const paperId = String((await valid!.json() as { paper_id: string }).paper_id);
    const hidden = await handleDiscoveryApi(request(`/api/discovery/papers/${paperId}`), env, BOB);
    expect(hidden?.status).toBe(404);
  });

  it("caps a chunked multipart envelope before formData can buffer it", async () => {
    const { env } = setup();
    const oversizedChunk = new Uint8Array(DISCOVERY_MAX_COLLECTION_BYTES + 1 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    });
    const response = await handleDiscoveryApi(request("/api/discovery/data-collections", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=not-used" },
      body: stream,
      duplex: "half",
    } as unknown as RequestInit), env, ALICE);
    expect(response?.status).toBe(413);
    expect(await response!.json()).toMatchObject({ error: { code: "DISCOVERY_UPLOAD_TOO_LARGE" } });
  });

  it("stores a Data Collection under a server-generated key and scopes ownership", async () => {
    const { env, db, bucket } = setup();
    const response = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile("../../wine.csv"), { name: "Wine data" }), env, ALICE);
    expect(response?.status).toBe(201);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Wine data", status: "uploaded", duplicate: false, source_filename: "wine.csv" });
    expect(body).not.toHaveProperty("source_object_key");
    expect(db.dataCollections.size).toBe(1);
    const collectionId = String(body.collection_id);
    const row = db.dataCollections.get(collectionId)!;
    expect(row.source_object_key).toBe(`datasets/${collectionId}/source/wine.csv`);
    expect(bucket.objects.has(row.source_object_key)).toBe(true);

    const crossUser = await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`), env, BOB);
    expect(crossUser?.status).toBe(404);
    const duplicate = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile("other.csv")), env, ALICE);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate!.json()).toMatchObject({ collection_id: collectionId, duplicate: true });
  });

  it("rejects unsupported data types and deletes owner data without widening access", async () => {
    const { env, db, bucket } = setup();
    const invalid = await handleDiscoveryApi(await upload("/api/discovery/data-collections", new File(["binary"], "data.exe")), env, ALICE);
    expect(invalid?.status).toBe(422);
    const created = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile()), env, ALICE);
    const collectionId = String((await created!.json() as { collection_id: string }).collection_id);
    const row = db.dataCollections.get(collectionId)!;
    const profileKey = `discovery/staging/dataset-profile/${collectionId}/processor-1/epoch-1/dataset-profile.v1.json`;
    row.profile_object_key = profileKey;
    bucket.objects.set(profileKey, new TextEncoder().encode("{}"));
    const deleted = await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`, { method: "DELETE" }), env, ALICE);
    expect(deleted?.status).toBe(200);
    expect(row.status).toBe("deleted");
    expect(bucket.objects.has(row.source_object_key)).toBe(false);
    expect(bucket.objects.has(profileKey)).toBe(false);
    expect((await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`), env, ALICE))?.status).toBe(404);

    const reupload = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile("reupload.csv")), env, ALICE);
    expect(reupload?.status).toBe(201);
  });

  it("refuses to delete a collection while a queued task still references its immutable object", async () => {
    const { env, db, bucket } = setup();
    const created = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile()), env, ALICE);
    const collectionId = String((await created!.json() as { collection_id: string }).collection_id);
    const collection = db.dataCollections.get(collectionId)!;
    collection.status = "ready";
    const resourceId = "discovery-dataset-resource-1";
    db.taskResources.set(resourceId, {
      resource_id: resourceId, project_id: "project-1", user_id: "alice", kind: "dataset",
      logical_name: collection.source_filename, object_key: collection.source_object_key,
      content_type: collection.source_content_type, file_size_bytes: collection.source_size_bytes,
      file_hash_sha256: collection.source_sha256, created_at: 1,
    });
    db.datasetSnapshots.set("snapshot-1", {
      dataset_snapshot_id: "snapshot-1", task_spec_id: "spec-1", project_id: "project-1", user_id: "alice",
      original_filename: collection.source_filename, resource_id: resourceId,
      file_hash_sha256: collection.source_sha256, file_size_bytes: collection.source_size_bytes,
      validation_passed: 1, created_at: 1,
    });
    db.tasks.set("task-1", {
      task_id: "task-1", task_spec_id: "spec-1", dataset_snapshot_id: "snapshot-1", project_id: "project-1",
      title: "Reproduce", status: "queued", created_by: "alice", chat_confirmation_id: null,
      task_class: "public", attempt_count: 0, max_attempts: 3, created_at: 1, updated_at: 1,
    });

    const response = await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`, { method: "DELETE" }), env, ALICE);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "DISCOVERY_COLLECTION_IN_USE" } });
    expect(collection.status).toBe("ready");
    expect(bucket.objects.has(collection.source_object_key)).toBe(true);
  });

  it("keeps match evaluation processor-owned while exposing an idempotent browser request", async () => {
    const { env, db } = setup();
    db.paperCatalog.set("paper-1", {
      paper_id: "paper-1", owner_user_id: null, source_resource_id: "resource-1", visibility: "public",
      title: "Public paper", authors_json: "[]", year: null, venue: null, status: "profiled", spam_status: "scientific_paper",
      profile_version: "paper-profile-v1", profile_json: null, profile_sha256: null, overview_object_key: null, created_at: 1, updated_at: 1,
    });
    db.dataCollections.set("collection-1", {
      collection_id: "collection-1", owner_user_id: "alice", name: "Data", source_object_key: "datasets/c/source.csv",
      source_filename: "source.csv", source_content_type: "text/csv", source_sha256: "a".repeat(64), source_size_bytes: 10,
      status: "ready", profile_version: "dataset-profile-v1", profile_json: null, profile_sha256: null, error_code: null,
      error_message_safe: null, created_at: 1, updated_at: 1,
    });
    db.researchMatches.set("match-1", {
      match_id: "match-1", paper_id: "paper-1", collection_id: "collection-1", paper_profile_version: "paper-profile-v1",
      dataset_profile_version: "dataset-profile-v1", status: "candidate", hard_gate: "pending", coverage_ratio: 0.5,
      execution_confidence: null, scientific_fit: null, evaluator_version: null, evaluation_json: null, created_task_id: null,
      candidate_reason: "1/2 modules", created_at: 1, updated_at: 1,
    });

    const queued = await handleDiscoveryApi(request("/api/discovery/matches/match-1/evaluate", { method: "POST" }), env, ALICE);
    expect(queued?.status).toBe(200);
    expect(await queued!.json()).toMatchObject({ match_id: "match-1", status: "candidate", queued: true, evaluation: null });
    expect((await handleDiscoveryApi(request("/api/discovery/matches/match-1/evaluate", { method: "POST" }), env, BOB))?.status).toBe(404);
  });

  it("does not create a Task from a match until the server-side threshold is passed", async () => {
    const { env, db } = setup();
    db.paperCatalog.set("paper-2", {
      paper_id: "paper-2", owner_user_id: null, source_resource_id: "resource-2", visibility: "public",
      title: "Public paper", authors_json: "[]", year: null, venue: null, status: "profiled", spam_status: "scientific_paper",
      profile_version: "paper-profile-v1", profile_json: null, profile_sha256: null, overview_object_key: null, created_at: 1, updated_at: 1,
    });
    db.dataCollections.set("collection-2", {
      collection_id: "collection-2", owner_user_id: "alice", name: "Data", source_object_key: "datasets/c/source.csv",
      source_filename: "source.csv", source_content_type: "text/csv", source_sha256: "b".repeat(64), source_size_bytes: 10,
      status: "ready", profile_version: "dataset-profile-v1", profile_json: null, profile_sha256: null, error_code: null,
      error_message_safe: null, created_at: 1, updated_at: 1,
    });
    db.researchMatches.set("match-2", {
      match_id: "match-2", paper_id: "paper-2", collection_id: "collection-2", paper_profile_version: "paper-profile-v1",
      dataset_profile_version: "dataset-profile-v1", status: "evaluated", hard_gate: "pass", coverage_ratio: 0.59,
      execution_confidence: 99, scientific_fit: 99, evaluator_version: "feasibility-v1", evaluation_json: "{}", created_task_id: null,
      candidate_reason: "", created_at: 1, updated_at: 1,
    });
    const response = await handleDiscoveryApi(request("/api/discovery/matches/match-2/create-task", { method: "POST" }), env, ALICE);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "DISCOVERY_TASK_THRESHOLD_NOT_MET" } });
  });
});
