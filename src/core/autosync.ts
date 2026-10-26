import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, parsePorcelainPaths } from "./git.js";
import { LargeChangeError } from "./guard.js";
import { hostAlias } from "./host.js";
import { acquireSyncLock, releaseSyncLock } from "./lock.js";
import { configMatchesRepo, findConfigFile } from "./overrides.js";
import type { Roots } from "./paths.js";
import { excludePathspecs, readStageOutMarkTime } from "./repo.js";
import { CollectingReporter } from "./reporter.js";
import { type Settings, loadSettings, repoBranch } from "./settings.js";
import { PushRaceError, type SyncOptions, type SyncResult, pull, push } from "./sync.js";

/**
 * Unattended sync, run by the operating system's scheduler.
 *
 * The rules below exist because an unattended writer is dangerous in ways a
 * person at the keyboard is not:
 *
 *   - Opt-in per machine. The flag lives in the local-only settings file, so
 *     enabling it here can never enable it on another machine.
 *   - Never write while something else is writing. A sync rewrites the skills
 *     directory; doing that while an editor or another OpenCode window is
 *     mid-save can revert the edit. What matters is whether files are moving,
 *     so the gate is the newest modification time in the synced trees.
 *   - Receiving is not read-only either: it mirrors the repository out over
 *     untracked directories. It runs only when this machine has nothing of its
 *     own in flight — no uncommitted edits, no unpushed commits, and no file in
 *     the untracked trees newer than the last time they matched the repository.
 *   - Back off, but never give up. After repeated failures the gap between
 *     attempts widens to an hour, and the next success resets it.
 *   - Machines that fire on the same minute collide on every run, so each one
 *     waits a stable per-machine offset before touching the network.
 */

export const STATE_FILE = "opencode-sync-autosync.json";
export const LOG_FILE = "opencode-sync-autosync.log";
export const LOG_ROTATE_BYTES = 512 * 1024;

export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_BASE_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const STAGGER_MAX_S = 45;
export const JITTER_MAX_MS = 5000;
/** Scheduler start times drift by the stagger; allow that much early. */
export const INTERVAL_TOLERANCE_MS = 60 * 1000;
export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

export interface AutosyncState {
  lastRunAt?: number;
  lastAttemptAt?: number;
  lastReceiveAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures?: number;
  lastError?: string | null;
  lastOutcome?: string;
  failureNotifiedAt?: number | null;
  largeChangeNotifiedAt?: number | null;
  lastUpdateCheckAt?: number;
}

// ── State and log files ─────────────────────────────────────────────────────

export function statePath(roots: Roots): string {
  return path.join(roots.state, STATE_FILE);
}

export function logPath(roots: Roots): string {
  return path.join(roots.config, "logs", LOG_FILE);
}

export function readState(roots: Roots): AutosyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(roots), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeState(roots: Roots, patch: Partial<AutosyncState>): AutosyncState {
  const next = { ...readState(roots), ...patch };
  try {
    const file = statePath(roots);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename, so a concurrent reader never sees half a file and
    // silently resets the failure counter.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // Best effort: losing bookkeeping costs one extra attempt, nothing more.
  }
  return next;
}

export function appendLog(roots: Roots, line: string, now = Date.now()): void {
  const file = logPath(roots);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_ROTATE_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `[${new Date(now).toISOString()}] ${line}\n`, "utf8");
  } catch {
    // Logging must never be what breaks a sync.
  }
}

export function tailLog(roots: Roots, lines = 20): string[] {
  try {
    return fs.readFileSync(logPath(roots), "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// ── Pure decision helpers ───────────────────────────────────────────────────

/** The failure counter as a sane integer, whatever the file holds. */
export function failureCount(state: AutosyncState): number {
  const value = state.consecutiveFailures;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Delay before the next attempt once backing off: 30 min doubling to 60. */
export function backoffDelayMs(failures: number): number {
  const extra = Math.max(0, failures - MAX_CONSECUTIVE_FAILURES);
  return Math.min(BACKOFF_BASE_MS * 2 ** extra, BACKOFF_MAX_MS);
}

/** Milliseconds still to wait because of backoff; 0 when free to try. */
export function backoffRemainingMs(state: AutosyncState, now: number): number {
  const failures = failureCount(state);
  if (failures < MAX_CONSECUTIVE_FAILURES) return 0;
  const last = typeof state.lastFailureAt === "number" ? state.lastFailureAt : 0;
  return Math.max(0, backoffDelayMs(failures) - (now - last));
}

/** A stable 0–45 s offset per machine plus up to 5 s of noise. */
export function staggerMs(alias: string, random: () => number): number {
  const digest = createHash("sha256").update(alias).digest();
  const offset = (digest.readUInt32BE(0) % (STAGGER_MAX_S + 1)) * 1000;
  return offset + Math.floor(random() * JITTER_MAX_MS);
}

/** Directory names skipped by the settle check: churn that says nothing. */
export const SETTLE_SKIP_DIRS = new Set([
  ".git",
  "logs",
  "log",
  ".opencode-sync.lock",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
]);

/** File names skipped by the settle check. */
export const SETTLE_SKIP_FILES = new Set([
  "session.json",
  "prompt-history.jsonl",
  "frecency.jsonl",
  "model.json",
  "bun.lock",
  "package-lock.json",
  "opencode-sync.jsonc",
  STATE_FILE,
  `${STATE_FILE}.tmp`,
]);

function isNoisyFile(name: string): boolean {
  return (
    SETTLE_SKIP_FILES.has(name) ||
    name.endsWith(".log") ||
    name.endsWith(".lock") ||
    name.endsWith(".tmp")
  );
}

/** Newest modification time below `dirs`, ignoring noise. 0 when nothing found. */
export function newestWrite(dirs: string[], skipDirs: Iterable<string> = []): number {
  const skip = new Set([...SETTLE_SKIP_DIRS, ...skipDirs]);
  let newest = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 10) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (isNoisyFile(entry.name)) continue;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Vanished mid-walk.
      }
    }
  };
  for (const dir of dirs) {
    try {
      if (fs.statSync(dir).isFile()) {
        newest = Math.max(newest, fs.statSync(dir).mtimeMs);
        continue;
      }
    } catch {
      continue;
    }
    walk(dir, 0);
  }
  return newest;
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface RepoSnapshot {
  ok: boolean;
  dirty: boolean;
  ahead: number;
  error?: string;
}

export interface AutosyncDeps {
  roots: Roots;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  loadSettings: () => Settings;
  push: (options: SyncOptions) => Promise<SyncResult>;
  pull: (options: SyncOptions) => Promise<SyncResult>;
  /** Fetch and count incoming commits. */
  fetchBehind: () => { ok: boolean; behind: number; error?: string };
  repoSnapshot: () => RepoSnapshot;
  /** Newest write in the trees the settle rule watches. */
  newestWrite: (settings: Settings) => number;
  /** Newest write in the untracked trees a receive would overwrite. */
  newestUntrackedWrite: (settings: Settings) => number;
  /** When the untracked trees last matched the repository; 0 if unknown. */
  stageOutTime: () => number;
  tryLock: () => { release: () => void } | null;
  notify: (title: string, body: string) => boolean;
  log: (line: string) => void;
  /** Daily self-update hook; returns a one-line summary for the log. */
  selfUpdate?: () => string;
  messages: AutosyncMessages;
}

export interface AutosyncMessages {
  backoffTitle: string;
  backoffBody: (failures: number, minutes: number) => string;
  recoveredTitle: string;
  recoveredBody: string;
  largeTitle: string;
  largeBody: string;
}

export const ENGLISH_MESSAGES: AutosyncMessages = {
  backoffTitle: "OpenCode sync is failing",
  backoffBody: (failures, minutes) =>
    `${failures} attempts in a row failed. Retrying every ${minutes} min. Run: opencode-sync autosync status`,
  recoveredTitle: "OpenCode sync recovered",
  recoveredBody: "Automatic sync is working again.",
  largeTitle: "OpenCode sync needs you",
  largeBody: "A very large change is waiting. Open opencode-sync to review and confirm it.",
};

// ── The run ─────────────────────────────────────────────────────────────────

export type RunAction = "push" | "receive" | "skip";

export interface RunOutcome {
  action: RunAction;
  ok: boolean;
  reason: string;
  message?: string;
}

/** Why a push should not run now, or null when it may. */
export function pushBlockedReason(
  settings: Settings,
  state: AutosyncState,
  now: number,
): string | null {
  if (!settings.autosync.enabled) return "autosync is not enabled on this machine";
  if (settings.autosync.pausedUntil > now) {
    return `paused until ${new Date(settings.autosync.pausedUntil).toISOString()}`;
  }
  const backoff = backoffRemainingMs(state, now);
  if (backoff > 0) {
    return `backing off after ${failureCount(state)} failures, retry in ${Math.ceil(backoff / 60000)} min`;
  }
  const intervalMs = Math.max(2, settings.autosync.intervalMinutes) * 60000;
  const since = now - (state.lastAttemptAt ?? 0);
  if (since < intervalMs - INTERVAL_TOLERANCE_MS) {
    return `throttled, ${Math.ceil((intervalMs - since) / 60000)} min to go`;
  }
  return null;
}

/** Run one scheduled pass. Never throws. */
export async function runAutosync(deps: AutosyncDeps, trigger = "scheduled"): Promise<RunOutcome> {
  const now = deps.now();
  let settings: Settings;
  try {
    settings = deps.loadSettings();
  } catch (error) {
    const reason = `cannot read settings: ${(error as Error).message}`;
    deps.log(`${trigger}: skipped (${reason})`);
    return { action: "skip", ok: false, reason };
  }
  let state = writeState(deps.roots, { lastRunAt: now });

  const blocked = pushBlockedReason(settings, state, now);
  if (blocked) {
    deps.log(`${trigger}: skipped (${blocked})`);
    return { action: "skip", ok: true, reason: blocked };
  }

  const settleMs = Math.max(0, settings.autosync.settleSeconds) * 1000;
  const newest = deps.newestWrite(settings);
  const busyFor = newest > 0 ? Math.max(0, now - newest) : null;
  const busy = busyFor !== null && busyFor < settleMs;

  const alias = hostAlias(settings.machineAlias);
  const delay = process.env.OPENCODE_SYNC_NO_STAGGER === "1" ? 0 : staggerMs(alias, deps.random);

  if (busy) {
    const why = `files still changing (${Math.round((busyFor ?? 0) / 1000)}s ago)`;
    const receiveBlocked = receiveBlockedReason(deps, settings);
    if (receiveBlocked) {
      deps.log(`${trigger}: skipped (${why}; receive: ${receiveBlocked})`);
      return { action: "skip", ok: true, reason: `${why}; ${receiveBlocked}` };
    }
    if (delay > 0) await deps.sleep(delay);
    return receive(deps, settings, trigger, why);
  }

  if (delay > 0) await deps.sleep(delay);
  const lock = deps.tryLock();
  if (!lock) {
    deps.log(`${trigger}: skipped (another sync is in progress)`);
    return { action: "skip", ok: true, reason: "another sync is in progress" };
  }

  state = writeState(deps.roots, { lastAttemptAt: deps.now() });
  try {
    const result = await deps.push({
      settings,
      roots: deps.roots,
      reporter: new CollectingReporter(),
    });
    recordSuccess(deps, `push: ${result.message}`);
    deps.log(`${trigger}: push ${result.message}`);
    maybeSelfUpdate(deps, settings);
    return { action: "push", ok: true, reason: "", message: result.message };
  } catch (error) {
    recordFailure(deps, settings, error as Error);
    deps.log(`${trigger}: push FAILED (${oneLine((error as Error).message)})`);
    return { action: "push", ok: false, reason: oneLine((error as Error).message) };
  } finally {
    lock.release();
  }
}

function receiveBlockedReason(deps: AutosyncDeps, settings: Settings): string | null {
  const repo = deps.repoSnapshot();
  if (!repo.ok) return `cannot read the repository (${repo.error ?? "unknown"})`;
  if (repo.dirty) return "local edits are not committed yet";
  if (repo.ahead > 0) return `${repo.ahead} local commit(s) waiting`;
  // Untracked trees (skills, extra paths) cannot be seen by git status. Any
  // file there newer than the last write-out is an edit a receive would revert.
  const mark = deps.stageOutTime();
  if (mark <= 0) return "no record of the last sync on this machine";
  if (deps.newestUntrackedWrite(settings) > mark) return "skills or extra paths have local edits";
  return null;
}

async function receive(
  deps: AutosyncDeps,
  settings: Settings,
  trigger: string,
  why: string,
): Promise<RunOutcome> {
  const lock = deps.tryLock();
  if (!lock) {
    deps.log(`${trigger}: skipped (${why}; another sync is in progress)`);
    return { action: "skip", ok: true, reason: "another sync is in progress" };
  }
  try {
    const fetched = deps.fetchBehind();
    if (!fetched.ok) throw new Error(`fetch failed: ${fetched.error ?? "unknown"}`);
    if (fetched.behind === 0) {
      deps.log(`${trigger}: skipped (${why}; nothing waiting to receive)`);
      return { action: "skip", ok: true, reason: `${why}; nothing to receive` };
    }
    writeState(deps.roots, { lastReceiveAt: deps.now() });
    const result = await deps.pull({
      settings,
      roots: deps.roots,
      reporter: new CollectingReporter(),
    });
    recordSuccess(deps, `receive: ${result.message}`);
    deps.log(`${trigger}: receive ${result.message} (push held back: ${why})`);
    return { action: "receive", ok: true, reason: why, message: result.message };
  } catch (error) {
    recordFailure(deps, settings, error as Error);
    deps.log(`${trigger}: receive FAILED (${oneLine((error as Error).message)})`);
    return { action: "receive", ok: false, reason: oneLine((error as Error).message) };
  } finally {
    lock.release();
  }
}

function oneLine(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

function recordSuccess(deps: AutosyncDeps, outcome: string): void {
  const state = readState(deps.roots);
  const patch: Partial<AutosyncState> = {
    consecutiveFailures: 0,
    lastSuccessAt: deps.now(),
    lastError: null,
    lastOutcome: outcome,
    largeChangeNotifiedAt: null,
  };
  if (state.failureNotifiedAt) {
    const settings = safeSettings(deps);
    if (settings?.notifications !== false) {
      deps.notify(deps.messages.recoveredTitle, deps.messages.recoveredBody);
    }
    patch.failureNotifiedAt = null;
  }
  writeState(deps.roots, patch);
}

function recordFailure(deps: AutosyncDeps, settings: Settings, error: Error): void {
  const state = readState(deps.roots);
  const lastError = oneLine(error.message);
  if (error instanceof PushRaceError || error.name === "PushRaceError") {
    // Contention with another machine is not an outage; it must not push this
    // machine into the backoff meant for a dead network.
    writeState(deps.roots, { lastError, lastOutcome: "lost a push race" });
    return;
  }
  const failures = failureCount(state) + 1;
  const patch: Partial<AutosyncState> = {
    consecutiveFailures: failures,
    lastError,
    lastFailureAt: deps.now(),
    lastOutcome: "failed",
  };
  const notifications = settings.notifications !== false;
  if (
    (error instanceof LargeChangeError || error.name === "LargeChangeError") &&
    !state.largeChangeNotifiedAt
  ) {
    const shown = notifications && deps.notify(deps.messages.largeTitle, deps.messages.largeBody);
    patch.largeChangeNotifiedAt = deps.now();
    if (shown) patch.failureNotifiedAt = deps.now();
  }
  if (
    failures >= MAX_CONSECUTIVE_FAILURES &&
    !state.failureNotifiedAt &&
    !patch.failureNotifiedAt
  ) {
    const minutes = Math.round(backoffDelayMs(failures) / 60000);
    const shown =
      notifications &&
      deps.notify(deps.messages.backoffTitle, deps.messages.backoffBody(failures, minutes));
    // Recorded even when notifications are off, so recovery is announced
    // consistently if they are switched back on.
    patch.failureNotifiedAt = deps.now();
    deps.log(`backing off after ${failures} failures (notified: ${Boolean(shown)})`);
  }
  writeState(deps.roots, patch);
}

function safeSettings(deps: AutosyncDeps): Settings | undefined {
  try {
    return deps.loadSettings();
  } catch {
    return undefined;
  }
}

function maybeSelfUpdate(deps: AutosyncDeps, settings: Settings): void {
  if (!settings.autosync.autoUpdate || !deps.selfUpdate) return;
  const state = readState(deps.roots);
  if (deps.now() - (state.lastUpdateCheckAt ?? 0) < UPDATE_CHECK_MS) return;
  writeState(deps.roots, { lastUpdateCheckAt: deps.now() });
  try {
    deps.log(`update: ${deps.selfUpdate()}`);
  } catch (error) {
    deps.log(`update FAILED (${oneLine((error as Error).message)})`);
  }
}

// ── Default wiring ──────────────────────────────────────────────────────────

/** Directories whose writes mean "someone is working right now". */
export function watchedTrees(roots: Roots, settings: Settings): string[] {
  const dirs = [roots.config];
  if (settings.includeSkills) dirs.push(roots.agents);
  return dirs;
}

/** Untracked trees that a receive writes over. */
export function untrackedTrees(roots: Roots, settings: Settings, home: string): string[] {
  const dirs: string[] = [];
  if (settings.includeSkills) dirs.push(roots.agents);
  for (const entry of settings.extraPaths) {
    dirs.push(path.isAbsolute(entry) ? entry : path.join(home, entry));
  }
  return dirs;
}

export function defaultDeps(
  roots: Roots,
  overrides: Partial<AutosyncDeps> & { home: string },
): AutosyncDeps {
  const settingsLoader = () => loadSettings(roots.config);
  return {
    roots,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    loadSettings: settingsLoader,
    push: (options) => push(options),
    pull: (options) => pull(options),
    fetchBehind: () => {
      const settings = settingsLoader();
      const branch = repoBranch(settings);
      const fetched = git(["fetch", "origin", branch], { cwd: roots.config, timeoutMs: 120_000 });
      if (!fetched.ok) return { ok: false, behind: 0, error: oneLine(fetched.stderr) };
      const count = git(["rev-list", "--count", `HEAD..origin/${branch}`], { cwd: roots.config });
      return { ok: true, behind: Number(count.stdout) || 0 };
    },
    repoSnapshot: () => snapshotRepo(roots.config, repoBranch(settingsLoader())),
    newestWrite: (settings) =>
      newestWrite(watchedTrees(roots, settings), settings.guard?.skipDirs ?? []),
    newestUntrackedWrite: (settings) =>
      newestWrite(untrackedTrees(roots, settings, overrides.home), settings.guard?.skipDirs ?? []),
    stageOutTime: () => readStageOutMarkTime(roots.config),
    tryLock: () => {
      const lock = acquireSyncLock(roots.config, { waitMs: 0 });
      return lock ? { release: () => releaseSyncLock(lock) } : null;
    },
    notify: () => false,
    log: (line) => appendLog(roots, line),
    messages: ENGLISH_MESSAGES,
    ...overrides,
  };
}

/** Local view of the repository: no network. */
export function snapshotRepo(root: string, branch: string): RepoSnapshot {
  const status = git(["status", "--porcelain", "--", ".", ...excludePathspecs()], { cwd: root });
  if (!status.ok) return { ok: false, dirty: false, ahead: 0, error: oneLine(status.stderr) };
  const ahead = git(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: root });
  return {
    ok: true,
    dirty: realChanges(root, status.stdout) > 0,
    ahead: ahead.ok ? Number(ahead.stdout) || 0 : 0,
  };
}

/**
 * Uncommitted files, not counting the config file when its only difference
 * is this machine's overrides — the expected, permanent difference.
 */
function realChanges(root: string, porcelain: string): number {
  const paths = parsePorcelainPaths(porcelain);
  if (paths.length === 0) return 0;
  const configFile = findConfigFile(root);
  if (!configFile) return paths.length;
  const rel = path.relative(root, configFile).split(path.sep).join("/");
  if (!paths.includes(rel)) return paths.length;
  const head = git(["show", `HEAD:${rel}`], { cwd: root });
  if (!configMatchesRepo(root, head.ok ? head.stdout : undefined)) return paths.length;
  return paths.length - 1;
}
