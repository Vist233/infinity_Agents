import type { LogEntry } from "sakura-agent";
import { JsonlFile } from "./jsonl.ts";

type Field = { description: string } & ({ type: "number" | "string" | "boolean" } | { type: "enum"; values: readonly string[] });

export interface ReviewOutputSettings {
  /** Task-specific criteria for the assessment and attention priority. */
  criteria?: string;
  fields?: Readonly<Record<string, Field>>;
  sort?: { field: string; direction: "max" | "min" };
}

const statuses = ["working", "waiting", "blocked", "ready_for_review", "unknown"] as const;
const assessments = ["on_track", "needs_attention", "unknown"] as const;
const maxEvidence = 8;
const maxTextLength = 500;

type Detail = number | string | boolean;
type Evidence = { entryId: string; tool: string; failed: boolean };

export interface ReviewSnapshot {
  version: 1;
  observedAt: number;
  observedTurn: number;
  status: (typeof statuses)[number];
  assessment: (typeof assessments)[number];
  priority: number | null;
  summary: string;
  reason: string;
  evidence: Evidence[];
  steer: string | null;
  details: Record<string, Detail>;
  /** Higher sorts first. A missing value sorts last. */
  sortValue: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxTextLength;
}

function isChoice<const T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.some((option) => option === value);
}

export function reviewOutputProblems(settings: ReviewOutputSettings): string[] {
  const problems: string[] = [];
  if (settings.criteria !== undefined && !isText(settings.criteria)) problems.push("criteria must be nonempty and at most 500 characters");
  const fields = settings.fields ?? {};
  for (const [name, field] of Object.entries(fields)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(name) || Object.hasOwn(Object.prototype, name)) problems.push(`invalid field name '${name}'`);
    if (!isText(field.description)) problems.push(`field '${name}' needs a description of at most 500 characters`);
    if (!isChoice(field.type, ["number", "string", "boolean", "enum"])) problems.push(`invalid type for '${name}'`);
    if (
      field.type === "enum" &&
      (!Array.isArray(field.values) || field.values.length < 2 || !field.values.every(isText) || new Set(field.values).size !== field.values.length)
    ) {
      problems.push(`field '${name}' needs distinct enum values in low-to-high order`);
    }
  }
  if (settings.sort) {
    const field = Object.hasOwn(fields, settings.sort.field) ? fields[settings.sort.field] : undefined;
    if (field?.type !== "number" && field?.type !== "enum") problems.push("sort must refer to a number or enum field");
    if (!isChoice(settings.sort.direction, ["min", "max"])) problems.push("sort direction must be min or max");
  }
  return problems;
}

export function readReviewEvidence(forkPath: string): Evidence[] {
  return new JsonlFile<LogEntry>(forkPath)
    .readAll()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "tool" && entry.message.toolName
        ? [{ entryId: entry.id, tool: entry.message.toolName, failed: entry.message.isError === true }]
        : [],
    )
    .slice(-maxEvidence);
}

const ref = (index: number) => `E${index + 1}`;

export function reviewQuestion(settings: ReviewOutputSettings, evidence: readonly Evidence[]): string {
  const fields = Object.entries(settings.fields ?? {}).map(
    ([name, field]) => `${name}: ${field.type === "enum" ? field.values.join(" | ") : field.type}. ${field.description}`,
  );
  const references = evidence.map((item, index) => `${ref(index)}: ${item.tool}${item.failed ? " (error)" : ""}`);
  return [
    "This is a review by an outside reviewer. Stop working as the agent. Inspect the forked conversation and only read files if needed.",
    "Return one JSON object with exactly these keys: status, assessment, priority, summary, reason, evidenceRefs, steer, details.",
    `status: ${statuses.join(" | ")}. assessment: ${assessments.join(" | ")}.`,
    "priority: 0 for routine progress, 1 for a notable milestone, 2 for a blocker, 3 for an urgent issue, or null when evidence is insufficient.",
    "summary and reason: one concise sentence each, at most 500 characters. Do not include secrets, host details or absolute paths.",
    "evidenceRefs: choose up to two references from the listed recent tool results in chronological order. Cite only results that support the assessment. If there is insufficient evidence, use unknown status and assessment, null priority and steer, and an empty evidenceRefs array.",
    "steer: null when there is no new actionable advice, otherwise a short suggestion of at most 500 characters supported by the cited evidence.",
    `details: an object with optional task fields. ${fields.length ? fields.join("\n") : "Use {}."}`,
    ...(settings.criteria ? [`Task-specific criteria: ${settings.criteria}`] : []),
    `Available references:\n${references.join("\n") || "(none)"}`,
  ].join("\n");
}

function detailValue(value: unknown, field: Field): value is Detail {
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return isText(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return isChoice(value, field.values);
  }
}

function parseDetails(value: unknown, settings: ReviewOutputSettings): Record<string, Detail> {
  if (!isRecord(value)) throw new Error("details must be an object");
  const fields = settings.fields ?? {};
  const details: Record<string, Detail> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field || !detailValue(candidate, field)) throw new Error("invalid task detail");
    details[key] = candidate;
  }
  return details;
}

function sortValue(settings: ReviewOutputSettings, priority: number | null, details: Record<string, Detail>): number | null {
  if (!settings.sort) return priority;
  const value = details[settings.sort.field];
  const field = settings.fields?.[settings.sort.field];
  if (value === undefined || !field) return null;
  const order = field.type === "enum" ? field.values.indexOf(value as string) : (value as number);
  return settings.sort.direction === "min" ? -order : order;
}

const outputKeys = ["status", "assessment", "priority", "summary", "reason", "evidenceRefs", "steer", "details"];

export function parseReviewSnapshot(
  text: string,
  settings: ReviewOutputSettings,
  evidence: readonly Evidence[],
  observed: { observedAt: number; observedTurn: number },
): ReviewSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  } catch {
    throw new Error("expected one JSON object");
  }
  if (!isRecord(value) || Object.keys(value).length !== outputKeys.length || outputKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("unexpected review fields");
  }
  const { status, assessment, priority, summary, reason, evidenceRefs, steer, details } = value;
  if (!isChoice(status, statuses) || !isChoice(assessment, assessments)) throw new Error("invalid status or assessment");
  if (priority !== null && ![0, 1, 2, 3].some((level) => level === priority)) throw new Error("invalid priority");
  if (!isText(summary) || !isText(reason) || (steer !== null && !isText(steer))) throw new Error("invalid review text");
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 2 || new Set(evidenceRefs).size !== evidenceRefs.length) {
    throw new Error("invalid evidence references");
  }
  const chosen = evidenceRefs.map((key: unknown) => {
    const index = evidence.findIndex((_, index) => key === ref(index));
    const item = evidence[index];
    if (!item) throw new Error("unknown evidence reference");
    return item;
  });
  if (chosen.length === 0 && (status !== "unknown" || assessment !== "unknown" || priority !== null || steer !== null)) {
    throw new Error("review claims require evidence");
  }
  const checkedDetails = parseDetails(details, settings);
  if (chosen.length === 0 && Object.keys(checkedDetails).length > 0) throw new Error("task details require evidence");
  const checkedPriority = priority as number | null;
  return {
    version: 1,
    ...observed,
    status,
    assessment,
    priority: checkedPriority,
    summary,
    reason,
    evidence: chosen,
    steer: steer?.trim() ?? null,
    details: checkedDetails,
    sortValue: sortValue(settings, checkedPriority, checkedDetails),
  };
}
