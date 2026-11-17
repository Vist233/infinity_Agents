// Each test worker writes its slot leases into a folder of its own, so runs started by parallel tests do not take each other's slots.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.INFINITY_SLOT_LEASE_DIR = mkdtempSync(join(tmpdir(), "infinity-test-leases-"));
// and its own handoff store, so tests never read or write the machine's shared packages
process.env.INFINITY_HANDOFF_DIR = mkdtempSync(join(tmpdir(), "infinity-test-handoff-"));
