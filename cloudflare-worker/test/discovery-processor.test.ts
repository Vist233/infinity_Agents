import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleDiscoveryProcessorApi } from "../src/discovery-processor";
import { hashText } from "../src/sha256";
import { makeEnv } from "./fake-d1";

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    if (typeof value === "string") this.objects.set(key, new TextEncoder().encode(value));
    else if (value instanceof ArrayBuffer) this.objects.set(key, new Uint8Array(value));
    else this.objects.set(key, new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }
}

function processorRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, init);
}

describe("Discovery Processor control protocol", () => {
  it("accepts an evaluation once and acknowledges an identical retry after fencing clears the lease", async () => {
    const { env, db } = makeEnv();
    env.RESOURCE_BUCKET = new MemoryBucket() as unknown as Env["RESOURCE_BUCKET"];
    env.DISCOVERY_PROCESSOR_ID = "discovery-processor-1";
    env.DISCOVERY_PROCESSOR_SHARED_SECRET = "discovery-bootstrap-secret";
    const sourceHeaders = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" };
    const connected = await handleDiscoveryProcessorApi(processorRequest("/api/discovery-processor/connect", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-id": "discovery-processor-1", "x-discovery-processor-token": "discovery-bootstrap-secret" },
      body: JSON.stringify({ instance_id: "instance-1" }),
    }), env);
    expect(connected?.status).toBe(200);
    const session = await connected!.json() as { processor_session_id: string; processor_session_token: string };
    const leaseToken = "lease-token-for-evaluation-123456";
    const now = Math.floor(Date.now() / 1000);
    db.researchMatches.set("match-1", {
      match_id: "match-1", paper_id: "paper-1", collection_id: "collection-1", paper_profile_version: "paper-profile-v1",
      dataset_profile_version: "dataset-profile-v1", status: "evaluating", hard_gate: "pending", coverage_ratio: 1,
      execution_confidence: null, scientific_fit: null, evaluator_version: null, evaluation_json: null, created_task_id: null,
      candidate_reason: "all capabilities", created_at: now, updated_at: now,
      discovery_lease_owner: session.processor_session_id, discovery_lease_expires_at: now + 300,
      discovery_lease_token_hash: hashText(leaseToken), discovery_fencing_epoch: 1,
    });
    const evaluation = {
      evaluator_version: "feasibility-v1", hard_gate: "pass",
      coverage: { supported_modules: 1, total_modules: 1, ratio: 1 },
      execution_confidence: 80, scientific_fit: 80, missing_requirements: [], risks: [],
      recommended: true, reason: "The compatible input contract is satisfied.",
    };
    const request = () => processorRequest("/api/discovery-processor/control", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-session": session.processor_session_token, "x-discovery-processor-lease-token": leaseToken },
      body: JSON.stringify({ operation: "save_evaluation", kind: "match", work_id: "match-1", fencing_epoch: 1, evaluation }),
    });
    const first = await handleDiscoveryProcessorApi(request(), env);
    expect(first?.status).toBe(200);
    expect(await first!.json()).toMatchObject({ match_id: "match-1", status: "evaluated" });
    const retry = await handleDiscoveryProcessorApi(request(), env);
    expect(retry?.status).toBe(200);
    expect(await retry!.json()).toMatchObject({ match_id: "match-1", status: "evaluated", idempotent: true });
  });
});
