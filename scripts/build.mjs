// Builds the published package: TypeScript to JavaScript in dist/ (Node does not strip types inside node_modules), plus the files the program reads at run
// time: the viewer page and the bundled tasks' own files.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
cpSync(join(root, "viewer", "index.html"), join(dist, "viewer", "index.html"));
// the math examples need no data; covertype downloads and prepares a data set beside the repository, so it stays a repository example
for (const entry of readdirSync(join(root, "tasks"), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith(".ts") || !entry.parentPath.includes(`${join("tasks", "math-")}`)) continue;
  const from = join(entry.parentPath, entry.name);
  cpSync(from, join(dist, from.slice(root.length)));
}
chmodSync(join(dist, "bin", "infinity.js"), 0o755);
console.log("built dist/");
