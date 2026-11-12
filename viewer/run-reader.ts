// Reads the files of one run directory into a model for the viewer. Read-only, no imports from src/.
// Every file is optional; every line may be half written, unknown or missing fields; the model never throws on bad input.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type Rec = Record<string, unknown>;

/** One machine reading in one flat shape, whether it came from the new flat `machine.jsonl` or the older nested monitor format. */
export interface MachineSample {
  ts: number;
  cores: number | null;
  load1: number | null;
  loadPerCore: number | null;
  cpuBusy: number | null;
  cpuPressure10: number | null;
  cpuPressure60: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  gpuUtil: number | null;
  gpuMemMb: number | null;
  slotsInUse: number | null;
  slotsWaiting: number | null;
  gpuSlotsInUse: number | null;
  gpuSlotsWaiting: number | null;
  runCpuCores: number | null;
  runRssMb: number | null;
  agents: number | null;
  rung: number | null;
}

export interface AgentRow {
  agent: number;
  startedAt: number | null;
  endedAt: number | null;
  endDetail: string;
  commits: number;
  submits: number;
  bestScore: number | null;
  lastTs: number | null;
  lastKind: string;
  reviews: number;
  denied: number;
}

export interface Submit {
  ts: number;
  agent: number;
  score: number | null;
  status: string;
  selfReported: boolean;
}

export interface LeaderRow {
  rank: number;
  agent: number;
  score: number | null;
  selfReported: boolean;
  submits: number;
  errors: number;
}

export interface RunSummary {
  dir: string;
  name: string;
  task: string;
  /** "running", "finished" (a run_end record exists), or "stopped" (no end record and no activity for a while). */
  state: "running" | "finished" | "stopped" | "empty";
  endReason: string;
  startedAt: number | null;
  endedAt: number | null;
  lastTs: number | null;
  ceiling: number | null;
  tokensUsed: number | null;
  requests: number | null;
  bestScore: number | null;
  agentsStarted: number;
  agentsLive: number;
  rung: number | null;
  rungs: number[];
  submits: number;
  scoredSubmits: number;
  reviews: number;
  refusals: number;
  throttles: number;
  warnings: string[];
  facts: Rec | null;
  machineSource: string;
  machineSamples: number;
  leaderboard: LeaderRow[];
  version: number;
}

interface Tail {
  offset: number;
}

const STALE_MS = 3 * 60_000;
const CLIP = 600;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function pick(...values: unknown[]): number | null {
  for (const v of values) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
}
function clip(s: string): string {
  return s.length > CLIP ? `${s.slice(0, CLIP)}...` : s;
}

/** Turns a flat or nested machine record into one shape. Returns null without a usable time. */
export function normalizeMachine(raw: unknown): MachineSample | null {
  if (!isRec(raw)) return null;
  const ts = num(raw.ts);
  if (ts === null) return null;
  const load = isRec(raw.load) ? raw.load : {};
  const memory = isRec(raw.memory) ? raw.memory : {};
  const gpu = isRec(raw.gpu) ? raw.gpu : {};
  const run = isRec(raw.run) ? raw.run : {};
  const cores = num(raw.cores);
  const load1 = pick(raw.load1, load.one);
  return {
    ts,
    cores,
    load1,
    loadPerCore: load1 !== null && cores !== null && cores > 0 ? load1 / cores : null,
    cpuBusy: num(raw.cpuBusy),
    cpuPressure10: num(raw.cpuPressure10),
    cpuPressure60: num(raw.cpuPressure60),
    memUsedMb: pick(raw.memUsedMb, memory.usedMb),
    memTotalMb: pick(raw.memTotalMb, memory.totalMb),
    gpuUtil: pick(raw.gpuUtilPercent, gpu.utilPercent),
    gpuMemMb: pick(raw.gpuMemUsedMb, gpu.memoryUsedMb),
    slotsInUse: num(raw.slotsInUse),
    slotsWaiting: num(raw.slotsWaiting),
    gpuSlotsInUse: num(raw.gpuSlotsInUse),
    gpuSlotsWaiting: num(raw.gpuSlotsWaiting),
    runCpuCores: num(raw.runCpuCores),
    runRssMb: num(raw.runRssMb),
    agents: pick(raw.agents, run.agentsLive),
    rung: num(raw.rung),
  };
}

/** Splits CSV text into rows of cells. Handles quoted cells, doubled quotes and a missing last newline. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** Shrinks one event for the page: long text clipped, the review snapshot reduced to its summary fields. */
function trimEvent(raw: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "snapshot" && isRec(v)) {
      out.summary = clip(str(v.summary));
      out.assessment = str(v.assessment);
      out.steer = clip(str(v.steer));
      out.reason = clip(str(v.reason));
    } else if (typeof v === "string") out[k] = clip(v);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (isRec(v) && Object.keys(v).length < 20) out[k] = v;
  }
  return out;
}

export class RunReader {
  readonly dir: string;
  readonly name: string;
  private now: () => number;
  private machineOverride: string | null;
  private tails = new Map<string, Tail>();
  private fileStamp = new Map<string, string>();
  private version = 0;

  private events: Rec[] = [];
  private agents = new Map<number, AgentRow>();
  private submits: Submit[] = [];
  private liveDeltas: Array<[number, number]> = [];
  private machine: MachineSample[] = [];
  private machinePath: string | null = null;
  private state: Rec | null = null;
  private facts: Rec | null = null;
  private leaderboard: LeaderRow[] = [];
  private lastLedgerTs: number | null = null;
  private lastEventTs: number | null = null;

  constructor(dir: string, options: { machineFile?: string; now?: () => number } = {}) {
    this.dir = dir;
    this.name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
    this.machineOverride = options.machineFile ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Reads whatever is new in the files. Returns true when the model changed. */
  poll(): boolean {
    const before = this.version;
    this.readLines(join(this.dir, "events.jsonl"), (r) => this.onEvent(r));
    this.readLines(join(this.dir, "ledger.jsonl"), (r) => this.onLedger(r));
    this.readWhole(join(this.dir, "state.json"), (text) => {
      const parsed = tryJson(text);
      this.state = isRec(parsed) ? parsed : this.state;
    });
    this.readWhole(join(this.dir, "run-facts.json"), (text) => {
      const parsed = tryJson(text);
      this.facts = isRec(parsed) ? parsed : this.facts;
    });
    this.readWhole(join(this.dir, "report", "leaderboard.csv"), (text) => {
      this.leaderboard = parseLeaderboard(text);
    });
    const machinePath = this.machineOverride ?? this.findMachineFile();
    if (machinePath) {
      if (machinePath !== this.machinePath) {
        this.machinePath = machinePath;
        this.machine = [];
        this.tails.delete(machinePath);
      }
      this.readLines(machinePath, (r) => {
        const sample = normalizeMachine(r);
        if (sample) {
          this.machine.push(sample);
          this.version++;
        }
      });
    }
    return this.version !== before;
  }

  private findMachineFile(): string | null {
    const own = join(this.dir, "machine.jsonl");
    if (existsSync(own)) return own;
    // Older runs: the monitor wrote one file next to the runs directory (<root>/monitor/*.jsonl). Take the one that overlaps this run in time.
    const start = this.startedAt();
    if (start === null) return null;
    const monitorDir = join(dirname(dirname(this.dir)), "monitor");
    let names: string[] = [];
    try {
      names = readdirSync(monitorDir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return null;
    }
    const end = this.endedAt() ?? this.now();
    for (const n of names) {
      const path = join(monitorDir, n);
      const range = jsonlRange(path);
      if (range && range[0] <= end && range[1] >= start) return path;
    }
    return null;
  }

  private startedAt(): number | null {
    const s = num(this.state?.startedAt);
    if (s !== null) return s;
    const e = this.events.find((x) => x.type === "run_start");
    return e ? num(e.ts) : null;
  }

  private endedAt(): number | null {
    const e = this.events.findLast((x) => x.type === "run_end");
    return e ? num(e.ts) : null;
  }

  private onEvent(r: Rec) {
    const ts = num(r.ts);
    if (typeof r.type !== "string") return;
    if (ts !== null) this.lastEventTs = Math.max(this.lastEventTs ?? 0, ts);
    this.events.push(trimEvent(r));
    this.version++;
    const agent = num(r.agent);
    if (agent !== null && ts !== null && (r.type === "review" || r.type === "action_denied")) {
      const row = this.agentRow(agent);
      if (r.type === "review") row.reviews++;
      else row.denied++;
      if (row.lastTs === null || ts >= row.lastTs) {
        row.lastTs = ts;
        row.lastKind = r.type === "review" ? `review: ${str(r.outcome)}` : `denied: ${str(r.tool)}`;
      }
    }
  }

  private agentRow(agent: number): AgentRow {
    let row = this.agents.get(agent);
    if (!row) {
      row = {
        agent,
        startedAt: null,
        endedAt: null,
        endDetail: "",
        commits: 0,
        submits: 0,
        bestScore: null,
        lastTs: null,
        lastKind: "",
        reviews: 0,
        denied: 0,
      };
      this.agents.set(agent, row);
    }
    return row;
  }

  private onLedger(r: Rec) {
    const ts = num(r.ts);
    const agent = num(r.agent);
    if (typeof r.type !== "string" || agent === null) return;
    this.version++;
    if (ts !== null) this.lastLedgerTs = Math.max(this.lastLedgerTs ?? 0, ts);
    const row = this.agentRow(agent);
    const touch = (kind: string) => {
      if (ts !== null && (row.lastTs === null || ts >= row.lastTs)) {
        row.lastTs = ts;
        row.lastKind = kind;
      }
    };
    if (r.type === "lifecycle") {
      const event = str(r.event);
      if (event === "started") {
        row.startedAt = ts;
        if (ts !== null) this.liveDeltas.push([ts, 1]);
      } else if (event === "ended" || event === "stopped") {
        row.endedAt = ts;
        row.endDetail = clip(str(r.detail));
        if (ts !== null) this.liveDeltas.push([ts, -1]);
      }
      touch(`${event}${str(r.detail) ? `: ${clip(str(r.detail)).slice(0, 80)}` : ""}`);
    } else if (r.type === "commit") {
      row.commits++;
      touch("commit");
    } else if (r.type === "result") {
      row.submits++;
      const score = num(r.score);
      const ok = str(r.status) === "ok" && score !== null;
      if (ok && (row.bestScore === null || score > row.bestScore)) row.bestScore = score;
      this.submits.push({ ts: ts ?? 0, agent, score: ok ? score : null, status: str(r.status), selfReported: r.selfReported === true });
      touch(ok ? `submit ${score}` : `submit ${str(r.status)}`);
    }
  }

  /** Reads new complete lines of a JSONL file from the stored offset. A half-written last line is left for the next poll. */
  private readLines(path: string, onRecord: (r: Rec) => void) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    const tail = this.tails.get(path) ?? { offset: 0 };
    if (size < tail.offset) {
      // The file shrank: it was replaced. Start again for this file only; rebuilding everything is the caller's job (new reader).
      tail.offset = 0;
    }
    if (size === tail.offset) {
      this.tails.set(path, tail);
      return;
    }
    let text: string;
    try {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - tail.offset);
        const read = readSync(fd, buffer, 0, buffer.length, tail.offset);
        text = buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    let consumed = 0;
    while (consumed < text.length) {
      const nl = text.indexOf("\n", consumed);
      const line = nl === -1 ? text.slice(consumed) : text.slice(consumed, nl);
      if (nl === -1) {
        // No newline yet: take the line only when it is already complete JSON.
        const parsed = line.trim() === "" ? undefined : tryJson(line);
        if (isRec(parsed)) {
          onRecord(parsed);
          consumed = text.length;
        }
        break;
      }
      consumed = nl + 1;
      if (line.trim() === "") continue;
      const parsed = tryJson(line);
      if (isRec(parsed)) onRecord(parsed);
    }
    tail.offset += Buffer.byteLength(text.slice(0, consumed), "utf8");
    this.tails.set(path, tail);
  }

  /** Reads a small whole file again when its size or time changed. */
  private readWhole(path: string, onText: (text: string) => void) {
    let stamp: string;
    try {
      const s = statSync(path);
      stamp = `${s.size}:${s.mtimeMs}`;
    } catch {
      return;
    }
    if (this.fileStamp.get(path) === stamp) return;
    try {
      onText(readFileSync(path, "utf8"));
      this.fileStamp.set(path, stamp);
      this.version++;
    } catch {
      // Being replaced right now: try again at the next poll.
    }
  }

  // ----- views -----

  summary(): RunSummary {
    const start = this.startedAt();
    const runEnd = this.events.findLast((x) => x.type === "run_end");
    const runStart = this.events.find((x) => x.type === "run_start");
    const rungEvents = this.events.filter((x) => x.type === "rung");
    const ladder = isRec(this.state?.ladder) ? this.state.ladder : null;
    const ladderRungs = Array.isArray(ladder?.rungs) ? (ladder.rungs as unknown[]).filter((v): v is number => typeof v === "number") : [];
    const lastRung = rungEvents.at(-1);
    const rung = lastRung ? num(lastRung.to) : ladderRungs.length > 0 ? ladderRungs[0]! : null;
    const scored = this.submits.filter((s) => s.score !== null);
    const best = pick(
      this.state?.bestScore,
      runEnd?.bestScore,
      scored.reduce<number | null>((m, s) => (m === null || (s.score as number) > m ? (s.score as number) : m), null),
    );
    const lastTs = Math.max(this.lastEventTs ?? 0, this.lastLedgerTs ?? 0, this.machine.at(-1)?.ts ?? 0) || null;
    const ended = runEnd ? num(runEnd.ts) : null;
    const hasData = this.events.length > 0 || this.agents.size > 0 || this.state !== null;
    let state: RunSummary["state"] = "empty";
    if (hasData) {
      if (ended !== null || (this.state && str(this.state.finished) !== "" && this.state.finished !== false && this.state.finished !== null))
        state = "finished";
      else if (lastTs !== null && this.now() - lastTs > STALE_MS) state = "stopped";
      else state = "running";
    }
    let live = 0;
    let started = 0;
    for (const a of this.agents.values()) {
      if (a.startedAt !== null) {
        started++;
        if (a.endedAt === null) live++;
      }
    }
    return {
      dir: this.dir,
      name: this.name,
      task: str(runStart?.task) || str(this.state?.task),
      state,
      endReason: str(runEnd?.reason) || (typeof this.state?.finished === "string" ? this.state.finished : ""),
      startedAt: start,
      endedAt: ended,
      lastTs,
      ceiling: num(runStart?.ceiling) ?? num(this.facts?.ceiling),
      tokensUsed: pick(runEnd?.tokensUsed, this.state?.tokensUsed),
      requests: num(this.state?.requests),
      bestScore: best,
      agentsStarted: started,
      agentsLive: state === "finished" ? 0 : live,
      rung,
      rungs: ladderRungs,
      submits: this.submits.length,
      scoredSubmits: scored.length,
      reviews: this.events.filter((x) => x.type === "review").length,
      refusals: this.events.filter((x) => x.type === "action_denied").length,
      throttles: this.events.filter((x) => x.type === "throttle").length,
      warnings: this.events.filter((x) => x.type === "warning").map((x) => str(x.message)),
      facts: this.facts,
      machineSource: this.machinePath ?? "",
      machineSamples: this.machine.length,
      leaderboard: this.leaderboard,
      version: this.version,
    };
  }

  agentRows(): AgentRow[] {
    return [...this.agents.values()].sort((a, b) => a.agent - b.agent);
  }

  /** Everything the charts need. Machine readings are thinned to at most `maxPoints`. */
  series(maxPoints = 2000) {
    const start = this.startedAt();
    const rungs = this.events
      .filter((x) => x.type === "rung")
      .map((x) => ({ ts: num(x.ts) ?? 0, from: num(x.from) ?? 0, to: num(x.to) ?? 0, reason: str(x.reason) }));
    const throttles = this.events.filter((x) => x.type === "throttle").map((x) => ({ ts: num(x.ts) ?? 0, delayMs: num(x.delayMs) ?? 0, cause: str(x.cause) }));
    const brakes = this.events.filter((x) => x.type === "pressure_hold").map((x) => ({ ts: num(x.ts) ?? 0, on: x.on === true }));
    const warnings = this.events.filter((x) => x.type === "warning").map((x) => ({ ts: num(x.ts) ?? 0, message: str(x.message) }));
    const slotWaits = this.events
      .filter((x) => x.type === "slot_wait")
      .map((x) => ({ ts: num(x.ts) ?? 0, kind: str(x.kind), agent: num(x.agent) ?? 0, waitMs: num(x.waitMs) ?? 0 }));
    const ordered = [...this.liveDeltas].sort((a, b) => a[0] - b[0]);
    let live = 0;
    const agentsLive = ordered.map(([ts, d]): [number, number] => {
      live += d;
      return [ts, live];
    });
    const stride = Math.max(1, Math.ceil(this.machine.length / maxPoints));
    const machine = this.machine.filter((_, i) => i % stride === 0 || i === this.machine.length - 1);
    const summary = this.summary();
    const end = summary.endedAt ?? summary.lastTs ?? start;
    return {
      startedAt: start,
      endAt: end,
      initialRung: summary.rungs[0] ?? rungs[0]?.from ?? 1,
      rungs,
      submits: this.submits,
      throttles,
      brakes,
      warnings,
      slotWaits,
      agentsLive,
      machine,
      version: this.version,
    };
  }

  /** Events after time `since`, optionally of given types, at most `limit` (the newest). */
  eventList(options: { since?: number; types?: string[]; limit?: number } = {}): Rec[] {
    const since = options.since ?? 0;
    const types = options.types && options.types.length > 0 ? new Set(options.types) : null;
    const out = this.events.filter((e) => (num(e.ts) ?? 0) > since && (types === null || types.has(str(e.type))));
    return out.slice(-(options.limit ?? 500));
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonlRange(path: string): [number, number] | null {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const first = num((tryJson(lines[0] ?? "") as Rec | undefined)?.ts);
    let last: number | null = null;
    for (let i = lines.length - 1; i >= 0 && last === null; i--) last = num((tryJson(lines[i]!) as Rec | undefined)?.ts);
    return first !== null && last !== null ? [first, last] : null;
  } catch {
    return null;
  }
}

function parseLeaderboard(text: string): LeaderRow[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const [iRank, iAgent, iScore, iSelf, iSubmits, iErrors] = ["rank", "agent", "score", "self_reported", "submits", "errors"].map(col);
  const cell = (row: string[], i: number | undefined) => (i === undefined || i < 0 ? "" : (row[i] ?? ""));
  const toNum = (s: string) => (s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
  return rows.slice(1).map((row, n) => ({
    rank: toNum(cell(row, iRank)) ?? n + 1,
    agent: toNum(cell(row, iAgent)) ?? 0,
    score: toNum(cell(row, iScore)),
    selfReported: cell(row, iSelf) === "true",
    submits: toNum(cell(row, iSubmits)) ?? 0,
    errors: toNum(cell(row, iErrors)) ?? 0,
  }));
}

/** True when the directory looks like a run directory (has one of the run files). */
export function isRunDir(dir: string): boolean {
  return ["events.jsonl", "ledger.jsonl", "state.json"].some((f) => existsSync(join(dir, f)));
}

/** Run directories directly under `dir`, newest first (by the newest modification time of their main files). */
export function listRuns(dir: string): Array<{ name: string; path: string; mtime: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const runs: Array<{ name: string; path: string; mtime: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory() || !isRunDir(path)) continue;
      const mtime = Math.max(...["events.jsonl", "ledger.jsonl", "state.json"].map((f) => (existsSync(join(path, f)) ? statSync(join(path, f)).mtimeMs : 0)));
      runs.push({ name, path, mtime });
    } catch {
      // vanished while listing
    }
  }
  return runs.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}
