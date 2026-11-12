#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type TaskPackage, startRun } from "../src/launch.ts";
import { startViewer } from "../viewer/server.ts";
import { runViewerCommand } from "../viewer/view.ts";
import { RUN_HELP, parseRunArgs } from "./flags.ts";
import { modelFromEnv } from "./model.ts";

const HELP = `infinity: run many agents on one task, and look at the run

${RUN_HELP}

usage: infinity view <runs dir or run dir> [--port N] [--machine FILE]
  serves the read-only run viewer (it only reads the run's files)

usage: infinity --help`;

const ROOT = resolve(import.meta.dirname, "..");

/** A task package by name (a folder of tasks/ with a task.ts) or by the path of a module; the package is its default export. */
export async function loadTaskPackage(name: string): Promise<TaskPackage> {
  const path = name.includes("/") || name.endsWith(".ts") || name.endsWith(".js") ? resolve(name) : resolve(ROOT, "tasks", name, "task.ts");
  if (!existsSync(path)) throw new Error(`no task "${name}" (looked for ${path}); give the name of a folder of tasks/ or the path of a task module`);
  const pack = (await import(pathToFileURL(path).href)).default as TaskPackage | undefined;
  if (!pack || typeof pack.build !== "function") throw new Error(`${path} must export a task package as its default export`);
  return pack;
}

async function run(argv: string[]): Promise<void> {
  const command = parseRunArgs(argv);
  const pack = await loadTaskPackage(command.task);
  const environmentModule = process.env.INFINITY_WORKER_ENVIRONMENT;
  const createEnvironment = environmentModule ? (await import(pathToFileURL(resolve(environmentModule)).href)).createEnvironment : undefined;
  if (environmentModule && typeof createEnvironment !== "function") throw new Error("The worker environment module must export createEnvironment");
  const handle = await startRun(pack, { ...command.options, model: modelFromEnv(), ...(createEnvironment ? { createEnvironment } : {}) });
  for (const line of handle.recommendation.lines) console.log(line);
  // Ctrl-C ends the run in order (agents stopped, report written); the hidden-data keeper puts the labels back at the same signal.
  process.on("SIGINT", () => void handle.stop());
  const viewer = command.view ? await startViewer({ root: resolve(command.options.runsDir ?? "runs"), port: command.view.port }) : undefined;
  if (viewer) console.log(`Run viewer (read-only, live): http://127.0.0.1:${viewer.port}/`);
  console.log(`Run directory: ${handle.runDir}`);
  const outcome = await handle.done;
  await viewer?.close();
  console.log(JSON.stringify(outcome));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") await run(rest);
    else if (command === "view") await runViewerCommand(rest);
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
