#!/usr/bin/env node

import {
  generateKeyPairSync,
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
  enroll --control-url URL [--token TOKEN] [--config PATH]
  health [--config PATH]
  poll [--config PATH]
  accept OFFER_ID [--config PATH]

Enrollment reads WORKER_ENROLLMENT_TOKEN when --token is omitted. The token is
consumed once; the returned credential is written to a user-only config file.
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
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (config.worker_credential) headers.set("authorization", `Bearer ${config.worker_credential}`);
  const response = await fetch(new URL(path, config.control_base_url), { ...init, headers });
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
  const controlUrl = required(option(args, "--control-url"), "--control-url").replace(/\/$/, "");
  const token = required(option(args, "--token", process.env.WORKER_ENROLLMENT_TOKEN), "WORKER_ENROLLMENT_TOKEN or --token");
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

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command) { usage(); process.exitCode = 2; return; }
  if (command === "enroll") { await enroll(args); return; }
  const file = configPath(args);
  const config = loadConfig(file);
  const client = new WorkerControlClient(config);
  const result = command === "health"
    ? await client.health()
    : command === "poll"
      ? await client.poll(Number(option(args, "--slots", "1")))
      : command === "accept"
        ? await client.accept(required(args[0], "OFFER_ID"))
        : null;
  if (!result) { usage(); process.exitCode = 2; return; }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.payload) console.error(JSON.stringify(error.payload));
    process.exitCode = 1;
  });
}
