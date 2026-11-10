import type { Tool, ToolContext, ToolResult } from "sakura-agent";
import type { Submission } from "./mode.ts";

export type { Submission } from "./mode.ts";
import type { Verifier } from "./verifier.ts";

export interface LeanToolOptions {
  verifier: Verifier;
  /** Called for every official submit, before the agent sees the answer (so a marker written here exists by then). */
  onSubmit: (submission: Submission) => Promise<void>;
}

const DEFAULT_FILE = "Proof.lean";

const text = (message: string, isError = false): ToolResult => ({ content: [{ type: "text", text: message }], ...(isError ? { isError } : {}) });

/**
 * The agent's one way to run Lean. `check` compiles a file and shows Lean's messages (free to use, as often as wanted).
 * `submit` is the official call: the verifier decides whether the file proves `Statement.Goal`.
 */
export function createLeanTool(options: LeanToolOptions): Tool {
  return {
    name: "lean",
    description:
      "Runs Lean 4 on a proof file in your working directory. action 'check': compile the file and show Lean's messages (use it freely while you work). " +
      "action 'submit': the official submission; answers 'proved' only when the file compiles, has no sorry, uses only the standard axioms and " +
      "'theorem main : Statement.Goal' has exactly that type. The file starts with 'import Statement'.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "submit"] },
        file: { type: "string", description: `Path of the proof file, default ${DEFAULT_FILE}` },
      },
      required: ["action"],
      additionalProperties: false,
    },
    effect: "exec",
    executionMode: "serial",
    async execute(args, context) {
      const { action, file } = parseArgs(args);
      if (action === undefined) return text("The 'action' must be 'check' or 'submit'.", true);
      const source = await readSource(file, context);
      if (source === undefined) return text(`Cannot read '${file}'. Write the proof file first.`, true);
      if (action === "check") return text(await options.verifier.check(source, context.signal));
      const verdict = await options.verifier.verify(source, context.signal);
      await options.onSubmit({ code: source, verdict });
      return text(verdict.proved ? "proved: the proof is accepted." : `Not accepted: ${verdict.reason}`);
    },
  };
}

function parseArgs(args: unknown): { action: "check" | "submit" | undefined; file: string } {
  const value = (args ?? {}) as { action?: unknown; file?: unknown };
  const action = value.action === "check" || value.action === "submit" ? value.action : undefined;
  return { action, file: typeof value.file === "string" && value.file !== "" ? value.file : DEFAULT_FILE };
}

async function readSource(file: string, context: ToolContext): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await context.env.readFile(file));
  } catch {
    return undefined;
  }
}
