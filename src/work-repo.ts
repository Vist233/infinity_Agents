import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_IDENTITY = ["-c", "user.name=infinity-agent", "-c", "user.email=agent@infinity.invalid", "-c", "commit.gpgsign=false"];

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_IDENTITY, ...args], { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Makes `dir` a Git repository on branch main (safe to call again). */
export async function initWorkRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "--initial-branch=main"]);
}

/** Commits everything in `dir`. Returns the new commit id, or undefined when nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | undefined> {
  await git(dir, ["add", "--all"]);
  const changes = await git(dir, ["status", "--porcelain"]);
  if (changes === "") return undefined;
  await git(dir, ["commit", "--quiet", "--message", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** The id of the current commit, or undefined when the repository has none yet. */
export async function headCommit(dir: string): Promise<string | undefined> {
  try {
    return await git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}
