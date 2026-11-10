import type { Plugin } from "sakura-agent";
import { commitAll } from "./work-repo.ts";

export interface CommitPluginOptions {
  /** The agent's work directory (a Git repository). */
  dir: string;
  /** Called with the commit id after each commit. */
  onCommit?: (commit: string, turn: number) => void;
  /** Called when git fails. The agent is never stopped by it. */
  onError?: (error: unknown) => void;
}

export interface CommitPlugin extends Plugin {
  /** Resolves when every commit started so far has finished (call before reading the history or closing). */
  flush(): Promise<void>;
}

/**
 * Commits the work directory after every turn. It observes the `turn_end` event, so it runs from the orchestrator's side and
 * not through the agent's tools. Commits are queued one after another; a failing git is reported and ignored.
 */
export function commitPlugin(options: CommitPluginOptions): CommitPlugin {
  let turn = 0;
  let queue: Promise<void> = Promise.resolve();

  const commitTurn = async (turnNumber: number) => {
    try {
      const commit = await commitAll(options.dir, `turn ${turnNumber}`);
      if (commit !== undefined) options.onCommit?.(commit, turnNumber);
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    name: "infinity-commit",
    setup(api) {
      api.on("event", (event) => {
        if (event.type !== "turn_end") return;
        turn += 1;
        const turnNumber = turn;
        queue = queue.then(() => commitTurn(turnNumber));
      });
    },
    flush: () => queue,
  };
}
