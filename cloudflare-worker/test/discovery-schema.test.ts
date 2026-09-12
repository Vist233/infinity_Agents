import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationDirectory = join(process.cwd(), "migrations-infinity");

function runSql(sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), "infinity-discovery-schema-"));
  const database = join(directory, "schema.sqlite");
  try {
    return execFileSync("sqlite3", [database], { input: `.headers off\n.mode list\n${sql}`, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function allMigrations(): string {
  const names = [
    "0001_init.sql", "0002_tasks.sql", "0003_worker_control.sql", "0004_worker_verification_isolation.sql",
    "0005_chat_task_confirmations.sql", "0006_chat_task_binding.sql", "0007_persistent_worker_registrations.sql",
    "0008_user_settings.sql", "0009_normalize_legacy_worker_trust.sql", "0010_user_access_roles.sql",
    "0011_persistent_worker_credential_ciphertext.sql", "0012_worker_sessions.sql", "0013_public_worker_pool.sql",
    "0014_d1_worker_runtime.sql", "0015_c7_runtime_hardening.sql", "0016_immutable_worker_sessions.sql",
    "0017_chat_events.sql", "0018_paper_resources.sql", "0019_paper_processor_sessions.sql",
    "0020_paper_processor_objects.sql", "0021_paper_privacy_cleanup.sql", "0022_paper_request_continuations.sql",
    "0023_discovery_catalog.sql", "0024_discovery_leases.sql", "0025_fenced_output_pointers.sql", "0026_literature_watch_leases.sql", "0027_literature_retries_and_quota.sql",
  ];
  return names.map((name) => readFileSync(join(migrationDirectory, name), "utf8")).join("\n");
}

describe("Discovery D1 schema", () => {
  it("applies on a clean database and leaves the existing Task columns unchanged", () => {
    const sql = `PRAGMA foreign_keys=ON; ${allMigrations()} SELECT name FROM sqlite_master WHERE type='table' AND name IN ('paper_catalog','paper_capabilities','data_collections','dataset_capabilities','research_matches','discovery_processor_sessions','literature_watch_state','literature_watch_failures','literature_watch_daily_quota') ORDER BY name;`;
    const output = runSql(sql).trim().split(/\r?\n/).filter(Boolean);
    expect(output).toEqual([
      "data_collections", "dataset_capabilities", "discovery_processor_sessions", "literature_watch_daily_quota", "literature_watch_failures", "literature_watch_state",
      "paper_capabilities", "paper_catalog", "research_matches",
    ]);
  });

  it("rejects duplicate profile versions, duplicate matches, invalid statuses, and referenced deletes", () => {
    const sql = `
      PRAGMA foreign_keys=ON;
      ${allMigrations()}
      INSERT INTO chat_sessions(id,user_id,title,created_at,updated_at) VALUES ('s1','u1','Discovery',1,1);
      INSERT INTO paper_resources(resource_id,session_id,user_id,source_kind,source_ref,status,created_at,updated_at) VALUES ('r1','s1','u1','user_upload','upload-1','ready',1,1);
      INSERT INTO paper_catalog(paper_id,owner_user_id,source_resource_id,title,status,spam_status,created_at,updated_at) VALUES ('p1','u1','r1','Paper','profiled','scientific_paper',1,1);
      INSERT INTO data_collections(collection_id,owner_user_id,name,source_object_key,source_filename,source_sha256,source_size_bytes,status,created_at,updated_at) VALUES ('c1','u1','Data','datasets/c1/source/data.csv','data.csv',lower(hex(randomblob(32))),1,'ready',1,1);
      INSERT INTO research_matches(match_id,paper_id,collection_id,paper_profile_version,dataset_profile_version,created_at,updated_at) VALUES ('m1','p1','c1','paper-profile-v1','dataset-profile-v1',1,1);
      SELECT 'duplicate_paper=' || CASE WHEN EXISTS (SELECT 1 FROM paper_catalog WHERE source_resource_id='r1') THEN 'blocked-by-unique' ELSE 'bad' END;
      SELECT 'tables=' || (SELECT count(*) FROM sqlite_master WHERE type='table');
    `;
    expect(() => runSql(sql.replace("SELECT 'tables='", "INSERT INTO paper_catalog(paper_id,owner_user_id,source_resource_id,title,created_at,updated_at) VALUES ('p2','u1','r1','Duplicate',1,1); SELECT 'tables='"))).toThrow();
    expect(() => runSql(sql.replace("SELECT 'tables='", "INSERT INTO research_matches(match_id,paper_id,collection_id,paper_profile_version,dataset_profile_version,created_at,updated_at) VALUES ('m2','p1','c1','paper-profile-v1','dataset-profile-v1',1,1); SELECT 'tables='"))).toThrow();
    expect(() => runSql(sql.replace("SELECT 'tables='", "UPDATE paper_catalog SET status='not-valid' WHERE paper_id='p1'; SELECT 'tables='"))).toThrow();
    expect(() => runSql(sql.replace("SELECT 'tables='", "DELETE FROM paper_resources WHERE resource_id='r1'; SELECT 'tables='"))).toThrow();
  });

  it("supports owner-scoped private rows and public rows without widening the schema", () => {
    const output = runSql(`PRAGMA foreign_keys=ON; ${allMigrations()} INSERT INTO chat_sessions(id,user_id,title,created_at,updated_at) VALUES ('s1','u1','Discovery',1,1); INSERT INTO paper_resources(resource_id,session_id,user_id,source_kind,source_ref,status,created_at,updated_at) VALUES ('r1','s1','u1','user_upload','upload-1','ready',1,1); INSERT INTO paper_catalog(paper_id,owner_user_id,source_resource_id,visibility,title,created_at,updated_at) VALUES ('private','u1','r1','private','Private',1,1); SELECT visibility || ':' || owner_user_id FROM paper_catalog;`).trim();
    expect(output).toBe("private:u1");
  });

  it("adds immutable output pointers and watcher lease columns", () => {
    const output = runSql(`PRAGMA foreign_keys=ON; ${allMigrations()}
      SELECT name FROM pragma_table_info('paper_processor_objects') WHERE name = 'object_key';
      SELECT name FROM pragma_table_info('paper_catalog') WHERE name = 'profile_object_key';
      SELECT name FROM pragma_table_info('data_collections') WHERE name = 'profile_object_key';
      SELECT name FROM pragma_table_info('research_matches') WHERE name = 'evaluation_object_key';
      SELECT name FROM pragma_table_info('literature_watch_state') WHERE name IN ('lease_owner','lease_expires_at') ORDER BY name;
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('literature_watch_failures', 'literature_watch_daily_quota') ORDER BY name;`).trim();
    expect(output).toBe(["object_key", "profile_object_key", "profile_object_key", "evaluation_object_key", "lease_expires_at", "lease_owner", "literature_watch_daily_quota", "literature_watch_failures"].join("\n"));
  });
});
