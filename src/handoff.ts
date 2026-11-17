import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHandoffTool } from "sakura-agent-tools/handoff";
import type { Tool } from "sakura-agent";

/**
 * Where agents hand each other checked work: one store per machine, shared by every agent of every run, so what one run proves the next can
 * reuse (INFINITY_HANDOFF_DIR moves it; tests give each worker its own).
 */
export const handoffStore = (): string => process.env.INFINITY_HANDOFF_DIR || join(homedir(), ".infinity", "handoff");

/** The `handoff` tool of one agent: it publishes from and pulls into its own work directory, as `<run>-<number>`. */
export function handoffTool(runRoot: string, number: number, workDir: string): Tool {
  return createHandoffTool({ storeRoot: handoffStore(), workDir, agentId: `${basename(runRoot)}-${number}` });
}
