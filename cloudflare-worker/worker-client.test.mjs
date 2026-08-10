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

test("reverse handshake stores only the server session id and sends no provider secret", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ session_id: "session-1", connected: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const config = {
      control_base_url: "https://infinity.zhangyvjing.com",
      worker_id: "worker-a",
      namespace: "infinity",
      instance_id: "instance-a-12345678",
      worker_credential: "local-only-credential",
      redis_url: "redis://local-only",
      anthropic_api_key: "secret-local-only",
      anthropic_model: "model-local-only",
    };
    const client = new WorkerControlClient(config);
    await client.connect();
    assert.equal(config.session_id, "session-1");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.worker_id, "worker-a");
    assert.equal(body.provider_configured, true);
    assert.equal(body.provider_model, "model-local-only");
    assert.equal("anthropic_api_key" in body, false);
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer local-only-credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session id is attached to subsequent control calls", async () => {
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const client = new WorkerControlClient({
      control_base_url: "https://infinity.zhangyvjing.com",
      worker_credential: "local-only-credential",
      session_id: "session-1",
    });
    await client.heartbeat();
    assert.equal(headers.get("x-worker-session"), "session-1");
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
