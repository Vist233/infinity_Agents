import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type TaskForm, formPackage, looksLikeForm } from "../src/form.ts";
import type { TaskPackage } from "../src/launch.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** The file a name stands for: a folder of tasks/ (bare name), a folder with a task.ts, task.mts, task.js or task.json, or a form or module file. */
function taskFile(name: string): string {
  const bare = !name.includes("/") && !/\.(m?ts|m?js)$/.test(name) && !name.endsWith(".json");
  const path = bare ? resolve(ROOT, "tasks", name) : resolve(name);
  if (existsSync(path) && statSync(path).isDirectory()) {
    // task.js: the bundled tasks of the published package are compiled (Node does not run TypeScript inside node_modules)
    for (const file of ["task.ts", "task.mts", "task.js", "task.json"]) if (existsSync(join(path, file))) return join(path, file);
    throw new Error(`${path} has no task.ts, task.mts, task.js or task.json`);
  }
  if (!existsSync(path))
    throw new Error(
      `no task "${name}" (looked for ${path}); give a task of tasks/, a folder or file of a form (.json or .ts), or a module that exports a task package`,
    );
  return path;
}

/** A task package by name or path. A form (preset, name, ...) becomes a package; a module's default export may also be a package itself. */
export async function loadTaskPackage(name: string): Promise<TaskPackage> {
  const path = taskFile(name);
  const exported = path.endsWith(".json") ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : (await import(pathToFileURL(path).href)).default;
  if (looksLikeForm(exported)) return formPackage(exported as TaskForm, dirname(path));
  const pack = exported as TaskPackage | undefined;
  if (!pack || typeof pack.build !== "function") throw new Error(`${path} must export a form (preset, name, ...) or a task package as its default export`);
  return pack;
}
