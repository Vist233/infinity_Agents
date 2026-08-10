#!/usr/bin/env node

import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = resolve(homedir(), ".infinity-agents", "worker.json");

function usage() {
  console.error(`Infinity Agents HTTPS Worker client

Commands:
  enroll --control-url URL [--config PATH]
  configure --control-url URL --worker-id ID --namespace NS [--config PATH]
  health [--config PATH]
  connect [--config PATH]
  heartbeat [--config PATH]
  disconnect [--config PATH]
  poll [--config PATH]
  accept OFFER_ID [--config PATH]

configure reads INFINITY_WORKER_CREDENTIAL and writes a user-only config
file for a persistent registration returned by the Task Center. Optional Redis
and Anthropic settings are kept in that local file and never sent to the
control plane. enroll remains only as a legacy one-time bootstrap path.
`);
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function httpsControlUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("A valid HTTPS control URL is required");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("HTTPS control URL is required");
  }
  return parsed.toString().replace(/\/$/, "");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function configPath(args) {
  return resolve(option(args, "--config", process.env.INFINITY_WORKER_CONFIG || DEFAULT_CONFIG));
}

function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // chmod is harmless on Windows and makes the intended local-secret boundary
  // explicit on macOS/Linux. Windows users should additionally use an ACL that
  // grants access only to the Worker service account.
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
}

function loadConfig(file) {
  if (!existsSync(file)) throw new Error(`Worker config not found: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function requestJson(config, path, init = {}) {
  const controlUrl = httpsControlUrl(config.control_base_url);
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (config.worker_credential) headers.set("authorization", `Bearer ${config.worker_credential}`);
  if (config.session_id) headers.set("x-worker-session", config.session_id);
  const response = await fetch(new URL(path, `${controlUrl}/`), { ...init, headers });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export class WorkerControlClient {
  constructor(config) {
    this.config = config;
    if (!this.config.instance_id) this.config.instance_id = randomUUID();
    if (!this.config.version) this.config.version = "https-worker-client/2";
  }

  connect() {
    const capabilities = ["cloudflare-worker-v1", process.platform, process.arch];
    if (this.config.redis_url) capabilities.push("redis-configured");
    if (this.config.anthropic_api_key || this.config.anthropic_auth_token) capabilities.push("provider-configured");
    return requestJson(this.config, "/api/worker/v1/connect", {
      method: "POST",
      // Provider and Redis secrets stay in the local config. Only non-secret
      // capability signals and the model name cross the control-plane boundary.
      body: JSON.stringify({
        worker_id: this.config.worker_id,
        namespace: this.config.namespace,
        instance_id: this.config.instance_id,
        version: this.config.version || "https-worker-client/2",
        capabilities,
        redis_configured: Boolean(this.config.redis_url),
        provider_configured: Boolean(this.config.anthropic_api_key || this.config.anthropic_auth_token),
        provider_model: this.config.anthropic_model || null,
      }),
    }).then((response) => {
      this.config.session_id = response.session_id;
      return response;
    });
  }

  heartbeat() {
    return requestJson(this.config, "/api/worker/v1/heartbeat", { method: "POST", body: "{}" });
  }

  disconnect() {
    return requestJson(this.config, "/api/worker/v1/disconnect", { method: "POST", body: "{}" })
      .finally(() => { delete this.config.session_id; });
  }

  health() { return requestJson(this.config, "/api/worker/v1/health"); }

  poll(availableSlots = 1) {
    return requestJson(this.config, "/api/worker/v1/poll", {
      method: "POST",
      body: JSON.stringify({ available_slots: availableSlots, capabilities: ["macos", "https-worker-v1"] }),
    });
  }

  accept(offerId) {
    return requestJson(this.config, `/api/worker/v1/offers/${encodeURIComponent(offerId)}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}

async function enroll(args) {
  const controlUrl = httpsControlUrl(required(option(args, "--control-url"), "--control-url"));
  const token = required(process.env.WORKER_ENROLLMENT_TOKEN, "WORKER_ENROLLMENT_TOKEN");
  const configFile = configPath(args);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyText = `ed25519-spki.${base64url(publicKey.export({ type: "spki", format: "der" }))}`;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const response = await requestJson({ control_base_url: controlUrl }, "/api/worker/v1/enroll", {
    method: "POST",
    body: JSON.stringify({
      enrollment_token: token,
      public_key: publicKeyText,
      version: "https-worker-client/1",
      capabilities: ["https-worker-v1", process.platform, process.arch],
    }),
  });
  const config = {
    control_base_url: controlUrl,
    worker_id: response.worker_id,
    namespace: response.namespace,
    trust_level: response.trust_level,
    worker_credential: response.worker_credential,
    credential_expires_at: response.credential_expires_at,
    public_key: publicKeyText,
    private_key_pem: privateKeyPem,
  };
  saveConfig(configFile, config);
  console.log(JSON.stringify({
    worker_id: config.worker_id,
    namespace: config.namespace,
    trust_level: config.trust_level,
    credential_expires_at: config.credential_expires_at,
    config_file: configFile,
  }, null, 2));
}

async function configure(args) {
  const controlUrl = httpsControlUrl(required(option(args, "--control-url"), "--control-url"));
  const workerId = required(option(args, "--worker-id"), "--worker-id");
  const namespace = required(option(args, "--namespace"), "--namespace");
  const credential = required(process.env.INFINITY_WORKER_CREDENTIAL, "INFINITY_WORKER_CREDENTIAL");
  if (/\s/.test(workerId) || workerId.length > 120) throw new Error("Invalid --worker-id");
  if (/\s/.test(namespace) || namespace.length > 120) throw new Error("Invalid --namespace");
  if (credential.length > 256) throw new Error("Invalid INFINITY_WORKER_CREDENTIAL");
  const configFile = configPath(args);
  saveConfig(configFile, {
    control_base_url: controlUrl,
    worker_id: workerId,
    namespace,
    trust_level: "server_assigned",
    worker_credential: credential,
    credential_expires_at: null,
    registration_mode: "persistent",
    instance_id: option(args, "--instance-id", process.env.INFINITY_WORKER_INSTANCE_ID || randomUUID()),
    version: process.env.INFINITY_WORKER_VERSION || "https-worker-client/2",
    redis_url: option(args, "--redis-url", process.env.INFINITY_WORKER_REDIS_URL || process.env.REDIS_URL || null),
    redis_namespace: option(args, "--redis-namespace", process.env.INFINITY_WORKER_REDIS_NAMESPACE || process.env.REDIS_NAMESPACE || namespace),
    anthropic_api_key: option(args, "--anthropic-api-key", process.env.INFINITY_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null),
    anthropic_auth_token: option(args, "--anthropic-auth-token", process.env.INFINITY_ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || null),
    anthropic_base_url: option(args, "--anthropic-base-url", process.env.INFINITY_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || null),
    anthropic_model: option(args, "--anthropic-model", process.env.INFINITY_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || null),
  });
  console.log(JSON.stringify({
    worker_id: workerId,
    namespace,
    config_file: configFile,
    registration_mode: "persistent",
  }, null, 2));
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command) { usage(); process.exitCode = 2; return; }
  if (command === "enroll") { await enroll(args); return; }
  if (command === "configure") { await configure(args); return; }
  const file = configPath(args);
  const config = loadConfig(file);
  const client = new WorkerControlClient(config);
  const result = command === "health"
    ? await client.health()
    : command === "connect"
      ? await client.connect()
      : command === "heartbeat"
        ? await client.heartbeat()
        : command === "disconnect"
          ? await client.disconnect()
    : command === "poll"
      ? await client.poll(Number(option(args, "--slots", "1")))
      : command === "accept"
        ? await client.accept(required(args[0], "OFFER_ID"))
        : null;
  if (!result) { usage(); process.exitCode = 2; return; }
  if (["connect", "heartbeat", "disconnect"].includes(command)) saveConfig(file, config);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.payload) console.error(JSON.stringify(error.payload));
    process.exitCode = 1;
  });
}
