// HTTP server of the run viewer: Node http only, 127.0.0.1 only, read-only (GET), JSON endpoints and one server-sent-events stream.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunDir, listRuns, RunReader } from "./run-reader.ts";

export interface ViewerOptions {
  /** A run directory, or a directory holding run directories. */
  root: string;
  port?: number;
  /** How often the files are checked for new lines while a stream is open, in ms. */
  pollMs?: number;
  /** Machine readings file for runs that have no machine.jsonl of their own. */
  machineFile?: string;
  now?: () => number;
}

export interface ViewerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "index.html");

export async function startViewer(options: ViewerOptions): Promise<ViewerHandle> {
  const single = isRunDir(options.root);
  const readers = new Map<string, RunReader>();
  const clients = new Map<ServerResponse, { run: string; version: number }>();
  const pollMs = options.pollMs ?? 1000;

  const runNames = () => (single ? [new RunReader(options.root).name] : listRuns(options.root).map((r) => r.name));
  const resolve = (name: string | null): RunReader | null => {
    let target = name;
    if (target === null || target === "") target = runNames()[0] ?? null;
    if (target === null) return null;
    const known = single ? runNames() : listRuns(options.root).map((r) => r.name);
    if (!known.includes(target)) return null;
    let reader = readers.get(target);
    if (!reader) {
      const dir = single ? options.root : join(options.root, target);
      reader = new RunReader(dir, { ...(options.machineFile ? { machineFile: options.machineFile } : {}), ...(options.now ? { now: options.now } : {}) });
      readers.set(target, reader);
    }
    reader.poll();
    return reader;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return json(res, 403, { error: "host not allowed" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(PAGE));
    }
    if (path === "/api/runs") {
      const runs = single ? [{ name: runNames()[0], mtime: Date.now() }] : listRuns(options.root).map((r) => ({ name: r.name, mtime: r.mtime }));
      return json(res, 200, { runs, current: runs[0]?.name ?? null });
    }
    if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });
    const reader = resolve(url.searchParams.get("run"));
    if (!reader) return json(res, 404, { error: "no such run" });
    if (path === "/api/run") return json(res, 200, reader.summary());
    if (path === "/api/series") {
      const max = Number(url.searchParams.get("max"));
      return json(res, 200, reader.series(Number.isFinite(max) && max > 10 ? max : 2000));
    }
    if (path === "/api/agents") return json(res, 200, reader.agentRows());
    if (path === "/api/events") {
      const since = Number(url.searchParams.get("since"));
      const limit = Number(url.searchParams.get("limit"));
      const types = (url.searchParams.get("type") ?? "").split(",").filter(Boolean);
      return json(
        res,
        200,
        reader.eventList({ ...(Number.isFinite(since) && since > 0 ? { since } : {}), types, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) }),
      );
    }
    if (path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const run = reader.name;
      clients.set(res, { run, version: reader.summary().version });
      res.write(`event: hello\ndata: ${JSON.stringify({ run, version: clients.get(res)?.version })}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    return json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.end();
    }
  });

  const timer = setInterval(() => {
    if (clients.size === 0) return;
    for (const [res, client] of clients) {
      const reader = resolve(client.run);
      if (!reader) continue;
      const version = reader.summary().version;
      if (version !== client.version) {
        client.version = version;
        res.write(`event: update\ndata: ${JSON.stringify({ run: client.run, version })}\n\n`);
      } else res.write(": keep-alive\n\n");
    }
  }, pollMs);
  timer.unref();

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, "127.0.0.1", () => ok());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(timer);
        for (const res of clients.keys()) res.end();
        clients.clear();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
