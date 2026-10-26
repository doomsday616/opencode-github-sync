import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appendLog, readState, tailLog, writeState } from "../core/autosync.js";
import { redactValue, writeBundle } from "../core/bundle.js";
import { compareWithRemote } from "../core/compare.js";
import { setChildProxy } from "../core/env.js";
import { git } from "../core/git.js";
import type { GuardReport } from "../core/guard.js";
import { fileHistory, listDevices, restoreFile, trackedFiles } from "../core/history.js";
import { hostAlias, sanitizeAlias } from "../core/host.js";
import { parseJsonc } from "../core/jsonc.js";
import { withSyncLock } from "../core/lock.js";
import { findConfigFile, loadOverrides } from "../core/overrides.js";
import { type Roots, getRoots } from "../core/paths.js";
import { listRecovery } from "../core/recovery.js";
import { CollectingReporter } from "../core/reporter.js";
import {
  MIN_AUTOSYNC_INTERVAL,
  OVERRIDES_TEMPLATE,
  type Settings,
  loadSettings,
  overridesPath,
  repoBranch,
  repoUrl,
  saveSettings,
  settingsPath,
} from "../core/settings.js";
import {
  SetupError,
  discoverSyncRepos,
  ghAvailable,
  githubTargetFromUrl,
  initSync,
  isRepoUrl,
  linkByUrl,
  linkSync,
  repoIsPrivate,
  repoLabel,
  unlinkSync,
} from "../core/setup.js";
import { sqliteAvailable } from "../core/sqlite.js";
import { type SyncResult, formatBytes, pull, push } from "../core/sync.js";
import {
  type SchedulerApi,
  type UpdateApi,
  applyLocalSettings,
  formatTime,
  isValidProxy,
  lastCommitTime,
  nextRunEstimate,
  realScheduler,
  realUpdater,
  tomorrowMorning,
} from "./app.js";
import { type Lang, type MessageKey, ago, getLang, setLang, t } from "./i18n.js";
import {
  banner,
  changeList,
  createCliReporter,
  detail,
  fail,
  heading,
  info,
  keyValue,
  ok,
  outcome,
  summaryLine,
  warn,
  write,
} from "./render.js";
import { paint, style } from "./theme.js";
import type { Choice, Ui } from "./ui.js";

export interface MenuDeps {
  ui: Ui;
  roots?: Roots;
  scheduler?: SchedulerApi;
  updater?: UpdateApi;
  /** Opens a file for editing; returns false when no editor could start. */
  openEditor?: (file: string) => boolean;
  now?: () => number;
  /** Directory the support bundle is written to. */
  cwd?: string;
}

interface Ctx {
  ui: Ui;
  roots: Roots;
  scheduler: SchedulerApi;
  updater: UpdateApi;
  openEditor: (file: string) => boolean;
  now: () => number;
  cwd: string;
}

type Next = "stay" | "exit";

// ── Entry ───────────────────────────────────────────────────────────────────

export async function runMenu(deps: MenuDeps): Promise<void> {
  const ctx: Ctx = {
    ui: deps.ui,
    roots: deps.roots ?? getRoots(),
    scheduler: deps.scheduler ?? realScheduler,
    updater: deps.updater ?? realUpdater,
    openEditor: deps.openEditor ?? defaultEditor,
    now: deps.now ?? Date.now,
    cwd: deps.cwd ?? process.cwd(),
  };

  if (!repoUrl(settings(ctx))) {
    const next = await firstRun(ctx);
    if (next === "exit") return;
  }

  for (;;) {
    const s = settings(ctx);
    header(ctx, s);
    const choice = await ctx.ui.select<string>("", [
      { value: "sync", label: t("menuSync"), key: "1" },
      { value: "what", label: t("menuWhat"), key: "2" },
      { value: "auto", label: t("menuAutosync"), key: "3" },
      { value: "update", label: t("menuUpdate"), key: "4" },
      { value: "overrides", label: t("menuOverrides"), key: "5" },
      { value: "diag", label: t("menuDiagnostics"), key: "6" },
      { value: "danger", label: t("menuDanger"), key: "7" },
      { value: "uninstall", label: t("menuUninstall"), key: "8" },
      { value: "proxy", label: t("menuProxy"), key: "p" },
      { value: "restore", label: t("menuRestore"), key: "r" },
      { value: "devices", label: t("menuDevices"), key: "d" },
      { value: "guard", label: t("menuGuard"), key: "g" },
      { value: "lang", label: t("menuLanguage"), key: "l" },
      { value: "quit", label: t("quit"), key: "q" },
    ]);
    if (choice === undefined || choice === "quit") return;
    const next = await dispatch(ctx, choice);
    if (next === "exit") return;
  }
}

async function dispatch(ctx: Ctx, choice: string): Promise<Next> {
  try {
    switch (choice) {
      case "sync":
        return await syncMenu(ctx);
      case "what":
        return await whatMenu(ctx);
      case "auto":
        return await autosyncMenu(ctx);
      case "update":
        return await updateMenu(ctx);
      case "overrides":
        return await overridesMenu(ctx);
      case "diag":
        return await diagnosticsMenu(ctx);
      case "danger":
        return await dangerMenu(ctx);
      case "uninstall":
        return await uninstallMenu(ctx);
      case "proxy":
        return await proxyMenu(ctx);
      case "restore":
        return await restoreMenu(ctx);
      case "devices":
        return await devicesMenu(ctx);
      case "guard":
        return await guardMenu(ctx);
      case "lang":
        return await languageMenu(ctx);
    }
  } catch (error) {
    write();
    fail((error as Error).message);
    write();
    await ctx.ui.pause(t("pressKey"));
  }
  return "stay";
}

function settings(ctx: Ctx): Settings {
  return loadSettings(ctx.roots.config);
}

function save(ctx: Ctx, mutate: (s: Settings) => void): Settings {
  const s = settings(ctx);
  mutate(s);
  saveSettings(s, ctx.roots.config);
  return s;
}

function onOff(value: boolean): string {
  return value ? paint(t("on"), style.green) : paint(t("off"), style.muted);
}

// ── Header ──────────────────────────────────────────────────────────────────

function header(ctx: Ctx, s: Settings): void {
  banner();
  keyValue(t("hdrRepo"), paint(repoLabel(s) ?? "-", style.text));
  keyValue(t("hdrMachine"), paint(hostAlias(s.machineAlias), style.text));
  const last = lastCommitTime(ctx.roots);
  keyValue(
    t("hdrLastSync"),
    last ? `${formatTime(last)}  ${paint(ago(last, ctx.now()), style.faint)}` : t("never"),
  );

  const now = ctx.now();
  let auto = paint(t("off"), style.muted);
  if (s.autosync.enabled) {
    if (s.autosync.pausedUntil > now) {
      auto = paint(
        t("hdrAutosyncPaused", { time: formatTime(s.autosync.pausedUntil) }),
        style.yellow,
      );
    } else {
      const next = nextRunEstimate(ctx.roots, s, now);
      const nextText = next
        ? t("inMinutes", { n: Math.max(1, Math.round((next - now) / 60000)) })
        : t("soon");
      auto = paint(
        t("hdrAutosyncOn", { n: s.autosync.intervalMinutes, next: nextText }),
        style.green,
      );
    }
  }
  keyValue(t("hdrAutosync"), auto);

  const state = readState(ctx.roots);
  if (state.lastError && state.lastFailureAt) {
    const failures = state.consecutiveFailures ?? 0;
    keyValue(
      t("hdrLastFailure"),
      paint(
        `${ago(state.lastFailureAt, now)} · ${t("hdrFailures", { n: failures, error: truncate(state.lastError, 60) })}`,
        style.red,
      ),
    );
  }
  write();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── First run ───────────────────────────────────────────────────────────────

async function firstRun(ctx: Ctx): Promise<Next> {
  banner();
  info(t("firstTitle"));
  write();
  const mode = await ctx.ui.select<string>("", [
    { value: "cli", label: t("firstInstallOnly"), key: "1" },
    { value: "link", label: t("firstLink"), key: "2" },
    { value: "primary", label: t("firstPrimary"), key: "3", hint: t("recommended") },
    { value: "quit", label: t("quit"), key: "q" },
  ]);
  if (mode === undefined || mode === "quit") return "exit";
  if (mode === "cli") {
    ok(t("installOnlyDone"));
    write();
    return "exit";
  }
  const linked = await linkFlow(ctx);
  if (!linked) return "exit";
  const resolved = await resolveFirstSync(ctx);
  if (!resolved) return "exit";
  if (mode === "primary") await enableAutosync(ctx);
  return "stay";
}

async function linkFlow(ctx: Ctx): Promise<boolean> {
  const how = await ctx.ui.select<string>(t("linkTitle"), [
    { value: "create", label: t("linkCreate"), key: "1" },
    { value: "existing", label: t("linkExisting"), key: "2" },
    { value: "back", label: t("back"), key: "b" },
  ]);
  if (how === undefined || how === "back") return false;
  const reporter = createCliReporter();

  if (how === "create") {
    if (!ghAvailable()) {
      warn(t("linkNeedGh"));
      return false;
    }
    const name = await ctx.ui.text(t("linkAskName"), "my-opencode-config");
    if (name === undefined) return false;
    const result = initSync({ repo: name, reporter, roots: ctx.roots });
    ok(t("linkDone", { repo: `${result.target.owner}/${result.target.name}` }));
    return true;
  }

  let target: string | undefined;
  const found = ghAvailable() ? safe(() => discoverSyncRepos(), [] as string[]) : [];
  if (found.length > 0) {
    const choices: Choice<string>[] = found.slice(0, 9).map((r, i) => ({
      value: r,
      label: r,
      key: String(i + 1),
    }));
    choices.push({ value: "", label: t("linkOther"), key: "o" });
    target = await ctx.ui.select<string>(t("linkFound"), choices);
    if (target === undefined) return false;
  }
  if (!target) {
    target = await ctx.ui.text(t("linkAskExisting"));
    if (!target) return false;
  }
  const result = isRepoUrl(target)
    ? linkByUrl({ url: target, reporter, roots: ctx.roots })
    : linkSync({ repo: target, reporter, roots: ctx.roots });
  ok(
    t("linkDone", {
      repo: result.target.owner ? `${result.target.owner}/${result.target.name}` : target,
    }),
  );
  return true;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The first sync on a newly linked machine. When the repository and the
 * machine differ the user picks a side; nothing is replaced silently.
 */
async function resolveFirstSync(ctx: Ctx, prefer?: "repo" | "local"): Promise<boolean> {
  const s = settings(ctx);
  const remote = repoUrl(s)!;
  if (fs.existsSync(path.join(ctx.roots.config, ".git"))) {
    // Already a working copy (re-link): an ordinary sync handles it.
    await runSync(ctx, "both");
    return true;
  }
  const comparison = compareWithRemote(ctx.roots.config, remote, repoBranch(s), s.guard.skipDirs);
  if (comparison.empty) {
    info(t("resolveEmpty"));
    await runSync(ctx, "push");
    return true;
  }
  if (comparison.differences.length === 0) {
    info(t("resolveSame"));
    await runSync(ctx, "receive");
    return true;
  }

  for (;;) {
    let choice: string | undefined = prefer;
    if (!choice) {
      write();
      warn(t("resolveTitle", { n: comparison.differences.length }));
      choice = await ctx.ui.select<string>("", [
        { value: "repo", label: t("resolveRepo"), key: "1" },
        { value: "local", label: t("resolveLocal"), key: "2" },
        { value: "diff", label: t("resolveDiff"), key: "3" },
        { value: "back", label: t("back"), key: "b" },
      ]);
    }
    if (choice === undefined || choice === "back") return false;
    if (choice === "diff") {
      const labels: Record<string, MessageKey> = {
        onlyLocal: "diffOnlyHere",
        different: "diffDifferent",
        onlyRemote: "diffOnlyRepo",
      };
      for (const d of comparison.differences.slice(0, 40)) {
        detail(`${paint(t(labels[d.kind]!).padEnd(12), style.yellow)} ${d.path}`);
      }
      if (comparison.differences.length > 40) {
        detail(t("diffMore", { n: comparison.differences.length - 40 }));
      }
      continue;
    }
    if (choice === "repo") {
      await runSync(ctx, "receive");
      const latest = listRecovery(ctx.roots)[0];
      if (latest) info(t("recoverySaved", { dir: latest }));
      return true;
    }
    await runSync(ctx, "push", { adopt: "local" });
    return true;
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function syncMenu(ctx: Ctx): Promise<Next> {
  const choice = await ctx.ui.select<string>(t("syncTitle"), [
    { value: "both", label: t("syncBoth"), key: "1" },
    { value: "receive", label: t("syncReceive"), key: "2" },
    { value: "push", label: t("syncPush"), key: "3" },
    { value: "preview", label: t("syncPreview"), key: "4" },
    { value: "back", label: t("back"), key: "b" },
  ]);
  if (choice === undefined || choice === "back") return "stay";
  if (choice === "preview") {
    const go = await preview(ctx);
    if (go) await runSync(ctx, "both");
  } else {
    await runSync(ctx, choice as "both" | "receive" | "push");
  }
  await ctx.ui.pause(t("pressKey"));
  return "stay";
}

async function confirmLarge(ctx: Ctx, report: GuardReport): Promise<boolean> {
  const limits = settings(ctx).guard;
  write();
  warn(t("largeTitle"));
  if (report.reasons.includes("files"))
    detail(t("largeFiles", { n: report.addedFiles, limit: limits.maxFiles }));
  if (report.reasons.includes("bytes")) {
    detail(
      t("largeBytes", {
        size: formatBytes(report.totalBytes),
        limit: formatBytes(limits.maxBytes),
      }),
    );
  }
  for (const f of report.oversized.slice(0, 5)) {
    detail(
      t("largeFile", {
        path: f.path,
        size: formatBytes(f.bytes),
        limit: formatBytes(limits.maxFileBytes),
      }),
    );
  }
  return ctx.ui.confirm(t("largeConfirm"), false);
}

async function runSync(
  ctx: Ctx,
  mode: "both" | "receive" | "push",
  extra: { adopt?: "local" | "remote"; force?: boolean } = {},
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const reporter = createCliReporter();
  await withSyncLock(ctx.roots.config, { waitMs: 60_000 }, async () => {
    if (mode !== "receive") {
      try {
        results.push(
          await push({
            roots: ctx.roots,
            reporter,
            force: extra.force,
            adopt: extra.adopt,
            confirmLarge: (r) => confirmLarge(ctx, r),
          }),
        );
      } catch (error) {
        if ((error as Error).name === "LargeChangeError") {
          warn(t("largeRefused"));
          return;
        }
        throw error;
      }
    }
    if (mode !== "push") {
      results.push(
        await pull({ roots: ctx.roots, reporter, force: mode === "receive" && extra.force }),
      );
    }
  });
  for (const r of results) outcome(r.message, r.changed);
  if (results.some((r) => r.restartRequired && r.changed)) info(t("restartHint"));
  return results;
}

async function preview(ctx: Ctx): Promise<boolean> {
  const reporter = new CollectingReporter();
  const out = await withSyncLock(ctx.roots.config, { waitMs: 60_000 }, () =>
    push({ roots: ctx.roots, reporter, dryRun: true }),
  );
  let incoming: SyncResult | undefined;
  try {
    incoming = await withSyncLock(ctx.roots.config, { waitMs: 60_000 }, () =>
      pull({ roots: ctx.roots, reporter, dryRun: true }),
    );
  } catch {
    incoming = undefined;
  }
  const outFiles = out.files;
  const inFiles = incoming?.files ?? [];
  if (outFiles.length === 0 && inFiles.length === 0) {
    ok(t("previewNothing"));
    return false;
  }
  if (outFiles.length > 0) {
    heading(t("previewOutgoing", { n: outFiles.length }));
    write(`  ${summaryLine(out.summary)}`);
    changeList(outFiles);
  }
  if (inFiles.length > 0 && incoming) {
    heading(t("previewIncoming", { n: inFiles.length }));
    write(`  ${summaryLine(incoming.summary)}`);
    changeList(inFiles);
  }
  write();
  return ctx.ui.confirm(t("previewConfirm"), true);
}

// ── What to sync ────────────────────────────────────────────────────────────

type CatValue =
  | "config"
  | "instructions"
  | "agents"
  | "commands"
  | "plugins"
  | "skills"
  | "credentials"
  | "sessions";

async function whatMenu(ctx: Ctx): Promise<Next> {
  for (;;) {
    const choice = await ctx.ui.select<string>(t("whatTitle"), [
      { value: "cats", label: t("whatCategories"), key: "1" },
      { value: "sessions", label: t("whatSessions"), key: "2" },
      { value: "extra", label: t("whatExtra"), key: "3" },
      { value: "back", label: t("back"), key: "b" },
    ]);
    if (choice === undefined || choice === "back") return "stay";
    if (choice === "cats") await categoriesMenu(ctx);
    if (choice === "sessions") await sessionSettings(ctx);
    if (choice === "extra") await extraPathsMenu(ctx);
  }
}

/** Whether the linked repository is confirmed private, public, or unknown. */
function repoVisibility(s: Settings): "private" | "public" | "unknown" {
  const target =
    s.repo.owner && s.repo.name
      ? { owner: s.repo.owner, name: s.repo.name }
      : s.repo.url
        ? githubTargetFromUrl(s.repo.url)
        : undefined;
  if (!target || !ghAvailable()) return "unknown";
  return repoIsPrivate(target) ? "private" : "public";
}

async function categoriesMenu(ctx: Ctx): Promise<void> {
  const s = settings(ctx);
  const choices: Choice<CatValue>[] = [
    { value: "config", label: t("catConfig") },
    { value: "instructions", label: t("catInstructions") },
    { value: "agents", label: t("catAgents") },
    { value: "commands", label: t("catCommands") },
    { value: "plugins", label: t("catPlugins") },
    { value: "skills", label: t("catSkills") },
    { value: "credentials", label: t("catCredentials") },
    { value: "sessions", label: t("catSessions") },
  ];
  const selected = new Set<CatValue>();
  for (const key of ["config", "instructions", "agents", "commands", "plugins"] as const) {
    if (s.categories[key]) selected.add(key);
  }
  if (s.includeSkills) selected.add("skills");
  if (s.includeCredentials) selected.add("credentials");
  if (s.sessions.enabled) selected.add("sessions");

  const footer = ctx.ui.io.interactive ? t("checkboxKeys") : t("checkboxLines");
  const result = await ctx.ui.checkbox(t("whatCategories"), choices, selected, footer);
  if (!result) {
    info(t("cancelled"));
    return;
  }

  // Credentials and sessions are private data: never to a public repository.
  for (const sensitive of ["credentials", "sessions"] as const) {
    if (!result.has(sensitive) || selected.has(sensitive)) continue;
    const visibility = repoVisibility(s);
    if (visibility === "public") {
      fail(t("credPublic"));
      result.delete(sensitive);
      continue;
    }
    if (visibility === "unknown") {
      warn(t("credUnverified"));
      if (!(await ctx.ui.confirm(t("credConfirm"), false))) result.delete(sensitive);
    }
    if (sensitive === "sessions" && result.has("sessions")) {
      warn(t("sessionsWarn"));
      if (!(await sqliteAvailable())) warn(t("sessionsNeedNode"));
    }
  }

  save(ctx, (n) => {
    for (const key of ["config", "instructions", "agents", "commands", "plugins"] as const) {
      n.categories[key] = result.has(key);
    }
    n.includeSkills = result.has("skills");
    n.includeCredentials = result.has("credentials");
    n.sessions.enabled = result.has("sessions");
  });
  ok(t("saved"));
}

async function askNumber(
  ctx: Ctx,
  question: string,
  current: number,
  min = 1,
): Promise<number | undefined> {
  const answer = await ctx.ui.text(question, String(current));
  if (answer === undefined) return undefined;
  const value = Number(answer);
  if (!Number.isFinite(value) || value < min) {
    warn(t("invalidValue", { value: answer }));
    return undefined;
  }
  return value;
}

async function sessionSettings(ctx: Ctx): Promise<void> {
  const s = settings(ctx);
  warn(t("sessionsWarn"));
  const days = await askNumber(ctx, t("sessionsDays"), s.sessions.days);
  if (days === undefined) return;
  const max = await askNumber(ctx, t("sessionsMax"), s.sessions.maxSessions);
  if (max === undefined) return;
  const mb = await askNumber(
    ctx,
    t("sessionsMb"),
    Math.round(s.sessions.maxSessionBytes / 1048576),
  );
  if (mb === undefined) return;
  save(ctx, (n) => {
    n.sessions.days = Math.floor(days);
    n.sessions.maxSessions = Math.floor(max);
    n.sessions.maxSessionBytes = Math.floor(mb * 1048576);
  });
  ok(t("saved"));
}

async function extraPathsMenu(ctx: Ctx): Promise<void> {
  for (;;) {
    const s = settings(ctx);
    if (s.extraPaths.length === 0) detail(t("extraEmpty"));
    const choices: Choice<string>[] = [{ value: "+add", label: t("extraAdd"), key: "a" }];
    s.extraPaths.forEach((p, i) =>
      choices.push({ value: p, label: t("extraRemove", { path: p }), key: String(i + 1) }),
    );
    choices.push({ value: "+back", label: t("back"), key: "b" });
    const choice = await ctx.ui.select<string>(t("extraTitle"), choices);
    if (choice === undefined || choice === "+back") return;
    if (choice === "+add") {
      const value = await ctx.ui.text(t("extraAsk"));
      if (!value) continue;
      save(ctx, (n) => {
        if (!n.extraPaths.includes(value)) n.extraPaths.push(value);
      });
      ok(t("saved"));
    } else {
      save(ctx, (n) => {
        n.extraPaths = n.extraPaths.filter((p) => p !== choice);
      });
      ok(t("saved"));
    }
  }
}

// ── Autosync ────────────────────────────────────────────────────────────────

export async function enableAutosync(ctx: Pick<Ctx, "roots" | "scheduler">): Promise<boolean> {
  const s = loadSettings(ctx.roots.config);
  s.autosync.enabled = true;
  saveSettings(s, ctx.roots.config);
  const result = ctx.scheduler.install(ctx.roots, s);
  if (!result.ok) {
    fail(t("autoInstallFailed", { error: result.detail.join("; ") }));
    return false;
  }
  for (const w of result.warnings) warn(t("autoWarning", { text: w }));
  ok(t("autoOn", { n: s.autosync.intervalMinutes }));
  return true;
}

export function disableAutosync(ctx: Pick<Ctx, "roots" | "scheduler">): void {
  const s = loadSettings(ctx.roots.config);
  s.autosync.enabled = false;
  saveSettings(s, ctx.roots.config);
  ctx.scheduler.uninstall(ctx.roots);
  ok(t("autoOff"));
}

async function autosyncMenu(ctx: Ctx): Promise<Next> {
  for (;;) {
    const s = settings(ctx);
    const choice = await ctx.ui.select<string>(t("autoTitle"), [
      s.autosync.enabled
        ? { value: "off", label: t("autoTurnOff"), key: "1" }
        : { value: "on", label: t("autoTurnOn"), key: "1" },
      { value: "interval", label: t("autoInterval", { n: s.autosync.intervalMinutes }), key: "2" },
      {
        value: "loggedoff",
        label: t("autoLoggedOff", { state: onOff(s.autosync.runWhenLoggedOff) }),
        key: "3",
      },
      { value: "pause", label: t("autoPause"), key: "4" },
      {
        value: "notify",
        label: t("autoNotifications", { state: onOff(s.notifications) }),
        key: "5",
      },
      { value: "reset", label: t("autoReset"), key: "6" },
      { value: "back", label: t("back"), key: "b" },
    ]);
    if (choice === undefined || choice === "back") return "stay";
    if (choice === "on") await enableAutosync(ctx);
    if (choice === "off") disableAutosync(ctx);
    if (choice === "interval") await intervalMenu(ctx);
    if (choice === "loggedoff") await loggedOffMenu(ctx);
    if (choice === "pause") await pauseMenu(ctx);
    if (choice === "notify") {
      save(ctx, (n) => {
        n.notifications = !n.notifications;
      });
      ok(t("saved"));
    }
    if (choice === "reset") {
      const before = readState(ctx.roots).consecutiveFailures ?? 0;
      writeState(ctx.roots, {
        consecutiveFailures: 0,
        lastError: null,
        failureNotifiedAt: null,
        lastAttemptAt: 0,
      });
      ok(t("resetDone", { n: before }));
    }
  }
}

async function intervalMenu(ctx: Ctx): Promise<void> {
  const presets = [5, 10, 15, 30, 60];
  const choices: Choice<number>[] = presets.map((n, i) => ({
    value: n,
    label: t("intervalMinutes", { n }),
    key: String(i + 1),
  }));
  choices.push({ value: -1, label: t("intervalCustom"), key: "c" });
  let minutes = await ctx.ui.select<number>(t("intervalAsk"), choices);
  if (minutes === undefined) return;
  if (minutes === -1) {
    const custom = await askNumber(
      ctx,
      t("intervalAsk"),
      settings(ctx).autosync.intervalMinutes,
      MIN_AUTOSYNC_INTERVAL,
    );
    if (custom === undefined) return;
    minutes = Math.floor(custom);
  }
  const s = save(ctx, (n) => {
    n.autosync.intervalMinutes = minutes!;
  });
  if (s.autosync.enabled) await enableAutosync(ctx);
  else ok(t("saved"));
}

async function loggedOffMenu(ctx: Ctx): Promise<void> {
  if (process.platform !== "win32") {
    info(t("notWindows"));
  }
  info(t("loggedOffExplain"));
  const s = save(ctx, (n) => {
    n.autosync.runWhenLoggedOff = !n.autosync.runWhenLoggedOff;
  });
  ok(t("autoLoggedOff", { state: onOff(s.autosync.runWhenLoggedOff) }));
  if (s.autosync.runWhenLoggedOff && process.platform === "win32" && !ctx.scheduler.elevated()) {
    warn(t("loggedOffNeedAdmin"));
    return;
  }
  if (s.autosync.enabled) await enableAutosync(ctx);
}

async function pauseMenu(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  const choice = await ctx.ui.select<number>(t("autoPause"), [
    { value: now + 3600_000, label: t("pause1h"), key: "1" },
    { value: now + 4 * 3600_000, label: t("pause4h"), key: "2" },
    { value: tomorrowMorning(now), label: t("pauseTomorrow"), key: "3" },
    { value: 0, label: t("pauseResume"), key: "4" },
  ]);
  if (choice === undefined) return;
  save(ctx, (n) => {
    n.autosync.pausedUntil = choice;
  });
  ok(choice ? t("pausedUntil", { time: formatTime(choice) }) : t("resumed"));
}

// ── Update ──────────────────────────────────────────────────────────────────

async function updateMenu(ctx: Ctx): Promise<Next> {
  for (;;) {
    const s = settings(ctx);
    const choice = await ctx.ui.select<string>(t("updTitle"), [
      { value: "check", label: t("updCheck"), key: "1" },
      { value: "upgrade", label: t("updUpgrade"), key: "2" },
      { value: "auto", label: t("updAuto", { state: onOff(s.autosync.autoUpdate) }), key: "3" },
      { value: "back", label: t("back"), key: "b" },
    ]);
    if (choice === undefined || choice === "back") return "stay";
    if (choice === "check") {
      const result = ctx.updater.check();
      if (result.error) fail(t("updFailed", { error: result.error }));
      else {
        info(t("updVersions", { current: result.current, latest: result.latest ?? "?" }));
        ok(result.newer ? t("updNewer") : t("updLatest"));
      }
    }
    if (choice === "upgrade") {
      info(t("updRunning"));
      ctx.updater.install();
      ok(t("updDone"));
      return "exit";
    }
    if (choice === "auto") {
      save(ctx, (n) => {
        n.autosync.autoUpdate = !n.autosync.autoUpdate;
      });
      ok(t("saved"));
    }
  }
}

// ── Overrides ───────────────────────────────────────────────────────────────

function defaultEditor(file: string): boolean {
  const editor =
    process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad.exe" : "");
  if (editor) {
    const result = spawnSync(editor, [file], {
      stdio: "inherit",
      shell: !path.isAbsolute(editor) && /\s/.test(editor),
    });
    return !result.error;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return !spawnSync(opener, [file], { stdio: "ignore" }).error;
}

function flatten(value: unknown, prefix = ""): [string, unknown][] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [[prefix, value]];
    return entries.flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, value]];
}

function lookup(obj: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined,
      obj,
    );
}

async function overridesMenu(ctx: Ctx): Promise<Next> {
  const file = overridesPath(ctx.roots.config);
  for (;;) {
    const choice = await ctx.ui.select<string>(t("ovTitle"), [
      { value: "open", label: t("ovOpen"), key: "1" },
      { value: "show", label: t("ovShow"), key: "2" },
      { value: "back", label: t("back"), key: "b" },
    ]);
    if (choice === undefined || choice === "back") return "stay";
    if (choice === "open") {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, OVERRIDES_TEMPLATE);
      }
      if (!ctx.openEditor(file)) warn(t("ovEditorFailed", { file }));
    }
    if (choice === "show") showOverrides(ctx, file);
  }
}

function showOverrides(ctx: Ctx, file: string): void {
  detail(t("ovFile", { file }));
  const overrides = loadOverrides(ctx.roots.config);
  if (Object.keys(overrides).length === 0) {
    info(t("ovNone"));
    return;
  }
  let shared: unknown;
  const configFile = findConfigFile(ctx.roots.config);
  if (configFile) {
    const rel = path.relative(ctx.roots.config, configFile).split(path.sep).join("/");
    const head = git(["show", `HEAD:${rel}`], { cwd: ctx.roots.config });
    if (head.ok) shared = safe(() => parseJsonc(head.stdout), undefined);
  }
  for (const [key, value] of flatten(overrides)) {
    const before = lookup(shared, key);
    const after =
      value === null ? paint(t("ovRemoved"), style.red) : paint(JSON.stringify(value), style.green);
    write(
      `  ${paint(key, style.cyan)}  ${paint(JSON.stringify(before) ?? "-", style.faint)} → ${after}`,
    );
  }
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

function toolVersion(cmd: string, args: string[]): string | undefined {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout).split(/\r?\n/)[0]?.trim();
}

export function collectDiagnostics(ctx: Pick<Ctx, "roots" | "scheduler">): [string, string][] {
  const rows: [string, string][] = [];
  rows.push([t("diagNode"), process.version]);
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  if (major < 22 || (major === 22 && minor < 5)) rows.push(["", t("diagSessionsNode")]);
  rows.push([t("diagGit"), toolVersion("git", ["--version"]) ?? t("diagMissing")]);
  rows.push([t("diagGh"), toolVersion("gh", ["--version"]) ?? t("diagMissing")]);
  const s = safe(() => loadSettings(ctx.roots.config), undefined);
  const remote = s ? repoUrl(s) : undefined;
  if (remote) {
    const probe = git(["ls-remote", "--heads", remote], {
      cwd: ctx.roots.config,
      timeoutMs: 60_000,
    });
    rows.push([
      t("diagNetwork"),
      probe.ok
        ? t("diagOk")
        : t("diagFail", { error: (probe.stderr.split("\n")[0] ?? "").slice(0, 120) }),
    ]);
  }
  const sched = safe(() => ctx.scheduler.status(), { installed: false, kind: "none" as const });
  rows.push([
    t("diagScheduler"),
    sched.installed
      ? `${t("diagRegistered", { kind: sched.kind })}${sched.nextRun ? ` · ${sched.nextRun}` : ""}`
      : t("diagNotRegistered"),
  ]);
  if (fs.existsSync(path.join(ctx.roots.config, ".git"))) {
    const ignored = git(["check-ignore", "-q", "opencode-sync.jsonc"], { cwd: ctx.roots.config });
    rows.push([t("diagSettings"), ignored.ok ? t("diagIgnored") : t("diagNotIgnored")]);
  }
  return rows;
}

async function diagnosticsMenu(ctx: Ctx): Promise<Next> {
  heading(t("diagTitle"));
  for (const [k, v] of collectDiagnostics(ctx)) keyValue(k, v, 20);
  heading(t("diagLog"));
  for (const line of tailLog(ctx.roots, 15)) detail(line);
  write();
  const choice = await ctx.ui.select<string>("", [
    { value: "bundle", label: t("diagBundle"), key: "1" },
    { value: "back", label: t("back"), key: "b" },
  ]);
  if (choice === "bundle") {
    const file = exportBundle(ctx);
    ok(t("bundleWritten", { file }));
  }
  return "stay";
}

export function exportBundle(ctx: Pick<Ctx, "roots" | "scheduler" | "cwd">): string {
  const s = safe(() => loadSettings(ctx.roots.config), undefined);
  const entries = [
    {
      name: "diagnostics.txt",
      content: collectDiagnostics(ctx)
        .map(([k, v]) => `${k.padEnd(20)} ${v}`)
        .concat([
          `platform             ${process.platform} ${process.arch}`,
          `lang                 ${getLang()}`,
        ])
        .join("\n"),
    },
    { name: "settings.json", content: JSON.stringify(redactValue(s ?? {}), null, 2) },
    {
      name: "autosync-state.json",
      content: JSON.stringify(redactValue(readState(ctx.roots)), null, 2),
    },
    { name: "autosync.log", content: tailLog(ctx.roots, 400).join("\n") },
  ];
  const gitLog = git(["log", "-20", "--format=%h %cI %s"], { cwd: ctx.roots.config });
  if (gitLog.ok) entries.push({ name: "git-log.txt", content: gitLog.stdout });
  const status = git(["status", "--short"], { cwd: ctx.roots.config });
  if (status.ok) entries.push({ name: "git-status.txt", content: status.stdout });
  return writeBundle(ctx.cwd, entries);
}

// ── Danger zone ─────────────────────────────────────────────────────────────

const CONFIRM_WORD = "overwrite";

async function dangerMenu(ctx: Ctx): Promise<Next> {
  const choice = await ctx.ui.select<string>(t("dangerTitle"), [
    { value: "pull", label: t("dangerPull"), key: "1" },
    { value: "push", label: t("dangerPush"), key: "2" },
    { value: "back", label: t("back"), key: "b" },
  ]);
  if (choice === undefined || choice === "back") return "stay";
  warn(choice === "pull" ? t("dangerWarnPull") : t("dangerWarnPush"));
  if (!(await ctx.ui.confirmWord(t("dangerType"), CONFIRM_WORD))) {
    info(t("cancelled"));
    return "stay";
  }
  await runSync(ctx, choice === "pull" ? "receive" : "push", { force: true });
  await ctx.ui.pause(t("pressKey"));
  return "stay";
}

// ── Uninstall ───────────────────────────────────────────────────────────────

async function uninstallMenu(ctx: Ctx): Promise<Next> {
  heading(t("unTitle"));
  info(t("unKeep"));
  const removed = ctx.scheduler.uninstall(ctx.roots);
  ok(removed.removed ? t("unSchedulerRemoved") : t("unSchedulerNone"));
  save(ctx, (n) => {
    n.autosync.enabled = false;
  });
  if (await ctx.ui.confirm(t("unUnlink"), false)) {
    unlinkSync(ctx.roots);
    ok(t("unUnlinked"));
  }
  if (await ctx.ui.confirm(t("unNpm"), false)) {
    ctx.updater.uninstall();
    ok(t("unNpmDone"));
    return "exit";
  }
  return repoUrl(settings(ctx)) ? "stay" : "exit";
}

// ── Extras ──────────────────────────────────────────────────────────────────

async function proxyMenu(ctx: Ctx): Promise<Next> {
  const s = settings(ctx);
  info(t("proxyCurrent", { proxy: s.proxy || t("none") }));
  const value = await ctx.ui.text(t("proxyAsk"));
  if (value === undefined) return "stay";
  if (value && !isValidProxy(value)) {
    fail(t("proxyInvalid", { value }));
    return "stay";
  }
  const saved = save(ctx, (n) => {
    n.proxy = value;
  });
  applyLocalSettings(saved);
  ok(value ? t("proxySet") : t("proxyCleared"));
  return "stay";
}

async function restoreMenu(ctx: Ctx): Promise<Next> {
  const filter = await ctx.ui.text(t("rsAsk"));
  if (filter === undefined) return "stay";
  const files = trackedFiles(ctx.roots.config, filter).slice(0, 30);
  if (files.length === 0) {
    warn(t("rsNoMatch"));
    return "stay";
  }
  const file = await ctx.ui.select<string>(
    t("rsPickFile"),
    files.map((f, i) => ({ value: f, label: f, key: String(i + 1) })),
  );
  if (!file) return "stay";
  const versions = fileHistory(ctx.roots.config, file, 20);
  if (versions.length === 0) {
    warn(t("rsNoHistory"));
    return "stay";
  }
  const commit = await ctx.ui.select<string>(
    t("rsPickVersion"),
    versions.map((v, i) => ({
      value: v.commit,
      label: `${formatTime(Date.parse(v.date))}  ${v.commit.slice(0, 8)}`,
      hint: v.subject,
      key: String(i + 1),
    })),
  );
  if (!commit) return "stay";
  const version = versions.find((v) => v.commit === commit)!;
  if (
    !(await ctx.ui.confirm(
      t("rsConfirm", { file, date: formatTime(Date.parse(version.date)) }),
      false,
    ))
  ) {
    info(t("cancelled"));
    return "stay";
  }
  const result = restoreFile(ctx.roots, file, commit);
  ok(t("rsDone", { file }));
  if (result.recovery) info(t("recoverySaved", { dir: result.recovery }));
  if (await ctx.ui.confirm(t("rsPushNow"), false)) await runSync(ctx, "push");
  return "stay";
}

async function devicesMenu(ctx: Ctx): Promise<Next> {
  const s = settings(ctx);
  const me = hostAlias(s.machineAlias);
  const devices = listDevices(ctx.roots.config);
  heading(t("devTitle"));
  if (devices.length === 0) detail(t("devNone"));
  for (const d of devices) {
    const when = ago(Date.parse(d.lastSync), ctx.now());
    const tag = d.alias === me ? paint(`  (${t("devThis")})`, style.accent) : "";
    write(
      `  ${paint(d.alias.padEnd(24), style.text)} ${paint(t("devRow", { when, n: d.commits }), style.muted)}${tag}`,
    );
  }
  write();
  const choice = await ctx.ui.select<string>("", [
    { value: "rename", label: t("devRename"), key: "1" },
    { value: "back", label: t("back"), key: "b" },
  ]);
  if (choice === "rename") {
    const name = await ctx.ui.text(t("devAsk"), me);
    if (!name) return "stay";
    const alias = sanitizeAlias(name);
    save(ctx, (n) => {
      n.machineAlias = alias;
    });
    ok(t("devRenamed", { alias }));
  }
  return "stay";
}

async function guardMenu(ctx: Ctx): Promise<Next> {
  for (;;) {
    const g = settings(ctx).guard;
    const choice = await ctx.ui.select<string>(t("guardTitle"), [
      { value: "files", label: t("guardFiles", { n: g.maxFiles }), key: "1" },
      { value: "bytes", label: t("guardBytes", { size: formatBytes(g.maxBytes) }), key: "2" },
      { value: "file", label: t("guardFile", { size: formatBytes(g.maxFileBytes) }), key: "3" },
      { value: "skip", label: t("guardSkip", { dirs: g.skipDirs.join(", ") }), key: "4" },
      { value: "back", label: t("back"), key: "b" },
    ]);
    if (choice === undefined || choice === "back") return "stay";
    if (choice === "files") {
      const n = await askNumber(ctx, t("guardAskNumber"), g.maxFiles);
      if (n !== undefined) {
        save(ctx, (s) => {
          s.guard.maxFiles = Math.floor(n);
        });
      }
    }
    if (choice === "bytes" || choice === "file") {
      const key = choice === "bytes" ? "maxBytes" : "maxFileBytes";
      const n = await askNumber(ctx, t("guardAskMb"), Math.round(g[key] / 1048576));
      if (n !== undefined) {
        save(ctx, (s) => {
          s.guard[key] = Math.floor(n * 1048576);
        });
      }
    }
    if (choice === "skip") {
      const value = await ctx.ui.text(t("guardAskSkip"), g.skipDirs.join(", "));
      if (value !== undefined) {
        const dirs = value
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        save(ctx, (s) => {
          s.guard.skipDirs = dirs;
        });
      }
    }
  }
}

async function languageMenu(ctx: Ctx): Promise<Next> {
  const choice = await ctx.ui.select<string>(t("langTitle"), [
    { value: "", label: t("langAuto"), key: "1" },
    { value: "en", label: "English", key: "2" },
    { value: "zh-CN", label: "简体中文", key: "3" },
  ]);
  if (choice === undefined) return "stay";
  const s = save(ctx, (n) => {
    n.language = choice;
  });
  applyLocalSettings(s);
  if (choice) setLang(choice as Lang);
  ok(t("langSet"));
  return "stay";
}

// ── Non-interactive setup (installers) ──────────────────────────────────────

export interface SetupFlags {
  mode: "cli" | "link" | "auto";
  repo?: string;
  interval?: number;
  lang?: string;
  proxy?: string;
  prefer?: "repo" | "local";
}

/**
 * The non-interactive path the installers call with `--mode`. Mirrors the
 * first-run menu: link (creating the repository when `gh` can and it does not
 * exist), resolve the first sync by `prefer`, and with `auto` turn autosync on.
 */
export async function runSetup(
  flags: SetupFlags,
  deps: { ui: Ui; roots?: Roots; scheduler?: SchedulerApi; updater?: UpdateApi },
): Promise<void> {
  const ctx: Ctx = {
    ui: deps.ui,
    roots: deps.roots ?? getRoots(),
    scheduler: deps.scheduler ?? realScheduler,
    updater: deps.updater ?? realUpdater,
    openEditor: defaultEditor,
    now: Date.now,
    cwd: process.cwd(),
  };
  banner();
  // Local-only preferences go into the settings file once it exists (after
  // linking); before that they only apply to this process.
  const applyFlags = () => {
    if (!fs.existsSync(settingsPath(ctx.roots.config))) return;
    save(ctx, (s) => {
      if (flags.lang) s.language = flags.lang;
      if (flags.proxy !== undefined) s.proxy = flags.proxy;
      if (flags.interval) {
        s.autosync.intervalMinutes = Math.max(MIN_AUTOSYNC_INTERVAL, Math.floor(flags.interval));
      }
    });
  };
  const current = safe(() => settings(ctx), undefined);
  applyLocalSettings(
    current && flags.proxy !== undefined ? { ...current, proxy: flags.proxy } : current,
    flags.lang,
  );
  if (flags.proxy) setChildProxy(flags.proxy);

  if (flags.mode === "cli") {
    applyFlags();
    ok(t("setupCliOnly"));
    return;
  }
  if (!flags.repo) throw new SetupError(t("setupNeedRepo", { mode: flags.mode }));

  const reporter = createCliReporter();
  if (isRepoUrl(flags.repo)) linkByUrl({ url: flags.repo, reporter, roots: ctx.roots });
  else {
    try {
      linkSync({ repo: flags.repo, reporter, roots: ctx.roots });
    } catch (error) {
      if (!/was not found/.test((error as Error).message)) throw error;
      initSync({ repo: flags.repo, reporter, roots: ctx.roots });
    }
  }
  applyFlags();
  ok(t("linkDone", { repo: repoLabel(settings(ctx)) ?? flags.repo }));

  await resolveFirstSync(ctx, flags.prefer ?? "repo");
  if (flags.mode === "auto") {
    const enabled = await enableAutosync(ctx);
    if (!enabled) process.exitCode = 1;
  }
  appendLog(ctx.roots, `setup: mode=${flags.mode}`);
  ok(t("setupDone"));
}
