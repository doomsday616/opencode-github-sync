import fs from "node:fs";
import path from "node:path";
import {
  type GitResult,
  git,
  isGitRepo,
  parseNameStatus,
  parsePorcelainPaths,
  toGitError,
} from "./git.js";
import { commitMessage, hostAlias } from "./host.js";
import { applyOverrides, configMatchesRepo, findConfigFile } from "./overrides.js";
import { type Roots, getDatabasePath, getRoots } from "./paths.js";
import {
  LOCAL_RUNTIME_PATHS,
  assertPushLanded,
  assertRemoteReachable,
  ensureRepo,
  excludePathspecs,
  isLocalRuntimePath,
  unstageLocalRuntimePaths,
  writeRepoMetadata,
} from "./repo.js";
import {
  type ChangedFile,
  type Reporter,
  emptySummary,
  silentReporter,
  summarize,
  totalChanges,
} from "./reporter.js";
import { exportSessions, importSessions } from "./sessions.js";
import { type Settings, loadSettings, repoBranch, repoUrl } from "./settings.js";
import { sqliteAvailable } from "./sqlite.js";
import {
  createStageContext,
  normalizeConfigForRepo,
  prunePluginCache,
  stageIn,
  stageOut,
} from "./stage.js";

export interface SyncOptions {
  settings?: Settings;
  roots?: Roots;
  reporter?: Reporter;
  /** Overwrite the other side on conflict. */
  force?: boolean;
  /** Compute the result without writing anything to the remote. */
  dryRun?: boolean;
}

export interface SyncResult {
  action: "push" | "pull";
  changed: boolean;
  summary: ReturnType<typeof emptySummary>;
  files: ChangedFile[];
  sessions?: { exported?: number; imported?: number; skipped?: number };
  message: string;
  /** True when OpenCode must restart for the pulled config to take effect. */
  restartRequired: boolean;
}

class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

interface Context {
  root: string;
  branch: string;
  remote: string;
  settings: Settings;
  roots: Roots;
  reporter: Reporter;
  force: boolean;
  dryRun: boolean;
}

function prepare(options: SyncOptions): Context {
  const roots = options.roots ?? getRoots();
  const settings = options.settings ?? loadSettings(roots.config);
  const remote = repoUrl(settings);
  if (!remote) {
    throw new SyncError(
      "No sync repository configured.\n" +
        "Run `opencode-sync init` to create one, or `opencode-sync link <owner/repo>` to use an existing one.",
    );
  }
  return {
    root: roots.config,
    branch: repoBranch(settings),
    remote,
    settings,
    roots,
    reporter: options.reporter ?? silentReporter,
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
  };
}

function toChangedFiles(result: GitResult, excludeRuntime: boolean): ChangedFile[] {
  return parseNameStatus(result.ok ? result.stdout : "")
    .filter((entry) => !excludeRuntime || !isLocalRuntimePath(entry.path))
    .map((entry) => ({ kind: entry.kind, path: entry.path }));
}

// ── Push ────────────────────────────────────────────────────────────────────

export async function push(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = prepare(options);
  const { root, branch, reporter } = ctx;

  if (!fs.existsSync(root)) throw new SyncError(`Config directory not found: ${root}`);

  ensureRepo({ root, remote: ctx.remote, branch });
  assertRemoteReachable(root, branch, "Push", true);
  writeRepoMetadata(root);

  try {
    return await runPush(ctx);
  } finally {
    // Staging rewrites the on-disk config into its shareable form. Whatever
    // happens next — success, conflict, network failure — this machine must be
    // left with its own effective configuration, not the stripped one.
    applyOverrides(ctx.roots.config);
  }
}

async function runPush(ctx: Context): Promise<SyncResult> {
  const { root, branch, reporter } = ctx;

  reporter.step("Staging local files");
  stageIn(createStageContext(root, ctx.settings, reporter, ctx.force, ctx.roots));

  const sessions = await maybeExportSessions(ctx);

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);

  const staged = git(["diff", "--cached", "--name-status"], { cwd: root });
  const files = toChangedFiles(staged, true);
  const summary = summarize(files);

  if (files.length === 0) {
    // No file changes, but a previous push may have failed after committing.
    git(["fetch", "origin", branch], { cwd: root });
    const ahead = countCommits(root, `origin/${branch}..HEAD`);
    if (ahead > 0) {
      if (ctx.dryRun) {
        return done(
          "push",
          false,
          summary,
          files,
          `${ahead} local commit(s) waiting to be pushed`,
          sessions,
        );
      }
      reporter.step(`Pushing ${ahead} pending commit(s)`);
      pushBranch(ctx, true);
      return done("push", true, summary, files, `Pushed ${ahead} pending commit(s)`, sessions);
    }
    return done("push", false, summary, files, "Already up to date", sessions);
  }

  reporter.changes(summary, files);
  if (ctx.dryRun) {
    return done(
      "push",
      true,
      summary,
      files,
      `${totalChanges(summary)} change(s) would be pushed`,
      sessions,
    );
  }

  const alias = hostAlias(ctx.settings.machineAlias);
  const commit = git(["commit", "-m", commitMessage("sync", alias)], { cwd: root });
  if (!commit.ok) throw toGitError("Commit", commit);

  pushBranch(ctx, false);
  return done("push", true, summary, files, `Pushed ${totalChanges(summary)} change(s)`, sessions);
}

function pushBranch(ctx: Context, alreadyCommitted: boolean): void {
  const { root, branch, force, reporter } = ctx;

  const hasRemoteBranch = git(["rev-parse", `origin/${branch}`], { cwd: root }).ok;
  if (!hasRemoteBranch) {
    const result = git(["push", "-u", "origin", branch], { cwd: root });
    if (!result.ok) throw toGitError("Push", result);
    assertPushLanded(root, branch, "Push");
    return;
  }

  if (force) {
    // Refresh the tracking ref first. `--force-with-lease` compares against the
    // local idea of the remote, so a stale ref makes it refuse the very
    // overwrite the user explicitly asked for.
    if (git(["fetch", "origin", branch], { cwd: root }).ok) {
      const behind = countCommits(root, `HEAD..origin/${branch}`);
      if (behind > 0) {
        reporter.warn(`Overwriting ${behind} remote commit(s) that this machine does not have`);
      }
    }
    const result = git(["push", "--force-with-lease", "origin", branch], { cwd: root });
    if (!result.ok) throw toGitError("Force push", result);
    assertPushLanded(root, branch, "Force push");
    return;
  }

  const rebase = git(["pull", "--rebase", "origin", branch], { cwd: root });
  if (!rebase.ok) {
    git(["rebase", "--abort"], { cwd: root });
    throw new SyncError(
      "The remote has changes that conflict with this machine.\n" +
        "Run `opencode-sync pull` to take the remote version, or `opencode-sync push --force` to overwrite it.",
    );
  }

  const result = git(["push", "origin", branch], { cwd: root });
  if (!result.ok) throw toGitError("Push", result);
  assertPushLanded(root, branch, "Push");
  void alreadyCommitted;
}

// ── Pull ────────────────────────────────────────────────────────────────────

export async function pull(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = prepare(options);
  const { root, branch, reporter, force } = ctx;

  fs.mkdirSync(root, { recursive: true });

  if (!isGitRepo(root)) {
    const state = ensureRepo({ root, remote: ctx.remote, branch });
    if (state === "fresh") {
      return done(
        "pull",
        false,
        emptySummary(),
        [],
        "The sync repository is empty — push from another machine first.",
      );
    }
    stageOut(createStageContext(root, ctx.settings, reporter, force, ctx.roots));
    const sessions = await maybeImportSessions(ctx);
    const count = git(["ls-files"], { cwd: root }).stdout.split("\n").filter(Boolean).length;
    finishPull(ctx);
    return done(
      "pull",
      true,
      emptySummary(),
      [],
      `First pull complete — ${count} file(s)`,
      sessions,
      true,
    );
  }

  ensureRepo({ root, remote: ctx.remote, branch });

  reporter.step("Fetching from GitHub");
  const fetched = git(["fetch", "origin", branch], { cwd: root });
  if (!fetched.ok) throw toGitError("Fetch", fetched);

  const ahead = countCommits(root, `origin/${branch}..HEAD`);
  if (!force && ahead > 0) {
    throw new SyncError(
      `This machine has ${ahead} commit(s) that were never pushed.\n` +
        "Run `opencode-sync push` first, or `opencode-sync pull --force` to discard them.",
    );
  }

  const behind = countCommits(root, `HEAD..origin/${branch}`);
  if (!force && behind === 0) {
    // Nothing incoming, so the worktree does not need to be touched at all.
    // Skipping the stash cycle here is what keeps a no-op pull fast on Windows.
    return done("pull", false, emptySummary(), [], "Already up to date", undefined, false);
  }

  const stageCtx = createStageContext(root, ctx.settings, reporter, force, ctx.roots);
  // The config file on disk carries this machine's overrides, so it always
  // differs from HEAD. Rewinding it to the committed form first means the
  // worktree is clean and the pull never has to stash-and-merge the one file
  // that would conflict on every single run.
  normalizeConfigForRepo(stageCtx);

  const stashed = prepareWorktree(ctx);
  const nameStatus = git(["diff", "--name-status", "HEAD", `origin/${branch}`], { cwd: root });
  const files = toChangedFiles(nameStatus, true);
  const summary = summarize(files);

  if (ctx.dryRun) {
    if (stashed) restoreStash(ctx);
    return done(
      "pull",
      files.length > 0,
      summary,
      files,
      `${totalChanges(summary)} change(s) would be pulled`,
    );
  }

  const reset = git(["reset", "--hard", `origin/${branch}`], { cwd: root });
  if (!reset.ok) {
    if (stashed) restoreStash(ctx);
    throw toGitError("Reset", reset);
  }
  if (stashed) restoreStash(ctx);

  stageOut(createStageContext(root, ctx.settings, reporter, force, ctx.roots));
  const sessions = await maybeImportSessions(ctx);
  finishPull(ctx);

  reporter.changes(summary, files);
  return done(
    "pull",
    files.length > 0,
    summary,
    files,
    files.length > 0 ? `Pulled ${totalChanges(summary)} change(s)` : "Already up to date",
    sessions,
    true,
  );
}

/** Re-apply machine-local settings and clean up caches after a pull. */
function finishPull(ctx: Context): void {
  if (applyOverrides(ctx.roots.config)) {
    ctx.reporter.detail("Re-applied per-machine overrides");
  }
  const pruned = prunePluginCache(ctx.roots.config, ctx.roots.cache);
  if (pruned > 0) ctx.reporter.detail(`Removed ${pruned} stale plugin package(s) from the cache`);
}

/**
 * Get the worktree into a state where a hard reset is safe.
 *
 * Without `force` local edits are stashed and restored afterwards. With
 * `force` they are discarded — but the runtime paths are still protected,
 * because `git clean` would otherwise happily delete the user's database.
 */
function prepareWorktree(ctx: Context): boolean {
  const { root, force } = ctx;

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);

  const hasStaged = git(["diff", "--cached", "--stat"], { cwd: root }).stdout.length > 0;
  const untracked = git(
    ["ls-files", "--others", "--exclude-standard", "--", ".", ...excludePathspecs()],
    { cwd: root },
  );
  const hasUntracked = untracked.ok && untracked.stdout.length > 0;
  if (!hasStaged && !hasUntracked) return false;

  git(["reset", "HEAD"], { cwd: root });

  if (force) {
    git(["checkout", "--", "."], { cwd: root });
    // `-e` takes gitignore-style patterns and *keeps* the matches. Using
    // `:(exclude)` pathspecs here would invert the meaning and delete
    // everything except the runtime paths.
    git(["clean", "-fd", ...LOCAL_RUNTIME_PATHS.flatMap((p) => ["-e", p])], { cwd: root });
    return false;
  }

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);
  const stash = git(
    [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "opencode-sync auto-stash",
      "--",
      ".",
      ...excludePathspecs(),
    ],
    { cwd: root },
  );
  if (!stash.ok) throw toGitError("Stash", stash);
  return !/No local changes to save/i.test(stash.stdout);
}

function restoreStash(ctx: Context): void {
  const { root } = ctx;
  const pop = git(["stash", "pop"], { cwd: root });
  if (pop.ok) return;

  // A conflicting pop leaves the stash in place and the worktree half-merged.
  // A half-merged opencode.jsonc stops OpenCode from starting, so reset to a
  // known-good tree and tell the user exactly where their work still is.
  git(["reset", "--hard", "HEAD"], { cwd: root });
  throw new SyncError(
    "Local changes conflicted with the incoming version.\n" +
      "The worktree was rolled back to a clean state and your changes are still saved in the stash:\n" +
      `  cd "${root}"\n` +
      "  git stash list\n" +
      "  git stash show -p stash@{0}     # inspect\n" +
      "  git stash apply --index stash@{0}  # restore manually\n" +
      "  git stash drop stash@{0}        # discard\n" +
      "Or re-run with --force to take the remote version.",
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function maybeExportSessions(ctx: Context): Promise<SyncResult["sessions"]> {
  if (!ctx.settings.sessions.enabled) return undefined;
  if (!(await sqliteAvailable())) {
    ctx.reporter.warn("Session sync is enabled but no SQLite driver is available — skipping.");
    return undefined;
  }

  const database = getDatabasePath(ctx.roots);
  ctx.reporter.step("Exporting sessions");
  const result = await exportSessions(database, ctx.root, ctx.settings.sessions, ctx.reporter);

  for (const skipped of result.skippedTooLarge) {
    ctx.reporter.warn(
      `Skipped "${skipped.title || skipped.id}" — ${formatBytes(skipped.bytes)} exceeds maxSessionBytes`,
    );
  }
  if (result.written.length > 0) {
    ctx.reporter.detail(`Exported ${result.written.length} session(s)`);
  }
  return { exported: result.written.length, skipped: result.skippedTooLarge.length };
}

async function maybeImportSessions(ctx: Context): Promise<SyncResult["sessions"]> {
  if (!ctx.settings.sessions.enabled) return undefined;
  if (!fs.existsSync(path.join(ctx.root, "_sessions"))) return undefined;
  if (!(await sqliteAvailable())) {
    ctx.reporter.warn(
      "Session shards were pulled but no SQLite driver is available to import them.",
    );
    return undefined;
  }

  ctx.reporter.step("Importing sessions");
  const result = await importSessions(getDatabasePath(ctx.roots), ctx.root, ctx.reporter);
  for (const failure of result.failed) {
    ctx.reporter.warn(`Could not import ${failure.file}: ${failure.reason}`);
  }
  if (result.imported > 0) ctx.reporter.detail(`Imported ${result.imported} session(s)`);
  return { imported: result.imported, skipped: result.skippedOlder };
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface StatusResult {
  configured: boolean;
  remote?: string;
  branch: string;
  initialized: boolean;
  ahead: number;
  behind: number;
  dirty: number;
  lastCommit?: string;
  lastCommitDate?: string;
  sessionsEnabled: boolean;
  sessionShards: number;
  overridesActive: boolean;
  machineAlias: string;
}

export function status(options: SyncOptions = {}): StatusResult {
  const roots = options.roots ?? getRoots();
  const settings = options.settings ?? loadSettings(roots.config);
  const branch = repoBranch(settings);
  const remote = repoUrl(settings);
  const root = roots.config;

  const base: StatusResult = {
    configured: Boolean(remote),
    remote,
    branch,
    initialized: false,
    ahead: 0,
    behind: 0,
    dirty: 0,
    sessionsEnabled: settings.sessions.enabled,
    sessionShards: countShards(root),
    overridesActive: fs.existsSync(path.join(root, "opencode-sync.overrides.jsonc")),
    machineAlias: hostAlias(settings.machineAlias),
  };

  if (!remote || !isGitRepo(root)) return base;
  base.initialized = true;

  git(["fetch", "origin", branch], { cwd: root });
  base.ahead = countCommits(root, `origin/${branch}..HEAD`);
  base.behind = countCommits(root, `HEAD..origin/${branch}`);

  const dirty = git(["status", "--porcelain", "--", ".", ...excludePathspecs()], { cwd: root });
  base.dirty = dirty.ok ? countRealChanges(root, dirty.stdout) : 0;

  const log = git(["log", "-1", "--format=%s%n%cI"], { cwd: root });
  if (log.ok) {
    const [subject, date] = log.stdout.split("\n");
    base.lastCommit = subject;
    base.lastCommitDate = date;
  }
  return base;
}

function countShards(root: string): number {
  const dir = path.join(root, "_sessions");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")).length;
}

/**
 * Count genuinely uncommitted files.
 *
 * With overrides in use the config file always differs from the committed
 * version, so a raw `git status` would report one modified file forever. That
 * entry is dropped when the only difference is the overrides themselves.
 */
function countRealChanges(root: string, porcelain: string): number {
  const paths = parsePorcelainPaths(porcelain);
  if (paths.length === 0) return 0;

  const configFile = findConfigFile(root);
  if (!configFile) return paths.length;

  const relative = path.relative(root, configFile).split(path.sep).join("/");
  const head = git(["show", `HEAD:${relative}`], { cwd: root });
  if (!configMatchesRepo(root, head.ok ? head.stdout : undefined)) return paths.length;

  return paths.filter((file) => file !== relative).length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function countCommits(root: string, range: string): number {
  const result = git(["rev-list", "--count", range], { cwd: root });
  return result.ok ? Number(result.stdout) || 0 : 0;
}

function done(
  action: "push" | "pull",
  changed: boolean,
  summary: ReturnType<typeof emptySummary>,
  files: ChangedFile[],
  message: string,
  sessions?: SyncResult["sessions"],
  restartRequired = false,
): SyncResult {
  return { action, changed, summary, files, message, sessions, restartRequired };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export { SyncError };
