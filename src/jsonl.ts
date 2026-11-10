import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * An append-only file with one JSON value per line. Lines are written synchronously, so two writers in one process never interleave
 * and a crash leaves at most a torn last line, which reading skips.
 */
export class JsonlFile<T> {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(entry: T): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  readAll(): T[] {
    if (!existsSync(this.path)) return [];
    const entries: T[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // a torn last line after a crash; nothing after it can be trusted to be whole
      }
    }
    return entries;
  }
}
