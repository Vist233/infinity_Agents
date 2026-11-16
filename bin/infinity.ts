#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startRun } from "../src/launch.ts";
import { machineOptions, readMachineConfig } from "../src/machine-config.ts";
import { startViewer } from "../viewer/server.ts";
import { runViewerCommand } from "../viewer/view.ts";
import { RUN_HELP, parseRunArgs } from "./flags.ts";
import { loadTaskPackage } from "./load-task.ts";
import { modelFromEnv } from "./model.ts";
import { recommend, scaffold } from "./scaffold.ts";

const HELP = `infinity: run many agents on one task, and look at the run

${RUN_HELP}

usage: infinity new <code|math> <folder>
  writes a task form to start from

usage: infinity recommend [--task <task>] [--write machine.json]
  what this computer can carry (agents, slots, threads), saved as a machine file

usage: infinity view <runs dir or run dir> [--port N] [--machine FILE]
  serves the read-only run viewer (it only reads the run's files)

usage: infinity --help`;

async function run(argv: string[]): Promise<void> {
  const command = parseRunArgs(argv);
  const pack = await loadTaskPackage(command.task);
  const machine = command.machine ? machineOptions(readMachineConfig(command.machine)) : {};
  const environmentModule = process.env.INFINITY_WORKER_ENVIRONMENT;
  const createEnvironment = environmentModule ? (await import(pathToFileURL(resolve(environmentModule)).href)).createEnvironment : undefined;
  if (environmentModule && typeof createEnvironment !== "function") throw new Error("The worker environment module must export createEnvironment");
  const model = modelFromEnv();
  const viewerRoot = resolve(command.options.resume ?? command.options.runsDir ?? "runs");
  const viewer = command.view ? await startViewer({ root: viewerRoot, port: command.view.port }) : undefined;
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const handle = await startRun(pack, {
      ...machine,
      ...command.options,
      model,
      signal: stopping.signal,
      ...(createEnvironment ? { createEnvironment } : {}),
    });
    for (const line of handle.recommendation.lines) console.log(line);
    if (viewer) console.log(`Run viewer (read-only, live): http://127.0.0.1:${viewer.port}/`);
    console.log(`Run directory: ${handle.runDir}`);
    console.log(JSON.stringify(await handle.done));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await viewer?.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") await run(rest);
    else if (command === "view") await runViewerCommand(rest);
    else if (command === "new") for (const file of scaffold(rest)) console.log(`wrote ${file}`);
    else if (command === "recommend") for (const line of await recommend(rest)) console.log(line);
    else {
      console.log(HELP);
      return command === undefined || command === "--help" || command === "-h" || command === "help" ? 0 : 2;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
