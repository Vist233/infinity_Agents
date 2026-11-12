// Start the run viewer: node viewer/view.ts <runs dir or run dir> [--port N] [--machine FILE]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isRunDir, listRuns } from "./run-reader.ts";
import { startViewer } from "./server.ts";

function usage(): never {
  console.error("usage: node viewer/view.ts <runs dir or run dir> [--port N] [--machine FILE]");
  process.exit(2);
}

/** Starts the viewer for the given arguments and returns when it is listening (the process then stays up until Ctrl-C). */
export async function runViewerCommand(args: string[]): Promise<void> {
  let root = "";
  let port = 4173;
  let machineFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port") port = Number(args[++i]);
    else if (a === "--machine") machineFile = resolve(args[++i] ?? "");
    else if (a.startsWith("--")) usage();
    else root = resolve(a);
  }
  if (root === "" || !Number.isInteger(port) || port < 0 || port > 65535) usage();
  if (!existsSync(root)) {
    console.error(`not found: ${root}`);
    process.exit(1);
  }
  if (!isRunDir(root) && listRuns(root).length === 0) {
    console.error(`no run directory in ${root} (a run directory holds events.jsonl, ledger.jsonl or state.json)`);
    process.exit(1);
  }

  const viewer = await startViewer({ root, port, ...(machineFile ? { machineFile } : {}) });
  const runs = isRunDir(root) ? 1 : listRuns(root).length;
  console.log(`Run viewer (read-only): http://127.0.0.1:${viewer.port}/  (${runs} run${runs === 1 ? "" : "s"}; newest opens first; Ctrl-C stops)`);
}

if (import.meta.main) await runViewerCommand(process.argv.slice(2));
