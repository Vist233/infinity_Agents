import { JsonlFile } from "../../src/jsonl.ts";
import type { LedgerEntry } from "../../src/records.ts";
import { runLayout } from "../../src/run-layout.ts";

/** The scored submits of a proof task that were accepted (score 1), in the order they were written. */
export const acceptedProofs = (runDir: string) =>
  new JsonlFile<LedgerEntry>(runLayout(runDir).ledger)
    .readAll()
    .filter((entry): entry is Extract<LedgerEntry, { type: "result" }> => entry.type === "result" && entry.status === "ok" && entry.score === 1);

/** The agents that have an accepted proof, each once, in order. */
export const provedAgents = (runDir: string): number[] => [...new Set(acceptedProofs(runDir).map((entry) => entry.agent))];
