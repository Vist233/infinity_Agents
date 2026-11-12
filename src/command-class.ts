/** Which shell commands are cheap and which are heavy (docs/16 section C, docs/18): the table and the classifier, with nothing else in the file. */

// Commands that cannot hold a CPU for long. Not "read only" in the strict sense: making a directory or committing is cheap and must not wait behind a training job.
const LIGHT = new Set([
  ...["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "pwd", "echo", "printf", "sleep", "true", "false", "test", "[", "cd", "stat", "file"],
  ...["du", "df", "which", "type", "date", "env", "printenv", "basename", "dirname", "realpath", "readlink", "sort", "uniq", "cut", "tr", "diff", "cmp", "nl"],
  ...["mkdir", "touch", "cp", "mv", "rm", "ln", "chmod", "tee", "export", "set", "unset", "wait", "nproc", "uname", "id", "whoami", "ps", "kill", "tree"],
]);
const LIGHT_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "add",
  "commit",
  "init",
  "config",
  "checkout",
  "tag",
  "stash",
  "restore",
  "reset",
]);

/** True when every part of the command is a cheap one. Anything with a command substitution, an unknown program, a script or an interpreter counts as heavy. */
export function isLightCommand(command: string): boolean {
  if (command.includes("$(") || command.includes("`")) return false;
  const parts = command.split(/;|&&|\|\||\||\n|&/).map((part) => part.trim().replace(/^[({]+\s*/, ""));
  let any = false;
  for (const part of parts) {
    if (part === "") continue;
    const words = part.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const program = (words[0] ?? "").split("/").pop() ?? "";
    if (program === "") continue; // only assignments
    any = true;
    if (program === "git") {
      if (!LIGHT_GIT.has(words.find((word, index) => index > 0 && !word.startsWith("-")) ?? "")) return false;
      continue;
    }
    if (program === "sed" || program === "awk") {
      if (words.some((word) => /^-i/.test(word) || word === "--in-place")) return false;
      continue;
    }
    if (program === "find") {
      if (words.some((word) => ["-exec", "-execdir", "-delete", "-ok"].includes(word))) return false;
      continue;
    }
    if (!LIGHT.has(program)) return false;
  }
  return any;
}
