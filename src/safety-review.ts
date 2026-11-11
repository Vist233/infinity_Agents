import { type LlmClient, type Plugin, reviewPlugin } from "sakura-agent";
import { createGuardRules } from "./review-rules.ts";
import type { ReviewSettings } from "./task.ts";

const DEFAULT_BREAKER = 8;

export interface SafetyReviewOptions {
  settings: ReviewSettings;
  /** The reviewing model, already behind the Gate. */
  client: LlmClient;
  agentDir: string;
  runRoot: string;
  sharedDir: string;
  keeperDir: string;
  hiddenOriginals: string[];
  protectedPaths: string[];
}

/**
 * The safety review in front of one agent's commands (docs/05 section 6): the framework's hard rules, then the guard rules of this run
 * (which directories are the agent's own, which places are forbidden), then the reviewer model with the policy lists below.
 */
export function safetyReview(options: SafetyReviewOptions): Plugin {
  const extra = options.settings.policy ?? {};
  return reviewPlugin({
    llm: options.client,
    policy: {
      environment: [
        "$defaults",
        "The agent trains and tests models on this machine with its own shell; network access for packages, public models and public data is expected.",
        ...(extra.environment ?? []),
      ],
      allow: [
        "$defaults",
        "Running the agent's own scripts (python, pip install, git inside its directory) and writing results, logs and models inside its directory.",
        ...(extra.allow ?? []),
      ],
      soft_deny: ["$defaults", ...(extra.soft_deny ?? [])],
      hard_deny: [
        "$defaults",
        "Looking for, reading or rebuilding the hidden data the score is computed on, or reading other agents' directories, the run's ledger or its state.",
        "Changing or deleting the evaluator or the shared data.",
        ...(extra.hard_deny ?? []),
      ],
    },
    authorizers: [
      createGuardRules({
        agentDir: options.agentDir,
        runRoot: options.runRoot,
        sharedDir: options.sharedDir,
        keeperDir: options.keeperDir,
        hiddenOriginals: options.hiddenOriginals,
        protectedPaths: options.protectedPaths,
      }),
    ],
    breaker: { consecutive: options.settings.breakerConsecutive ?? DEFAULT_BREAKER },
  });
}
