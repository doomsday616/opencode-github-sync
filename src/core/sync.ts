import fs from "node:fs";
import path from "node:path";
import {
  type CategoryKey,
  type CategorySnapshot,
  disabledCategories,
  disabledPathspecs,
  isDisabledPath,
  restoreDisabled,
  snapshotDisabled,
} from "./categories.js";
import {
  type GitResult,
  git,
  isGitRepo,
  parseNameStatus,
  parsePorcelainPaths,
  toGitError,
} from "./git.js";
import { type GuardReport, LargeChangeError, evaluateGuard, writeLocalExcludes } from "./guard.js";
import { commitMessage, hostAlias } from "./host.js";
import { applyOverrides, configMatchesRepo, findConfigFile } from "./overrides.js";
import { type Roots, getDatabasePath, getRoots } from "./paths.js";
import { saveToRecovery } from "./recovery.js";
import {
  LOCAL_RUNTIME_PATHS,
  assertPushLanded,
  assertRemoteReachable,
  ensureRepo,
  excludePathspecs,
  headCommit,
  isLocalRuntimePath,
  readStageOutMark,
  unstageLocalRuntimePaths,
  writeRepoMetadata,
  writeStageOutMark,
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
import { DEFAULT_SETTINGS, type Settings, loadSettings, repoBranch, repoUrl } from "./settings.js";
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
  /**
   * Called when a push exceeds the large-change limits. Return true to send it
   * anyway. Without a callback an oversized push is refused.
   */
  confirmLarge?: (report: GuardReport) => boolean | Promise<boolean>;
  /** Skip the large-change guard entirely. */
  allowLarge?: boolean;
  /**
   * First push from a directory that is not a repository yet, against a
   * remote that already has history: `remote` (default) takes the remote
   * files first, `local` keeps every local file and records it on top.
   */
  adopt?: "remote" | "local";
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
  /** Present on a dry-run push that would trip the large-change guard. */
  guard?: GuardReport;
}

class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * Another machine published between our rebase and our push, every time we
 * retried. That is contention, not an outage: the next run simply tries again.
 */
export class PushRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRaceError";
  }
}

/** Commit trailer naming the machine that produced a sync commit. */
export const DEVICE_TRAILER = "Opencode-Sync-Device";

const PUSH_RACE_RETRIES = 3;

interface Context {
  root: string;
  branch: string;
  remote: string;
  settings: Settings;
  roots: Roots;
  reporter: Reporter;
  force: boolean;
  dryRun: boolean;
  confirmLarge?: SyncOptions["confirmLarge"];
  allowLarge: boolean;
  disabled: CategoryKey[];
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
    confirmLarge: options.confirmLarge,
    allowLarge: options.allowLarge ?? false,
    disabled: disabledCategories(settings.categories),
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

  ensureRepo({
    root,
    remote: ctx.remote,
    branch,
    adopt: options.adopt ?? "remote",
    beforeAdopt: (_root, ref) => saveOverwritten(ctx, ref, "first-push"),
  });
  assertRemoteReachable(root, branch, "Push", true);
  writeRepoMetadata(root);
  writeLocalExcludes(root, ctx.settings.guard?.skipDirs ?? []);

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

  // A previous run that integrated remote commits but stopped before writing
  // them out leaves the real directories behind HEAD. Staging that stale tree
  // in would publish the gap as deletions, so settle it first. Without a mark
  // nothing is known, and writing out here would resurrect local deletions.
  const mark = readStageOutMark(root);
  const head = headCommit(root);
  if (!ctx.dryRun && mark && head && mark !== head) {
    reporter.step("Writing out changes from an earlier sync");
    stageOut(createStageContext(root, ctx.settings, reporter, false, ctx.roots));
    writeStageOutMark(root);
  }

  reporter.step("Staging local files");
  stageIn(createStageContext(root, ctx.settings, reporter, ctx.force, ctx.roots));

  const sessions = await maybeExportSessions(ctx);

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);
  unstageDisabled(ctx);

  const staged = git(["diff", "--cached", "--name-status"], { cwd: root });
  const files = toChangedFiles(staged, true);
  const summary = summarize(files);

  if (files.length === 0) {
    // No file changes, but a previous push may have failed after committing.
    git(["fetch", "origin", branch], { cwd: root });
    const ahead = countCommits(root, `origin/${branch}..HEAD`);
    const behind = countCommits(root, `HEAD..origin/${branch}`);
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
      const integrated = pushBranch(ctx, true);
      await finishPush(ctx, integrated);
      return done(
        "push",
        true,
        summary,
        files,
        `Pushed ${ahead} pending commit(s)`,
        sessions,
        integrated,
      );
    }
    if (behind > 0 && !ctx.dryRun) {
      // Nothing of ours to send, but other machines have published. HEAD is an
      // ancestor of the remote, so this is a fast-forward that cannot rewrite
      // anything — and the result must reach the real directories, or the next
      // push would read everything new as deleted on this machine.
      reporter.step(`Fast-forwarding ${behind} remote commit(s)`);
      const aside = setAsideDisabled(ctx);
      let ff: GitResult;
      try {
        ff = git(["merge", "--ff-only", `origin/${branch}`], { cwd: root });
      } finally {
        restoreDisabled(root, ctx.disabled, aside);
      }
      if (!ff.ok) throw toGitError("Fast-forward", ff);
      await finishPush(ctx, true);
      return done(
        "push",
        true,
        summary,
        files,
        `Nothing to push; received ${behind} remote commit(s)`,
        sessions,
        true,
      );
    }
    if (!ctx.dryRun) writeStageOutMark(root);
    return done("push", false, summary, files, "Already up to date", sessions);
  }

  reporter.changes(summary, files);
  const guard = ctx.allowLarge
    ? undefined
    : evaluateGuard(root, files, ctx.settings.guard ?? DEFAULT_SETTINGS.guard);
  if (ctx.dryRun) {
    const result = done(
      "push",
      true,
      summary,
      files,
      `${totalChanges(summary)} change(s) would be pushed`,
      sessions,
    );
    if (guard && guard.reasons.length > 0) result.guard = guard;
    return result;
  }

  if (guard && guard.reasons.length > 0) {
    const allowed = ctx.confirmLarge ? await ctx.confirmLarge(guard) : false;
    if (!allowed) {
      // Leave nothing staged: the next attempt must re-evaluate from scratch.
      git(["reset", "-q"], { cwd: root });
      throw new LargeChangeError(guard);
    }
  }

  const alias = hostAlias(ctx.settings.machineAlias);
  const commit = git(
    ["commit", "-m", commitMessage("sync", alias), "-m", `${DEVICE_TRAILER}: ${alias}`],
    { cwd: root },
  );
  if (!commit.ok) throw toGitError("Commit", commit);
  // The commit was built from this machine's directories, so they match it.
  // If the rebase or the network push below fails, the next run sees the mark
  // trailing HEAD and writes the integrated tree out before staging again.
  writeStageOutMark(root);

  const integrated = pushBranch(ctx, false);
  await finishPush(ctx, integrated);
  return done(
    "push",
    true,
    summary,
    files,
    `Pushed ${totalChanges(summary)} change(s)`,
    sessions,
    integrated,
  );
}

/**
 * Settle the real directories after a successful push.
 *
 * When the push integrated other machines' commits, the merged tree is written
 * out. Local work is already committed at this point (stage in → commit →
 * rebase), so this only adds what arrived; skills are never deleted here.
 * Overrides are re-applied by `push()` itself once this returns.
 */
async function finishPush(ctx: Context, integrated: boolean): Promise<void> {
  if (integrated) {
    ctx.reporter.step("Writing out changes from other machines");
    stageOut(createStageContext(ctx.root, ctx.settings, ctx.reporter, false, ctx.roots));
    await maybeImportSessions(ctx);
  }
  writeStageOutMark(ctx.root);
}

/** Push the branch. Returns true when a rebase integrated remote commits. */
function pushBranch(ctx: Context, alreadyCommitted: boolean): boolean {
  const { root, branch, force, reporter } = ctx;

  const hasRemoteBranch = git(["rev-parse", `origin/${branch}`], { cwd: root }).ok;
  if (!hasRemoteBranch) {
    const result = git(["push", "-u", "origin", branch], { cwd: root });
    if (!result.ok) {
      if (isRejected(result)) {
        throw new PushRaceError(
          "Another machine created the branch at the same moment. The next sync will retry.",
        );
      }
      throw toGitError("Push", result);
    }
    assertPushLanded(root, branch, "Push");
    return false;
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
    return false;
  }

  // Another machine can publish between our rebase and our push. Losing that
  // race is contention, not failure: rebase onto the newcomer and try again.
  // Files in disabled categories are set aside so local-only edits never
  // block the rebase.
  const aside = setAsideDisabled(ctx);
  let integrated = false;
  try {
    for (let attempt = 1; ; attempt++) {
      const before = headCommit(root);
      const rebase = git(["pull", "--rebase", "origin", branch], { cwd: root });
      if (!rebase.ok) {
        git(["rebase", "--abort"], { cwd: root });
        throw new SyncError(
          "The remote has changes that conflict with this machine.\n" +
            "Run `opencode-sync pull` to take the remote version, or `opencode-sync push --force` to overwrite it.",
        );
      }
      // The rebase moves HEAD only when it replayed local commits onto new
      // remote ones; an unchanged HEAD means nothing arrived.
      if (headCommit(root) !== before) integrated = true;

      const result = git(["push", "origin", branch], { cwd: root });
      if (result.ok) break;
      if (!isRejected(result)) throw toGitError("Push", result);
      if (attempt >= PUSH_RACE_RETRIES) {
        throw new PushRaceError(
          `Another machine kept publishing first (${attempt} attempts). The next sync will retry.`,
        );
      }
      reporter.step("Another machine pushed first; rebasing and retrying");
    }
  } finally {
    restoreDisabled(root, ctx.disabled, aside);
  }
  assertPushLanded(root, branch, "Push");
  void alreadyCommitted;
  return integrated;
}

function isRejected(result: GitResult): boolean {
  return /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|stale info/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

// ── Disabled categories ─────────────────────────────────────────────────────

function unstageDisabled(ctx: Context): void {
  if (ctx.disabled.length === 0) return;
  git(["reset", "-q", "--", ...disabledPathspecs(ctx.disabled)], { cwd: ctx.root });
}

/**
 * Copy the disabled categories aside and bring their tracked files back to
 * HEAD, so a rebase or reset can run on a clean tree. `restoreDisabled` puts
 * the local versions back afterwards.
 */
function setAsideDisabled(ctx: Context): CategorySnapshot | null {
  if (ctx.disabled.length === 0) return null;
  const snapshot = snapshotDisabled(ctx.root, ctx.disabled);
  if (!snapshot) return null;
  // Untracked local-only files would block an incoming file at the same path.
  for (const rel of snapshot.files) fs.rmSync(path.join(ctx.root, rel), { force: true });
  const tracked = git(["ls-files", "--", ...disabledPathspecs(ctx.disabled)], { cwd: ctx.root });
  const files = tracked.ok ? tracked.stdout.split("\n").filter(Boolean) : [];
  if (files.length > 0) git(["checkout", "HEAD", "--", ...files], { cwd: ctx.root });
  return snapshot;
}

// ── Pull ────────────────────────────────────────────────────────────────────

export async function pull(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = prepare(options);
  const { root, branch, reporter, force } = ctx;

  fs.mkdirSync(root, { recursive: true });

  if (!isGitRepo(root)) {
    const state = ensureRepo({
      root,
      remote: ctx.remote,
      branch,
      adopt: "remote",
      beforeAdopt: (_root, ref) => saveOverwritten(ctx, ref, "first-pull"),
    });
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
    //
    // HEAD can still be ahead of what was last written out, when a push
    // integrated remote commits and stopped before writing them. Settle that
    // here; without a recorded mark nothing is known, so nothing is written.
    const mark = readStageOutMark(root);
    const head = headCommit(root);
    if (!ctx.dryRun && mark && head && mark !== head) {
      reporter.step("Writing out changes from an earlier sync");
      stageOut(createStageContext(root, ctx.settings, reporter, false, ctx.roots));
      const sessions = await maybeImportSessions(ctx);
      finishPull(ctx);
      return done(
        "pull",
        true,
        emptySummary(),
        [],
        "Wrote out changes from an earlier sync",
        sessions,
        true,
      );
    }
    return done("pull", false, emptySummary(), [], "Already up to date", undefined, false);
  }

  const stageCtx = createStageContext(root, ctx.settings, reporter, force, ctx.roots);
  // The config file on disk carries this machine's overrides, so it always
  // differs from HEAD. Rewinding it to the committed form first means the
  // worktree is clean and the pull never has to stash-and-merge the one file
  // that would conflict on every single run.
  normalizeConfigForRepo(stageCtx);

  if (force && !ctx.dryRun) saveOverwritten(ctx, `origin/${branch}`, "force-pull");
  const aside = ctx.dryRun ? null : setAsideDisabled(ctx);
  let stashed = false;
  let files: ChangedFile[] = [];
  let summary = emptySummary();
  try {
    stashed = prepareWorktree(ctx);
    const nameStatus = git(["diff", "--name-status", "HEAD", `origin/${branch}`], { cwd: root });
    files = toChangedFiles(nameStatus, true).filter((f) => !isDisabledPath(f.path, ctx.disabled));
    summary = summarize(files);

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
  } finally {
    restoreDisabled(root, ctx.disabled, aside);
  }

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
  writeStageOutMark(ctx.root);
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

/**
 * Copy every local file that a move to `ref` would overwrite or delete into
 * the recovery folder. Called before a forced pull and before a first link
 * adopts the remote, the two moments local bytes are replaced wholesale.
 */
function saveOverwritten(ctx: Context, ref: string, label: string): string | undefined {
  const { root } = ctx;
  const candidates = new Set<string>();
  const hasHead = git(["rev-parse", "--verify", "HEAD"], { cwd: root }).ok;
  if (hasHead) {
    const diff = git(["diff", "--name-only", "HEAD", ref], { cwd: root });
    for (const p of diff.ok ? diff.stdout.split("\n") : []) if (p) candidates.add(p);
    const dirty = git(["status", "--porcelain", "--", ".", ...excludePathspecs()], { cwd: root });
    for (const p of parsePorcelainPaths(dirty.ok ? dirty.stdout : "")) candidates.add(p);
  } else {
    const files = git(["ls-tree", "-r", "--name-only", ref], { cwd: root });
    for (const p of files.ok ? files.stdout.split("\n") : []) if (p) candidates.add(p);
  }
  const entries = [...candidates]
    .filter((rel) => !isLocalRuntimePath(rel))
    .map((rel) => ({ source: path.join(root, rel), rel }));
  const dir = saveToRecovery(ctx.roots, label, entries);
  if (dir) ctx.reporter.detail(`Saved the replaced local files to ${dir}`);
  return dir;
}

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
