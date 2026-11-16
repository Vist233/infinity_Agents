import { isAbsolute, resolve } from "node:path";
import { type TaskProfile, cpuOf, profileProblems } from "./capacity.ts";
import { type Evaluator, commandEvaluator } from "./evaluation.ts";
import type { TaskPackage } from "./launch.ts";
import { type BranchReviewSettings, type Direction, type ReviewSettings, defineTask } from "./task.ts";

/**
 * A task as a form: plain data a person or an Agent can write in a TypeScript file (`export default defineForm({...})`) or a JSON file, and that the loader
 * turns into a task package. A form is about the task only; what the machine can carry (agents, slots, threads) is the machine file (machine-config.ts).
 * Paths are relative to the folder of the form file.
 */
export interface TaskForm {
  /** Which set of tools and rules the agents get: `code` (shell, `submit`, your evaluator) or `math` (file tools and a Lean check). */
  preset: "code" | "math";
  /** A short name, used in the report and by `infinity run <name>`. */
  name: string;
  /** One line for `--help` and for an Agent that chooses a task. */
  summary?: string;
  /** code: the problem in words (required). math: extra words for the agents. */
  prompt?: string;
  /** math: the proposition to prove, as the Lean source of a Prop (required). */
  statement?: string;
  /** code: name in every work directory -> folder or file; copied once, read-only. */
  data?: Record<string, string>;
  /** code: taken away from the disk while the agents run; the evaluator reads them through INFINITY_HIDDEN_0, INFINITY_HIDDEN_1, ... */
  hidden?: readonly string[];
  /** code: how a submit is scored. A program (run by `run`, such as `python3`, when given) that prints a JSON line, or a function (TypeScript forms only). */
  evaluate?: { program: string; run?: string; args?: readonly string[]; timeoutMinutes?: number } | Evaluator;
  /** code: which number ranks (required with `evaluate`). */
  metric?: { name: string; direction: Direction };
  /** When the run ends by itself. Default: code `until-stopped`, math `first-success`. */
  stop?: "first-success" | "until-stopped" | { targetScore: number };
  /** code: the safety review of the agents' commands; default on with the standard rules, `false` switches it off. */
  review?: false | ReviewSettings;
  /** code: the branch review is chosen when the run starts (`--no-review`, `--review-minutes`); this only extends it. */
  branchReview?: BranchReviewSettings;
  tokens?: number;
  wallMinutes?: number;
  /** What one heavy command needs; the machine recommendation reads it. */
  profile?: TaskProfile;
  evalSlots?: number;
  submitIntervalMinutes?: number;
  evalTimeoutMinutes?: number;
  /** math: Lean processes at once; confine Lean with the macOS sandbox. */
  leanPool?: number;
  sandbox?: boolean;
  stuckMinutes?: number;
}

const KEYS = [
  "preset",
  "name",
  "summary",
  "prompt",
  "statement",
  "data",
  "hidden",
  "evaluate",
  "metric",
  "stop",
  "review",
  "branchReview",
  "tokens",
  "wallMinutes",
  "profile",
  "evalSlots",
  "submitIntervalMinutes",
  "evalTimeoutMinutes",
  "leanPool",
  "sandbox",
  "stuckMinutes",
];
const CODE_ONLY = ["data", "hidden", "evaluate", "metric", "review", "branchReview", "evalSlots", "submitIntervalMinutes", "evalTimeoutMinutes"];
const MATH_ONLY = ["statement", "leanPool", "sandbox"];

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What is wrong with something that should be a form, as words (empty when it is fine). Works on parsed JSON as well as on a TypeScript object. */
export function formProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["a form must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) problems.push(`unknown field '${key}' (fields: ${KEYS.join(", ")})`);
  if (raw.preset !== "code" && raw.preset !== "math") problems.push("preset must be 'code' or 'math'");
  if (!isText(raw.name)) problems.push("name is required");
  const preset = raw.preset;
  if (preset === "code") {
    if (!isText(raw.prompt)) problems.push("prompt is required for the code preset: say what the agents are to do");
    for (const key of MATH_ONLY) if (raw[key] !== undefined) problems.push(`'${key}' belongs to the math preset`);
    if (raw.stop === "first-success") problems.push("stop 'first-success' belongs to the math preset");
  }
  if (preset === "math") {
    if (!isText(raw.statement)) problems.push("statement is required for the math preset");
    for (const key of CODE_ONLY) if (raw[key] !== undefined) problems.push(`'${key}' belongs to the code preset`);
    if (isRecord(raw.stop)) problems.push("a target score belongs to the code preset");
    if (raw.stop === "until-stopped") problems.push("a math task stops at the first accepted proof: leave out stop");
  }
  const evaluate = raw.evaluate;
  if (evaluate !== undefined && typeof evaluate !== "function") {
    if (!isRecord(evaluate) || !isText(evaluate.program)) problems.push("evaluate must be a function or { program, run?, args?, timeoutMinutes? }");
    else {
      for (const key of Object.keys(evaluate))
        if (!["program", "run", "args", "timeoutMinutes"].includes(key)) problems.push(`evaluate: unknown field '${key}'`);
      if (evaluate.run !== undefined && !isText(evaluate.run)) problems.push("evaluate.run must be a program name such as 'python3'");
      if (evaluate.args !== undefined && !(Array.isArray(evaluate.args) && evaluate.args.every((item) => typeof item === "string")))
        problems.push("evaluate.args must be a list of text");
    }
  }
  const metric = raw.metric;
  if (metric !== undefined && !(isRecord(metric) && isText(metric.name) && (metric.direction === "max" || metric.direction === "min")))
    problems.push("metric must be { name, direction: 'max' | 'min' }");
  if (evaluate !== undefined && metric === undefined) problems.push("metric is required with evaluate");
  if (metric !== undefined && evaluate === undefined) problems.push("metric needs an evaluate");
  const stop = raw.stop;
  if (isRecord(stop) && !(Object.keys(stop).length === 1 && typeof stop.targetScore === "number" && Number.isFinite(stop.targetScore)))
    problems.push("stop must be 'until-stopped', 'first-success' or { targetScore: number }");
  if (isRecord(stop) && metric === undefined) problems.push("stop.targetScore needs a metric");
  if (raw.data !== undefined && !(isRecord(raw.data) && Object.values(raw.data).every(isText))) problems.push("data must map a name to a path");
  if (raw.hidden !== undefined && !(Array.isArray(raw.hidden) && raw.hidden.every(isText))) problems.push("hidden must be a list of paths");
  if (isRecord(raw.profile)) problems.push(...profileProblems(raw.profile as TaskProfile));
  for (const key of ["tokens", "wallMinutes", "evalSlots", "evalTimeoutMinutes", "leanPool", "stuckMinutes"])
    if (raw[key] !== undefined && !(typeof raw[key] === "number" && (raw[key] as number) > 0)) problems.push(`${key} must be a number above 0`);
  if (raw.submitIntervalMinutes !== undefined && !(typeof raw.submitIntervalMinutes === "number" && raw.submitIntervalMinutes >= 0))
    problems.push("submitIntervalMinutes must not be negative");
  return problems;
}

/** For TypeScript forms: checks the form at once, with every problem named, and returns it. */
export function defineForm(form: TaskForm): TaskForm {
  const problems = formProblems(form);
  if (problems.length > 0) throw new Error(`Invalid form '${(form as { name?: string }).name ?? "?"}': ${problems.join("; ")}`);
  return form;
}

/** Is this module export a form (and not already a task package)? */
export const looksLikeForm = (value: unknown): boolean => isRecord(value) && typeof value.preset === "string" && typeof value.build !== "function";

/** The task package of a form. `baseDir` is the folder of the form file: relative paths in the form are relative to it. */
export function formPackage(form: TaskForm, baseDir: string): TaskPackage {
  const problems = formProblems(form);
  if (problems.length > 0) throw new Error(`Invalid form '${form.name}': ${problems.join("; ")}`);
  const path = (value: string) => (isAbsolute(value) ? value : resolve(baseDir, value));
  const summary = form.summary ?? (form.preset === "math" ? `Prove "${form.statement}" in Lean 4` : (form.prompt ?? "").slice(0, 100));
  const defaults = {
    ...(form.tokens === undefined ? {} : { tokens: form.tokens }),
    ...(form.wallMinutes === undefined ? {} : { wallMinutes: form.wallMinutes }),
  };
  return {
    name: form.name,
    summary,
    ...(form.profile ? { profile: form.profile } : {}),
    defaults,
    build({ agents, profile, model, tokens, branchReview, commandMinutes, runsDir }) {
      const common = {
        name: form.name,
        agents,
        model,
        ...(tokens === undefined ? {} : { tokens }),
        ...(form.stuckMinutes === undefined ? {} : { stuckMinutes: form.stuckMinutes }),
        runsDir,
      };
      if (form.preset === "math")
        return defineTask({
          ...common,
          tools: {
            kind: "lean",
            statement: form.statement as string,
            ...(form.leanPool === undefined ? {} : { leanPool: form.leanPool }),
            sandbox: form.sandbox ?? false,
          },
          ...(form.prompt === undefined ? {} : { prompt: form.prompt }),
        });
      const program = typeof form.evaluate === "object" ? path(form.evaluate.program) : undefined;
      const evaluate =
        typeof form.evaluate === "function"
          ? form.evaluate
          : form.evaluate && program
            ? commandEvaluator({
                file: form.evaluate.run ?? program,
                args: form.evaluate.run ? [program, ...(form.evaluate.args ?? [])] : [...(form.evaluate.args ?? [])],
                timeoutMs: (form.evaluate.timeoutMinutes ?? 5) * 60_000,
              })
            : undefined;
      const prompt = withMachineLimits(form.prompt as string, profile);
      return defineTask({
        ...common,
        tools: { kind: "shell" },
        prompt,
        ...(form.data ? { files: Object.fromEntries(Object.entries(form.data).map(([name, value]) => [name, path(value)])) } : {}),
        ...(form.hidden ? { hidden: form.hidden.map(path) } : {}),
        ...(program ? { protect: [program] } : {}),
        ...(evaluate ? { evaluate } : {}),
        ...(form.metric ? { metric: form.metric } : {}),
        review: form.review ?? {},
        ...(branchReview ? { branchReview: { ...branchReview, ...form.branchReview } } : {}),
        profile,
        stop: typeof form.stop === "object" ? form.stop : "until-stopped",
        ...(form.evalSlots === undefined ? {} : { evalSlots: form.evalSlots }),
        ...(form.submitIntervalMinutes === undefined ? {} : { submitIntervalMinutes: form.submitIntervalMinutes }),
        ...(form.evalTimeoutMinutes === undefined ? {} : { evalTimeoutMinutes: form.evalTimeoutMinutes }),
        ...(commandMinutes === undefined ? {} : { commandTimeoutMinutes: commandMinutes }),
      });
    },
  };
}

/** The machine is shared by many agents: the prompt says how much one command may use (the numbers come from the profile and the machine file). */
function withMachineLimits(prompt: string, profile: TaskProfile): string {
  const cpu = cpuOf(profile);
  return `${prompt}\n\nThe machine is shared by many agents: use at most ${cpu.threadsPerJob} threads per process and about ${cpu.memPerJobGb} GB of memory per process.`;
}
