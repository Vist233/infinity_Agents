import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { reviewPlugin } from "sakura-agent";

type Authorizer = NonNullable<Parameters<typeof reviewPlugin>[0]["authorizers"]>[number];

export interface GuardRulesOptions {
  /** The agent's own directory (`agents/NNN`): its work directory and its session. */
  agentDir: string;
  /** The run directory: everything in it that is not the agent's own is off limits. */
  runRoot: string;
  /** Shared read-only data inside the run directory: readable, never writable. */
  sharedDir: string;
  keeperDir: string;
  /** Where the hidden data lived before the run (it is moved away; a mention of the old place is still refused). */
  hiddenOriginals: string[];
  /** The evaluator's own files and anything else the agents must not read or change. */
  protectedPaths: string[];
}

const real = (path: string): string => {
  let probe = resolve(path);
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  return join(existsSync(probe) ? realpathSync(probe) : probe, ...tail);
};

const inside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory + sep);

// What no agent may run, whatever the reviewer model thinks (docs/05 section 6). Deliberately plain text patterns: a miss goes on to the reviewer model.
const FORBIDDEN_COMMANDS: Array<[RegExp, string]> = [
  [/\bgit\b[^|;&]*\bpush\b/, "pushing code to a remote"],
  [/\b(ssh|scp|sftp|ssh-add|ssh-keygen)\b/, "using ssh or scp"],
  [/\brsync\b[^|;&]*\S+:\S/, "copying files to or from another machine"],
  [/\b(pkill|killall)\b/, "killing processes by name (they may belong to others)"],
  [/\bkill\s+(-\w+\s+)*-1\b/, "killing every process"],
  [/\b(curl|wget)\b[^|;&]*(\s-T\b|\s-F\b|--upload-file|--form\b|--data-binary\s+@|--data-raw\s+@|\s-d\s+@|--data\s+@)/, "uploading a file"],
  [/\b(nc|ncat|netcat|socat)\b/, "opening a raw network connection"],
  [/(\.ssh\b|\.aws\b|\.netrc\b|\.gnupg\b|id_rsa|id_ed25519|\.git-credentials|\.config\/gcloud|\.docker\/config)/, "touching credential files"],
  [/\b(sudo|su)\s/, "gaining other rights"],
];

/**
 * The hard rules of code mode as an authorizer (asked after the framework's own hard rules and before the reviewer model). It only denies or passes on:
 * the keeper, the other agents' directories, the run's own files and the evaluator are off limits for every tool, and a few kinds of command never run.
 * It works on the text of the command and on the real path of a file tool's path (links followed); a shell can still build a path the text does not show,
 * and then the reviewer model is the next check. It is a guard against mistakes and plain attempts, not a lock (docs/06).
 */
export function createGuardRules(options: GuardRulesOptions): Authorizer {
  const own = real(options.agentDir);
  const root = real(options.runRoot);
  const shared = real(options.sharedDir);
  const keeper = real(options.keeperDir);
  const forbiddenPlaces = [keeper, ...options.hiddenOriginals.map(real), ...options.protectedPaths.map(real)];
  const otherAgent = /\bagents\/\d{3}\b/g;
  const ownName = own.slice(own.lastIndexOf("/") + 1);

  const placeOf = (path: string): string | undefined => {
    const actual = real(path);
    if (forbiddenPlaces.some((place) => inside(actual, place))) return "data or files that are hidden from the agents";
    if (inside(actual, root) && !inside(actual, own) && !inside(actual, shared))
      return "a place of the run that is not yours (other agents, the ledger, the state)";
    return undefined;
  };

  return {
    name: "infinity-rules",
    async review(call, { cwd }) {
      const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;
      // our own tool: the command is only written down (and scored from the committed files); nothing is run
      if (call.name === "submit") return { kind: "allow", reason: "the submit tool of this run" };
      if (call.name === "bash") {
        const command = typeof args.command === "string" ? args.command : "";
        for (const [pattern, what] of FORBIDDEN_COMMANDS)
          if (pattern.test(command)) return { kind: "deny", reason: `This command looks like ${what}. It is not allowed in this run.` };
        if (forbiddenPlaces.some((place) => command.includes(place)))
          return { kind: "deny", reason: "The command names data that is hidden from the agents. It is not allowed." };
        if (command.includes(root) && [...command.matchAll(otherAgent)].some((match) => !match[0].endsWith(ownName)))
          return { kind: "deny", reason: "The command names another agent's directory. It is not allowed." };
        for (const word of command.split(/[\s'"=:;|&<>()]+/)) {
          if (word === "" || !(isAbsolute(word) || word.startsWith("../") || word === "..")) continue;
          const place = placeOf(isAbsolute(word) ? word : resolve(cwd ?? options.agentDir, word));
          if (place) return { kind: "deny", reason: `The command reaches ${place}. It is not allowed.` };
        }
        return { kind: "pass" };
      }
      const path = typeof args.path === "string" ? args.path : undefined;
      if (path === undefined) return { kind: "pass" };
      const target = isAbsolute(path) ? path : resolve(cwd ?? options.agentDir, path);
      const place = placeOf(target);
      if (place) return { kind: "deny", reason: `That path is ${place}. It is not allowed.` };
      if (call.name !== "read" && inside(real(target), shared)) return { kind: "deny", reason: "The shared data is read-only." };
      // writing and editing inside the agent's own directory is what it is there for (the framework's allow list says the same)
      if ((call.name === "write" || call.name === "edit") && inside(real(target), own)) return { kind: "allow", reason: "inside the agent's own directory" };
      return { kind: "pass" };
    },
  };
}
