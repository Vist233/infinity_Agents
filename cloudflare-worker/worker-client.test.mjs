import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WorkerControlClient } from "./worker-client.mjs";

test("cross-platform client keeps the enrollment credential out of health output", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ worker_id: "mac-a", status: "active", attempts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new WorkerControlClient({
      control_base_url: "https://infinity.zhangyvjing.com",
      worker_credential: "local-only-credential",
    });
    const result = await client.health();
    assert.equal(result.worker_id, "mac-a");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer local-only-credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects plaintext control URLs before sending a credential", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("unexpected", { status: 200 });
  };
  try {
    const client = new WorkerControlClient({
      control_base_url: "http://infinity.zhangyvjing.com",
      worker_credential: "local-only-credential",
    });
    await assert.rejects(() => client.health(), /HTTPS control URL is required/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
