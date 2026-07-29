import path from "node:path";
import { ensureFile, writeIfDiffers } from "./fsx.js";
import { type GitResult, git, isGitRepo, toGitError } from "./git.js";
import { AGENTS_DIR, DATA_DIR, SESSIONS_DIR, STATE_DIR } from "./paths.js";
import { OVERRIDES_FILE, SETTINGS_FILE } from "./settings.js";

/**
 * Files the sync repository must never track.
 *
 * Three categories:
 *   - local-only settings (`opencode-sync*.jsonc`)
 *   - the SQLite database and its journals, which are gigabytes and are
 *     represented instead by the shards in `_sessions/`
 *   - caches, logs and OS junk
 */
export const DEFAULT_GITIGNORE = `# opencode-github-sync — machine-local, never committed
${SETTINGS_FILE}
${OVERRIDES_FILE}
.opencode-sync.lock

# Runtime / generated
node_modules/
bun.lock
logs/
**/__pycache__/
*.pyc

# Session storage lives in ${SESSIONS_DIR}/ as portable shards.
# The raw database is far too large for git and cannot be merged.
${DATA_DIR}/opencode.db
${DATA_DIR}/opencode.db-shm
${DATA_DIR}/opencode.db-wal
${DATA_DIR}/bin/
${DATA_DIR}/log/
${DATA_DIR}/tool-output/
${DATA_DIR}/snapshot/
${DATA_DIR}/storage/session
${DATA_DIR}/storage/session_diff

# Machine-local UI state
${STATE_DIR}/session.json

# Empty directories recreated by OpenCode at runtime
plugin/

# OS files
.DS_Store
Thumbs.db
desktop.ini
`;

export const DEFAULT_GITATTRIBUTES = `# Store and check out everything with LF.
# "text=auto" alone would rewrite files to CRLF on Windows, which silently
# breaks shell scripts shipped inside skills and makes every cross-platform
# pull look like a whole-file change.
* text=auto eol=lf

# Append-only history files merge cleanly by taking both sides
${STATE_DIR}/prompt-history.jsonl text eol=lf merge=union

# Session shards are gzipped JSON — binary, and never line-merged
${SESSIONS_DIR}/*.json.gz binary
`;

/**
 * Paths that exist inside the worktree but must stay out of every commit.
 *
 * These are runtime artefacts of the machine, not configuration. They are
 * excluded from `add`, from stashing and from `clean`, so a sync can never
 * delete a user's local database or tool output.
 */
export const LOCAL_RUNTIME_PATHS = [
  `${DATA_DIR}/opencode.db`,
  `${DATA_DIR}/opencode.db-shm`,
  `${DATA_DIR}/opencode.db-wal`,
  `${DATA_DIR}/storage/session`,
  `${DATA_DIR}/storage/session_diff`,
  `${DATA_DIR}/tool-output`,
  `${DATA_DIR}/snapshot`,
];

export function isLocalRuntimePath(candidate: string): boolean {
  const normalized = String(candidate ?? "").replace(/\\/g, "/");
  return LOCAL_RUNTIME_PATHS.some((prefix) => {
    const clean = prefix.replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

export function excludePathspecs(): string[] {
  return LOCAL_RUNTIME_PATHS.map((p) => `:(exclude)${p}`);
}

/** Unstage runtime paths in a single git call — subprocesses are slow on Windows. */
export function unstageLocalRuntimePaths(root: string): void {
  git(["reset", "-q", "HEAD", "--", ...LOCAL_RUNTIME_PATHS], { cwd: root });
}

export interface EnsureRepoOptions {
  root: string;
  remote: string;
  branch: string;
}

export type RepoState = "ready" | "adopted" | "fresh";

/** Configure identity and metadata files. Safe to call repeatedly. */
export function ensureGitIdentity(root: string): void {
  const name = git(["config", "user.name"], { cwd: root });
  if (!name.ok || !name.stdout) {
    git(["config", "user.name", "OpenCode Sync"], { cwd: root });
  }
  const email = git(["config", "user.email"], { cwd: root });
  if (!email.ok || !email.stdout) {
    git(["config", "user.email", "sync@opencode.local"], { cwd: root });
  }
}

export function writeRepoMetadata(root: string): void {
  writeIfDiffers(path.join(root, ".gitignore"), DEFAULT_GITIGNORE);
  writeIfDiffers(path.join(root, ".gitattributes"), DEFAULT_GITATTRIBUTES);
}

/**
 * Make `root` a git worktree pointing at `remote`.
 *
 * Returns `adopted` when the remote already had commits (they become the local
 * state) and `fresh` when the remote exists but is empty.
 */
export function initRepo(options: EnsureRepoOptions): RepoState {
  const { root, remote, branch } = options;

  ensureFile(path.join(root, ".gitignore"), DEFAULT_GITIGNORE);
  ensureFile(path.join(root, ".gitattributes"), DEFAULT_GITATTRIBUTES);

  git(["init", "-b", branch], { cwd: root });
  const existingRemote = git(["remote", "get-url", "origin"], { cwd: root });
  if (existingRemote.ok) {
    if (existingRemote.stdout !== remote) {
      git(["remote", "set-url", "origin", remote], { cwd: root });
    }
  } else {
    git(["remote", "add", "origin", remote], { cwd: root });
  }
  ensureGitIdentity(root);

  const fetched = git(["fetch", "origin", branch], { cwd: root });
  if (fetched.ok && git(["rev-parse", `origin/${branch}`], { cwd: root }).ok) {
    git(["reset", "--hard", `origin/${branch}`], { cwd: root });
    git(["branch", `--set-upstream-to=origin/${branch}`, branch], { cwd: root });
    return "adopted";
  }

  if (!fetched.ok && !isMissingBranch(fetched)) throw toGitError("Initial fetch", fetched);
  return "fresh";
}

function isMissingBranch(result: GitResult): boolean {
  return /couldn't find remote ref|remote branch .* not found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

export function ensureRepo(options: EnsureRepoOptions): RepoState {
  if (!isGitRepo(options.root)) return initRepo(options);
  ensureGitIdentity(options.root);
  const remote = git(["remote", "get-url", "origin"], { cwd: options.root });
  if (!remote.ok) {
    git(["remote", "add", "origin", options.remote], { cwd: options.root });
  } else if (remote.stdout !== options.remote) {
    git(["remote", "set-url", "origin", options.remote], { cwd: options.root });
  }
  return "ready";
}

/** Fail fast when the remote is unreachable, distinguishing auth from network. */
export function assertRemoteReachable(
  root: string,
  branch: string,
  operation: string,
  allowMissingBranch = false,
): void {
  const result = git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd: root });
  if (result.ok) return;
  if (allowMissingBranch && git(["ls-remote", "origin"], { cwd: root }).ok) return;
  throw toGitError(operation, result);
}

/**
 * Verify the commit really landed on the remote.
 *
 * `git push` can exit zero against a misconfigured proxy or a stale credential
 * helper without the remote actually moving, so success is confirmed by reading
 * the remote head back.
 */
export function assertPushLanded(root: string, branch: string, operation: string): void {
  const local = git(["rev-parse", "HEAD"], { cwd: root });
  const remote = git(["ls-remote", "origin", `refs/heads/${branch}`], { cwd: root });
  if (!remote.ok) throw toGitError(operation, remote);
  if (!local.ok) throw toGitError(operation, local);
  const remoteHead = remote.stdout.split(/\s+/)[0] ?? "";
  if (remoteHead === local.stdout) return;
  throw new Error(
    `${operation} reported success but the remote did not move.\n` +
      `  local:  ${local.stdout}\n  remote: ${remoteHead || "(empty)"}`,
  );
}

export const REPO_DIRS = { DATA_DIR, STATE_DIR, AGENTS_DIR, SESSIONS_DIR };
