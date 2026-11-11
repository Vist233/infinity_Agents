import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** What a work directory starts with. */
export interface WorkDirContents {
  /** Name -> content; put in read-only. */
  files: Record<string, string>;
  /** Name -> absolute target of a symbolic link; kept out of Git. */
  links?: Record<string, string> | undefined;
  /** More lines for `.gitignore`. */
  gitignore?: string[] | undefined;
}

/** Creates the work directory as a Git repository holding read-only copies of the given files, and commits them as "start". Safe to repeat on resume. */
export async function createWorkDir(workDir: string, contents: WorkDirContents): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  if (existsSync(join(workDir, ".git"))) return;
  for (const [name, content] of Object.entries(contents.files)) {
    const path = join(workDir, name);
    writeFileSync(path, content);
    chmodSync(path, 0o444);
  }
  for (const [name, target] of Object.entries(contents.links ?? {})) symlinkSync(target, join(workDir, name));
  const ignored = [...Object.keys(contents.links ?? {}), ...(contents.gitignore ?? [])];
  if (ignored.length > 0) writeFileSync(join(workDir, ".gitignore"), `${ignored.join("\n")}\n`);
  await initWorkRepo(workDir);
  await commitAll(workDir, "start");
}
