import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import { handleDiscoveryApi } from "../src/discovery";
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
    const deleted = await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`, { method: "DELETE" }), env, ALICE);
    expect(deleted?.status).toBe(200);
    expect(row.status).toBe("deleted");
    expect(bucket.objects.has(row.source_object_key)).toBe(false);
    expect((await handleDiscoveryApi(request(`/api/discovery/data-collections/${collectionId}`), env, ALICE))?.status).toBe(404);

    const reupload = await handleDiscoveryApi(await upload("/api/discovery/data-collections", csvFile("reupload.csv")), env, ALICE);
    expect(reupload?.status).toBe(201);
  });
});
