// @ts-ignore test-only Node builtin
import { readFileSync } from "node:fs";
// @ts-ignore test-only Node builtin
import { createHash } from "node:crypto";
// @ts-ignore test-only Node builtin
import { join } from "node:path";
import { describe, expect, it } from "vitest";

declare const process: { cwd(): string };

type DeliveryDefinition = {
  schema_version?: string;
  status?: string;
  runtime?: Record<string, unknown>;
  artifact?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  secret_boundary?: Record<string, unknown>;
  singleton_lease?: Record<string, unknown>;
  health_restart?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  rollback?: Record<string, unknown>;
};

function repoPath(...parts: string[]): string {
  return join(process.cwd(), "..", ...parts);
}

function readDefinition(): DeliveryDefinition {
  return JSON.parse(readFileSync(repoPath("backend", "paper_processor", "delivery.v1.json"), "utf8")) as DeliveryDefinition;
}

function readRunbook(): string {
  return readFileSync(repoPath("docs", "PAPER_PROCESSOR_CLOUDFLARE_MANAGED_RUNBOOK.md"), "utf8");
}

function readService(): string {
  return readFileSync(repoPath("backend", "paper_processor", "infinity-paper-processor.service"), "utf8");
}

function readRequirements(): string {
  return readFileSync(repoPath("backend", "requirements.paper-processor.zhangbot.txt"), "utf8");
}

function readWranglerConfig(): string {
  return readFileSync(repoPath("cloudflare-worker", "wrangler.jsonc"), "utf8");
}

const PROCESSOR_SOURCE_FILES = [
  "backend/paper_processor/__init__.py",
  "backend/paper_processor/client.py",
  "backend/paper_processor/ingest.py",
  "backend/paper_processor/runner.py",
] as const;

const PROCESSOR_SOURCE_HASH_COMMAND =
  "sha256sum backend/paper_processor/__init__.py backend/paper_processor/client.py backend/paper_processor/ingest.py backend/paper_processor/runner.py | sha256sum";

function processorSourceAggregateHash(): string {
  const input = PROCESSOR_SOURCE_FILES.map((relativePath) => {
    const digest = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "..", relativePath)))
      .digest("hex");
    return `${digest}  ${relativePath}\n`;
  }).join("");
  return createHash("sha256").update(input).digest("hex");
}

function assertDeliveryDefinition(value: DeliveryDefinition): void {
  expect(value.schema_version).toBe("paper-processor.delivery/v2");
  expect(value.status).toBe("ready_for_zhangbot_rollout");
  expect(value.runtime).toMatchObject({
    provider: "linux-vps",
    class: "dedicated-single-host",
    host: "zhangbot",
    service_manager: "systemd-user",
    inbound_ports: [],
    edge_control_plane: "https://infinity.zhangyvjing.com",
  });
  expect(value.runtime?.allowed_source_hosts).toEqual(expect.arrayContaining([
    "arxiv.org",
    "export.arxiv.org",
    "www.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "pmc.ncbi.nlm.nih.gov",
  ]));
  expect(value.artifact).toMatchObject({
    reviewed_processor_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    python_version: "3.10",
    dependency_lock: "backend/requirements.paper-processor.zhangbot.txt",
    service_unit: "backend/paper_processor/infinity-paper-processor.service",
    virtualenv_layout: "<release-dir>/.venv",
  });
  expect(value.artifact?.artifact_hashes).toEqual(expect.objectContaining({
    processor_source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    dependency_lock_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    service_unit_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));
  expect(value.environment?.required_non_secret_names).toEqual(expect.arrayContaining([
    "PAPER_PROCESSOR_EDGE_URL",
    "PAPER_PROCESSOR_ID",
    "PAPER_PROCESSOR_SOURCE_IP",
    "PAPER_PROCESSOR_INSTANCE_ID",
    "PAPER_PROCESSOR_WORK_ROOT",
    "PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS",
    "PAPER_PROCESSOR_DOWNLOAD_TIMEOUT_SECONDS",
    "PAPER_PROCESSOR_EXTRACTION_TIMEOUT_SECONDS",
    "PAPER_PROCESSOR_UPLOAD_TIMEOUT_SECONDS",
    "PAPER_PROCESSOR_HEARTBEAT_INTERVAL_SECONDS",
    "PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES",
  ]));
  expect(value.secret_boundary).toMatchObject({
    processor_secret_names: ["PAPER_PROCESSOR_TOKEN"],
    processor_env_file: "/home/zhangyvjing/.config/infinity-paper-processor/processor.env",
    processor_env_file_mode: "0600",
    edge_secret_names: ["PAPER_PROCESSOR_SHARED_SECRET"],
    parent_credentials_forbidden: expect.arrayContaining([
      "D1_API_TOKEN",
      "R2_PARENT_KEY",
      "REDIS_URL",
      "CLOUDFLARE_API_TOKEN",
      "STEPFUN_API_KEY",
    ]),
  });
  expect(value.singleton_lease).toMatchObject({
    processor_id: "paper-processor-zhangbot-v1",
    active_instances_per_processor_id: 1,
    instance_id_must_be_unique: true,
    lease_and_fencing_source: "D1",
  });
  expect(value.health_restart).toMatchObject({
    readiness: expect.any(String),
    liveness: expect.any(String),
    restart: expect.any(String),
    attempt_timeout_seconds: 360,
    stage_timeout_seconds: { downloading: 90, extracting: 120, uploading: 240 },
    heartbeat_interval_seconds: 30,
    memory_high: "512M",
    memory_budget_bytes: 536870912,
    memory_max: "768M",
    tasks_max: expect.any(Number),
    timeout_failure_code: "PAPER_PROCESSOR_TIMEOUT",
    memory_failure_code: "PAPER_PROCESSOR_MEMORY_LIMIT",
    heartbeat_failure_code: "PAPER_PROCESSOR_HEARTBEAT_FAILED",
    single_attempt_behavior: expect.any(String),
    no_public_listener: true,
    user_systemd_constraint: expect.stringContaining("218/CAPABILITIES"),
  });
  expect(value.logging).toMatchObject({ redaction_policy: expect.any(String), raw_payloads_forbidden: true });
  expect(value.rollback).toMatchObject({ preserve_d1_r2: true, revoke_capabilities_first: true, operation: expect.any(String) });
  expect(value.runtime?.edge_access).toMatchObject({
    stable_source_ipv4: "39.105.204.121",
    cloudflare_action: "skip",
    skipped_products: ["bic"],
    protocol: "fixed_internal_endpoints",
    dynamic_path_segments: false,
    control_endpoint: "/api/paper-processor/control",
    object_upload_endpoint: "/api/paper-processor/object",
    control_operations: ["input", "input_source", "renew", "stage", "finalize", "cancel", "fail"],
    object_operation: "upload",
    object_kinds: ["source_pdf", "text_pages", "text_manifest", "image", "image_manifest"],
    allowed_methods_and_paths: [
      { method: "POST", path: "/api/paper-processor/connect" },
      { method: "POST", path: "/api/paper-processor/poll" },
      { method: "POST", path: "/api/paper-processor/control" },
      { method: "PUT", path: "/api/paper-processor/object" },
    ],
    non_processor_paths_excepted: false,
    non_source_ips_excepted: false,
  });
  expect(value.environment?.fixed_values).toMatchObject({ PAPER_PROCESSOR_SOURCE_IP: "39.105.204.121" });
}

describe("versioned dedicated Paper Processor delivery definition", () => {
  it("keeps the manifest source hash synchronized with its fixed input set and algorithm", () => {
    const definition = readDefinition();
    expect(definition.artifact?.artifact_hash_command).toBe(PROCESSOR_SOURCE_HASH_COMMAND);
    expect(definition.artifact?.artifact_hashes).toMatchObject({
      processor_source_sha256: processorSourceAggregateHash(),
    });
  });

  it("contains the auditable zhangbot runtime, artifact, secret, health, lease, logging and rollback contract", () => {
    assertDeliveryDefinition(readDefinition());
  });

  it("fails closed when immutable source identity or the secret boundary is missing", () => {
    const definition = readDefinition();
    const missingCommit = { ...definition, artifact: { ...definition.artifact, reviewed_processor_commit: "" } };
    expect(() => assertDeliveryDefinition(missingCommit)).toThrow();
    const missingSecret = { ...definition, secret_boundary: { ...definition.secret_boundary, processor_secret_names: [] } };
    expect(() => assertDeliveryDefinition(missingSecret)).toThrow();
    const missingAccess = { ...definition, runtime: { ...definition.runtime, edge_access: undefined } };
    expect(() => assertDeliveryDefinition(missingAccess)).toThrow();
  });

  it("defines a non-Docker, single-instance systemd service and pinned dependencies", () => {
    const service = readService();
    const requirements = readRequirements();
    const wranglerConfig = readWranglerConfig();
    const definition = readDefinition();
    expect(service).toContain("EnvironmentFile=/home/zhangyvjing/.config/infinity-paper-processor/processor.env");
    expect(service).toContain("PAPER_PROCESSOR_ID=paper-processor-zhangbot-v1");
    expect(service).toContain("PAPER_PROCESSOR_EDGE_URL=https://infinity.zhangyvjing.com");
    expect(service).toContain("NoNewPrivileges=yes");
    expect(service).toContain("PrivateTmp=yes");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ProtectHome=read-only");
    expect(service).toContain("UMask=0077");
    expect(service).toContain("LockPersonality=yes");
    expect(service).toContain("RestrictSUIDSGID=yes");
    expect(service).toContain("RestrictRealtime=yes");
    expect(service).toContain("KillMode=control-group");
    expect(service).toContain("MemoryHigh=512M");
    expect(service).toContain("PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS=360");
    expect(service).toContain("PAPER_PROCESSOR_DOWNLOAD_TIMEOUT_SECONDS=90");
    expect(service).toContain("PAPER_PROCESSOR_EXTRACTION_TIMEOUT_SECONDS=120");
    expect(service).toContain("PAPER_PROCESSOR_UPLOAD_TIMEOUT_SECONDS=240");
    expect(service).toContain("PAPER_PROCESSOR_HEARTBEAT_INTERVAL_SECONDS=30");
    expect(service).toContain("PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES=536870912");
    expect(service).toContain("MemoryMax=768M");
    expect(service).toContain("TasksMax=32");
    expect(service).toContain("LimitNOFILE=256");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX");
    expect(service).not.toMatch(/^PrivateDevices=/m);
    expect(service).not.toMatch(/^ProtectKernel(Tunables|Modules)=/m);
    expect(service).not.toContain("ProtectControlGroups=");
    expect(service).not.toMatch(/PAPER_PROCESSOR_TOKEN\s*=/);
    expect(service).not.toMatch(/Listen(Stream|Datagram)=/);
    const serviceHash = createHash("sha256").update(service).digest("hex");
    expect(definition.artifact?.artifact_hashes).toMatchObject({ service_unit_sha256: serviceHash });
    expect(wranglerConfig).toContain('"PAPER_PROCESSOR_ID": "paper-processor-zhangbot-v1"');
    expect(wranglerConfig).toContain('"PAPER_PROCESSOR_SOURCE_IP": "39.105.204.121"');
    expect(requirements).toMatch(/^pypdf==[0-9]+\.[0-9]+\.[0-9]+ \\\n\s+--hash=sha256:[0-9a-f]{64}$/m);
    expect(requirements).toMatch(/^PyMuPDF==[0-9]+\.[0-9]+\.[0-9]+ \\\n\s+--hash=sha256:[0-9a-f]{64}$/m);
    expect(requirements).toMatch(/^typing_extensions==4\.13\.2 \\\n\s+--hash=sha256:[0-9a-f]{64}$/m);
    expect(requirements).toContain("pip --require-hashes");
    expect(requirements).not.toMatch(/>=|<=|~=|\^/);
  });

  it("contains no credential values or raw payload fields", () => {
    const definitionText = readFileSync(repoPath("backend", "paper_processor", "delivery.v1.json"), "utf8");
    const runbook = readRunbook();
    expect(definitionText).not.toMatch(/https?:\/\/[^\s"]+:[^\s"]+@/);
    expect(definitionText).not.toMatch(/(?:sk-|-----BEGIN|Bearer\s+[A-Za-z0-9._-]{40,})/i);
    expect(definitionText).not.toMatch(/"(?:token|secret|password|api_key|shared_secret)"\s*:\s*"[^"<]+"/i);
    expect(runbook).toContain("paper-processor.delivery/v2");
    expect(runbook).toContain("PAPER_PROCESSOR_TOKEN");
    expect(runbook).toContain("PAPER_PROCESSOR_SHARED_SECRET");
    expect(runbook).toContain("zhangbot");
    expect(runbook).toContain("PrivateTmp=yes");
    expect(runbook).toContain("218/CAPABILITIES");
    expect(runbook).toContain("PrivateDevices");
    expect(runbook).toContain("Browser Integrity Check");
    expect(runbook).toContain('products: ["bic"]');
    expect(runbook).toContain("ip.src eq 39.105.204.121");
    expect(runbook).toContain("/api/paper-processor/control");
    expect(runbook).toContain("/api/paper-processor/object");
    expect(runbook).not.toContain("wildcard");
    expect(runbook).toContain("Non-zhangbot");
    expect(runbook).not.toMatch(/https?:\/\/[^\s]+:[^\s]+@/);
    expect(runbook).not.toMatch(/(?:sk-|-----BEGIN|Bearer\s+[A-Za-z0-9._-]{40,})/i);
    expect(runbook).not.toMatch(/(?:source\.pdf|pages\.jsonl|object_key|raw_pdf|full_text|image_bytes)/i);
  });
});
