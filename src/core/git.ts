import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface GitOptions {
  cwd: string;
  /** Allow git to prompt on the terminal. Off by default so we never hang. */
  interactive?: boolean;
  timeoutMs?: number;
}

const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

/**
 * Run git and never throw.
 *
 * Every caller wants to inspect the failure rather than unwind, so the exit
 * status is returned as data. Terminal prompting is disabled by default: a sync
 * that silently blocks on a hidden credential prompt is far worse than one that
 * fails fast with an actionable message.
 */
export function git(args: string[], options: GitOptions): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: options.timeoutMs ?? 0,
      env: options.interactive ? process.env : { ...process.env, ...NO_PROMPT_ENV },
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
      code: typeof e.status === "number" ? e.status : null,
    };
  }
}

export async function gitAsync(args: string[], options: GitOptions): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: options.interactive ? process.env : { ...process.env, ...NO_PROMPT_ENV },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

export function isGitRepo(dir: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], { cwd: dir }).stdout === "true";
}

export function firstLine(text: string): string {
  return (
    String(text ?? "")
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

const AUTH_FAILURE = new RegExp(
  [
    "Authentication failed",
    "could not read Username",
    "terminal prompts disabled",
    "Repository not found",
    "Permission denied",
    "access denied",
    "\\b401\\b",
    "\\b403\\b",
  ].join("|"),
  "i",
);

/** True when a git failure is really "your GitHub credentials are not working". */
export function isAuthFailure(result: GitResult): boolean {
  return AUTH_FAILURE.test(`${result.stderr}\n${result.stdout}`);
}

export class GitAuthError extends Error {
  constructor(
    operation: string,
    readonly result: GitResult,
  ) {
    super(
      `${operation} failed: GitHub credentials are missing or lack access.\n` +
        `Run: gh auth login -h github.com  (the token needs the "repo" scope for private repositories)`,
    );
    this.name = "GitAuthError";
  }
}

export class GitError extends Error {
  constructor(
    operation: string,
    readonly result: GitResult,
  ) {
    super(
      `${operation} failed: ${firstLine(result.stderr || result.stdout) || "unknown git error"}`,
    );
    this.name = "GitError";
  }
}

/** Convert a failed `GitResult` into the most specific error we can. */
export function toGitError(operation: string, result: GitResult): Error {
  return isAuthFailure(result)
    ? new GitAuthError(operation, result)
    : new GitError(operation, result);
}

/**
 * Extract the file paths from `git status --porcelain` output.
 *
 * The format is fixed-width — two status columns, a space, then the path — but
 * this deliberately does not slice at a fixed offset. Output here is trimmed
 * before parsing, which eats the leading space of an unstaged entry (` M file`)
 * and shifts every subsequent column. Matching the status field by pattern
 * instead survives that, as well as the quoting git applies to paths with
 * unusual characters.
 *
 * Renames appear as `old -> new`; the destination is reported, since that is
 * what exists afterwards.
 */
export function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of String(output ?? "").split("\n")) {
    if (!line.trim()) continue;
    const withoutStatus = line.replace(/^\s*[MADRCU?!]{1,2}\s+/, "");
    if (withoutStatus === line.trim() && !/^\s*[MADRCU?!]/.test(line)) continue;
    const arrow = withoutStatus.lastIndexOf(" -> ");
    const raw = arrow === -1 ? withoutStatus : withoutStatus.slice(arrow + 4);
    const unquoted = raw.trim().replace(/^"(.*)"$/, "$1");
    if (unquoted) paths.push(unquoted);
  }
  return paths;
}

export interface NameStatusEntry {
  kind: "added" | "modified" | "deleted" | "renamed";
  path: string;
}

const STATUS_MAP: Record<string, NameStatusEntry["kind"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/**
 * Parse `git diff --name-status` output.
 *
 * Rename entries carry three tab-separated fields (`R100  old  new`); we report
 * the destination path because that is what exists after the operation.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of String(output ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusChar = (parts[0] ?? "").charAt(0).toUpperCase();
    const kind = STATUS_MAP[statusChar];
    if (!kind) continue;
    const filePath = parts.length > 2 ? parts.slice(2).join("\t").trim() : (parts[1] ?? "").trim();
    if (!filePath) continue;
    entries.push({ kind, path: filePath });
  }
  return entries;
}
