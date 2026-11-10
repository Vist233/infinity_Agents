import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LeanRunResult, LeanRunner } from "./lean-runner.ts";

export interface Verdict {
  proved: boolean;
  reason: string;
}

export interface Verifier {
  /** Compiles the file and returns the messages Lean prints (what the agent sees). Free to use. */
  check(source: string, signal?: AbortSignal): Promise<string>;
  /** The official judgement. */
  verify(source: string, signal?: AbortSignal): Promise<Verdict>;
}

export interface VerifierOptions {
  runner: LeanRunner;
  /** A private directory of the run: the compiled `Statement` module and the scratch directories live here. */
  leanDir: string;
  /** The proposition to prove, as Lean source of a `Prop`, for example `∀ n : Nat, n % 2 = 0 ∨ n % 2 = 1`. */
  statement: string;
  checkTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /** For tests: a fixed nonce. */
  newNonce?: () => string;
}

export const ALLOWED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];

/** `Statement.Goal` is the statement every proof must have as the type of its theorem `main`. */
export function statementSource(statement: string): string {
  return `namespace Statement\nabbrev Goal : Prop := ${statement}\nend Statement\n`;
}

/**
 * Constructs that make Lean run code at compile time or import more than the statement. A proof does not need them,
 * and they are the ways a file could fake the verifier's report. This is defence in depth, not a boundary: without the optional sandbox of the runner a proof file runs with the user's rights.
 */
const FORBIDDEN =
  /\b(initialize|builtin_initialize|run_cmd|run_elab|run_meta|elab|elab_rules|macro|macro_rules|syntax|declare_syntax_cat|unsafe|implemented_by|extern|export|prelude)\b|#eval|#exit/;
const IMPORT_LINE = /^\s*import\s+(\S+)/gm;

export function forbiddenConstruct(source: string): string | undefined {
  const match = FORBIDDEN.exec(source);
  if (match) return `the construct '${match[0]}' is not allowed in a proof file`;
  for (const [, module] of source.matchAll(IMPORT_LINE)) if (module !== "Statement") return `only 'import Statement' is allowed, found 'import ${module}'`;
  return undefined;
}

const NO_OUTPUT = "No errors or warnings.";
const trimOutput = (text: string, limit = 3000): string => (text.length > limit ? `${text.slice(0, limit)}\n... (cut)` : text);

/** Compiles `Statement` once (it fails here, loudly, if the statement itself is not valid Lean) and returns the verifier. */
export async function createVerifier(options: VerifierOptions): Promise<Verifier> {
  const { runner, leanDir } = options;
  const checkTimeoutMs = options.checkTimeoutMs ?? 120_000;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 180_000;
  const newNonce = options.newNonce ?? (() => randomBytes(12).toString("hex"));
  mkdirSync(leanDir, { recursive: true });
  await compileStatement(runner, leanDir, options.statement, verifyTimeoutMs);

  const inScratch = async <T>(work: (scratch: string) => Promise<T>): Promise<T> => {
    const scratch = mkdtempSync(join(leanDir, "scratch-"));
    try {
      return await work(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  return {
    check: (source, signal) =>
      inScratch(async (scratch) => {
        writeFileSync(join(scratch, "Proof.lean"), source);
        const result = await runLean(["Proof.lean"], scratch, checkTimeoutMs, signal);
        return describeCheck(result, checkTimeoutMs);
      }),
    verify: (source, signal) =>
      inScratch(async (scratch) => {
        const forbidden = forbiddenConstruct(source);
        if (forbidden) return { proved: false, reason: forbidden };
        writeFileSync(join(scratch, "Proof.lean"), source);
        const compiled = await runLean(["-o", "Proof.olean", "Proof.lean"], scratch, verifyTimeoutMs, signal);
        if (compiled.timedOut || compiled.exitCode !== 0) return { proved: false, reason: `does not compile:\n${describeCheck(compiled, verifyTimeoutMs)}` };
        const nonce = newNonce();
        writeFileSync(join(scratch, "Check.lean"), checkSource(nonce));
        const report = await runLean(["Check.lean"], scratch, verifyTimeoutMs, signal);
        return judge(report, nonce);
      }),
  };

  function runLean(args: string[], scratch: string, timeoutMs: number, signal?: AbortSignal): Promise<LeanRunResult> {
    return runner.run({ cwd: scratch, args, leanPath: [leanDir, scratch], writableDirs: [scratch], timeoutMs, ...(signal ? { signal } : {}) });
  }
}

async function compileStatement(runner: LeanRunner, leanDir: string, statement: string, timeoutMs: number): Promise<void> {
  writeFileSync(join(leanDir, "Statement.lean"), statementSource(statement));
  const result = await runner.run({ cwd: leanDir, args: ["-o", "Statement.olean", "Statement.lean"], leanPath: [leanDir], writableDirs: [leanDir], timeoutMs });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`The statement does not compile:\n${trimOutput(result.output)}`);
}

function describeCheck(result: LeanRunResult, timeoutMs: number): string {
  if (result.timedOut) return `Lean was stopped after ${Math.round(timeoutMs / 1000)} seconds.`;
  const text = result.output.trim();
  return text === "" ? NO_OUTPUT : trimOutput(text);
}

/**
 * The check runs in a second Lean process, in a file written by the verifier, that imports the compiled proof and asks the environment:
 * the theorem `main` exists, its type is exactly the constant `Statement.Goal`, and it depends on no axioms outside the standard three
 * (`sorry` is the axiom `sorryAx`, a custom axiom is an axiom, `native_decide` is `Lean.ofReduceBool`). The report carries a random nonce.
 */
function checkSource(nonce: string): string {
  return `import Lean
import Statement
import Proof
open Lean in
#eval show CoreM Unit from do
  let env ← getEnv
  match env.find? \`main with
  | none => IO.println "${nonce}|missing"
  | some info =>
    let sameType := info.type == mkConst \`\`Statement.Goal
    let isTheorem := match info with | .thmInfo _ => true | _ => false
    let axioms ← collectAxioms \`main
    IO.println s!"${nonce}|ok|{sameType}|{isTheorem}|{String.intercalate ";" (axioms.toList.map toString)}"
`;
}

function judge(report: LeanRunResult, nonce: string): Verdict {
  const line = report.output.split("\n").find((candidate) => candidate.startsWith(`${nonce}|`));
  if (!line) return { proved: false, reason: `the verification did not report:\n${describeCheck(report, 0)}` };
  const [, status, sameType, isTheorem, axiomList] = line.split("|");
  if (status === "missing")
    return { proved: false, reason: "there is no theorem named 'main' at the top level (a theorem declared inside a namespace gets a longer name)" };
  if (sameType !== "true") return { proved: false, reason: "'main' does not have exactly the type Statement.Goal" };
  if (isTheorem !== "true") return { proved: false, reason: "'main' must be a theorem" };
  const extra = (axiomList ?? "").split(";").filter((axiom) => axiom !== "" && !ALLOWED_AXIOMS.includes(axiom));
  if (extra.length > 0) return { proved: false, reason: `the proof depends on axioms that are not allowed: ${extra.join(", ")}` };
  return { proved: true, reason: "proved" };
}
