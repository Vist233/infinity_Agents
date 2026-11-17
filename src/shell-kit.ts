import { resolve } from "node:path";
import type { LlmClient } from "sakura-agent";
import type { Clock } from "./clock.ts";
import type { AgentSetup, Kit } from "./mode.ts";
import { CODE_GOAL_OBJECTIVE, codePrompt, codeRules, strategyRule } from "./prompts.ts";
import type { RunLayout } from "./run-layout.ts";
import { safetyReview } from "./safety-review.ts";
import { type SlotGate, commandLimits } from "./slot-gate.ts";
import { JsonlFile } from "./jsonl.ts";
import type { LedgerEntry } from "./records.ts";
import { runNotesPlugin } from "./run-notes.ts";
import { createSubmitTool } from "./submit-tool.ts";
import type { TaskDefinition } from "./task.ts";

/** Large binary results are not worth keeping in every agent's Git history. */
const GITIGNORE = [
  "cache/",
  "__pycache__/",
  "*.pyc",
  "*.pt",
  "*.pth",
  "*.ckpt",
  "*.npy",
  "*.npz",
  "*.pkl",
  "*.joblib",
  "*.safetensors",
  "*.onnx",
  ".venv/",
  "wandb/",
];
export const DEFAULT_COMMAND_TIMEOUT_MINUTES = 120;
/** The shell tool's own interrupt, set beyond reach: the command limits (commandTimeoutMinutes) stop a command instead. The largest value a timer takes, less room for a `sleep N`. */
const NEVER_BACKGROUND_MS = 2_000_000_000;

export interface ShellKitOptions {
  task: TaskDefinition;
  layout: RunLayout;
  clock: Clock;
  /** The model that reviews the agents' commands; used when the task has review settings. */
  reviewClient: LlmClient;
  /** Heavy commands wait here for a slot (docs/16 section C); without it they run at once. */
  gate?: SlotGate | undefined;
}

/** Agents with a shell (`read`, `write`, `edit`, `bash`) and the `submit` tool, behind the safety review and the limits on commands (docs/05). */
export function shellKit(options: ShellKitOptions): Kit {
  const { task, clock } = options;
  const intervalMinutes = task.submitIntervalMinutes ?? 0;
  return {
    plannerKind: "code",
    plannerSubject: task.prompt ?? "",
    async prepare() {},
    warnings() {
      const warnings: string[] = [];
      if (task.review === false) warnings.push("The safety review is OFF: the agents' shell commands run unchecked, with your rights.");
      if (!task.evaluate) warnings.push("There is no evaluator: the ranking uses the agents' own claims (self-reported).");
      return warnings;
    },
    agentSetup({ hint, agent, links, score }) {
      // a resumed agent keeps the submits it made before
      const submitsBefore = new JsonlFile<LedgerEntry>(options.layout.ledger)
        .readAll()
        .filter((entry) => entry.type === "result" && entry.agent === agent).length;
      const notes = runNotesPlugin({
        workDir: options.layout.workDir(agent),
        submitsBefore,
        ...(task.workDirGb === undefined ? {} : { workDirGb: task.workDirGb }),
        now: () => clock.now(),
      });
      return {
        prompt: codePrompt(task.prompt ?? ""),
        rules: [
          ...codeRules({
            hasEvaluator: task.evaluate !== undefined,
            metricName: task.metric?.name,
            dataNames: Object.keys(links),
            submitIntervalMinutes: intervalMinutes,
          }),
          strategyRule(hint),
        ],
        goalObjective: CODE_GOAL_OBJECTIVE,
        files: {},
        gitignore: GITIGNORE,
        builtinTools: ["read", "write", "edit", "bash"],
        confine: false,
        bashSoftTimeoutMs: NEVER_BACKGROUND_MS,
        plugins: [
          notes,
          commandLimits({ gate: options.gate, wallMinutes: task.commandTimeoutMinutes ?? DEFAULT_COMMAND_TIMEOUT_MINUTES, agent }),
          ...reviewPlugins(options, agent),
        ],
        tools: (submit, helpers) => [
          createSubmitTool({
            helpers,
            onSubmit: async (...args: Parameters<typeof submit>) => {
              const outcome = await submit(...args);
              notes.submitted();
              return outcome;
            },
            metricName: task.metric?.name,
            direction: task.metric?.direction ?? "max",
            minIntervalMs: intervalMinutes * 60_000,
            now: () => clock.now(),
            evaluate: score,
          }),
        ],
      } satisfies Omit<AgentSetup, "goal" | "links"> & { goalObjective: string };
    },
  };
}

/** One safety-review plugin per agent: its rules know which directory is the agent's own. The reviewer model is shared and goes through the Gate. */
function reviewPlugins(options: ShellKitOptions, agent: number): NonNullable<AgentSetup["plugins"]> {
  const { task, layout } = options;
  if (task.review === false || task.review === undefined) return [];
  return [
    safetyReview({
      settings: task.review,
      client: options.reviewClient,
      agentDir: layout.agentDir(agent),
      runRoot: layout.root,
      sharedDir: layout.sharedDir,
      keeperDir: layout.keeperDir,
      hiddenOriginals: (task.hidden ?? []).map((path) => resolve(path)),
      protectedPaths: task.protect ?? [],
    }),
  ];
}
