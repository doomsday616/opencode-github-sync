#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  appendLog,
  backoffRemainingMs,
  failureCount,
  readState,
  runAutosync,
  writeState,
} from "../core/autosync.js";
import { LargeChangeError } from "../core/guard.js";
import { withSyncLock } from "../core/lock.js";
import { getDatabasePath, getRoots } from "../core/paths.js";
import { listSessions } from "../core/sessions.js";
import {
  OVERRIDES_TEMPLATE,
  loadSettings,
  overridesPath,
  saveSettings,
  settingsPath,
} from "../core/settings.js";
import {
  SetupError,
  discoverSyncRepos,
  initSync,
  isRepoUrl,
  linkByUrl,
  linkSync,
} from "../core/setup.js";
import { sqliteAvailable } from "../core/sqlite.js";
import { SyncError, formatBytes, pull, push, status } from "../core/sync.js";
import {
  applyLocalSettings,
  autosyncDeps,
  formatTime,
  realScheduler,
  safeLoadSettings,
  tomorrowMorning,
} from "./app.js";
import { type Args, parseArgs } from "./args.js";
import { ago, t } from "./i18n.js";
import { type SetupFlags, disableAutosync, enableAutosync, runMenu, runSetup } from "./menu.js";
import {
  Spinner,
  banner,
  createCliReporter,
  detail,
  fail,
  heading,
  info,
  keyValue,
  ok,
  outcome,
  rule,
  warn,
  write,
} from "./render.js";
import { glyph, paint, style } from "./theme.js";
import { Ui } from "./ui.js";

const LOCK_WAIT_MS = 5 * 60 * 1000;

function newUi(): Ui {
  return new Ui({
    input: process.stdin,
    output: process.stdout,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

async function confirmForce(action: string, lines: string[], args: Args): Promise<boolean> {
  if (args.flags.has("yes") || args.flags.has("y")) return true;
  if (!process.stdin.isTTY) {
    fail(t("cliNeedTty"));
    return false;
  }
  write();
  write(
    `  ${paint(" FORCE ", style.bold, style.red)}  ${paint(t("cliForceTitle", { action }), style.bold, style.text)}`,
  );
  for (const line of lines) write(`  ${paint(`${glyph.bullet} ${line}`, style.muted)}`);
  write();
  const ui = newUi();
  const answer = await ui.text(t("cliTypeYes"));
  ui.close();
  return answer?.trim().toLowerCase() === "yes";
}

// ── Commands ────────────────────────────────────────────────────────────────

async function runSync(action: "push" | "pull", args: Args): Promise<void> {
  const force = args.flags.has("force") || args.flags.has("f");
  const dryRun = args.flags.has("dry-run") || args.flags.has("n");
  const allowLarge = args.flags.has("allow-large");
  const roots = getRoots();

  banner(action === "push" ? t("cliPushTitle") : t("cliPullTitle"), force ? "FORCE" : undefined);

  if (force && !dryRun) {
    const consequences = action === "push" ? [t("cliForcePushWarn")] : [t("cliForcePullWarn")];
    if (!(await confirmForce(action, consequences, args))) {
      info(t("cancelled"));
      return;
    }
  }

  const spinner = new Spinner(action === "push" ? t("cliPreparingPush") : t("cliPreparingPull"));
  spinner.start();
  const reporter = createCliReporter(spinner);

  try {
    const result = await withSyncLock(roots.config, { waitMs: LOCK_WAIT_MS }, () =>
      action === "push"
        ? push({ force, dryRun, reporter, roots, allowLarge })
        : pull({ force, dryRun, reporter, roots }),
    );
    spinner.stop();

    if (result.sessions) {
      const bits: string[] = [];
      if (result.sessions.exported !== undefined)
        bits.push(t("cliExported", { n: result.sessions.exported }));
      if (result.sessions.imported !== undefined)
        bits.push(t("cliImported", { n: result.sessions.imported }));
      if (result.sessions.skipped) bits.push(t("cliSkipped", { n: result.sessions.skipped }));
      if (bits.length > 0) detail(t("cliSessionsLine", { text: bits.join(", ") }));
    }
    if (result.guard) {
      warn(t("largeTitle"));
      detail(`${result.guard.addedFiles} / ${formatBytes(result.guard.totalBytes)}`);
    }

    outcome(dryRun ? t("cliDryRun", { message: result.message }) : result.message, result.changed);
    if (result.restartRequired && result.changed) {
      info(t("restartHint"));
      write();
    }
  } catch (error) {
    if (error instanceof LargeChangeError) {
      spinner.stop();
      fail(`${t("largeRefused")}\n${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    spinner.stop();
  }
}

function runStatus(): void {
  banner(t("stTitle"));
  const roots = getRoots();
  const state = status({ roots });

  if (!state.configured) {
    fail(t("cliNoRepo"));
    write();
    info(t("cliRunInit"));
    const found = discoverSyncRepos();
    if (found.length > 0) {
      write();
      detail(t("cliFoundRepos", { list: found.slice(0, 5).join(", ") }));
      detail(t("cliLinkHint"));
    }
    write();
    return;
  }

  keyValue(t("stRepository"), paint(state.remote ?? "-", style.text));
  keyValue(t("stBranch"), paint(state.branch, style.text));
  keyValue(t("stMachine"), paint(state.machineAlias, style.text));

  if (!state.initialized) {
    write();
    warn(t("cliNotInitialised"));
    write();
    return;
  }

  const sync =
    state.ahead === 0 && state.behind === 0
      ? paint(t("stInSync"), style.green)
      : [
          state.ahead > 0 ? paint(t("stToPush", { n: state.ahead }), style.yellow) : "",
          state.behind > 0 ? paint(t("stToPull", { n: state.behind }), style.cyan) : "",
        ]
          .filter(Boolean)
          .join(paint("  ", style.faint));
  keyValue(t("stState"), sync);
  keyValue(
    t("stUncommitted"),
    state.dirty === 0
      ? paint(t("stClean"), style.green)
      : paint(t("stFiles", { n: state.dirty }), style.yellow),
  );
  keyValue(
    t("stOverrides"),
    state.overridesActive ? paint(t("stActive"), style.accent) : paint(t("none"), style.muted),
  );
  keyValue(
    t("stSessions"),
    state.sessionsEnabled
      ? paint(t("stSessionsOn", { n: state.sessionShards }), style.text)
      : paint(t("stDisabled"), style.muted),
  );

  if (state.lastCommit) {
    heading(t("stLastCommit"));
    detail(state.lastCommit);
    if (state.lastCommitDate) detail(state.lastCommitDate);
  }
  write();
}

function runInit(args: Args, mode: "init" | "link"): void {
  banner(mode === "init" ? t("initTitle") : t("linkTitleCli"));
  const reporter = createCliReporter();
  const options = {
    repo: args.positional[0],
    reporter,
    includeCredentials: args.flags.has("credentials"),
    includeSessions: args.flags.has("sessions"),
  };

  const result =
    mode === "link" && isRepoUrl(options.repo)
      ? linkByUrl({ ...options, url: options.repo! })
      : mode === "init"
        ? initSync(options)
        : linkSync(options);
  const label = result.target.owner
    ? `${result.target.owner}/${result.target.name}`
    : result.target.name;

  ok(
    result.created
      ? t("initCreated", { repo: paint(label, style.bold, style.text) })
      : t("initLinked", { repo: paint(label, style.bold, style.text) }),
  );
  detail(t("initSettings", { file: result.settingsFile }));
  detail(t("initOverrides", { file: result.overridesFile }));

  heading(t("initNext"));
  write(
    `  ${paint("1.", style.faint)} ${mode === "init" ? "opencode-sync push" : "opencode-sync pull"}`,
  );
  write(`  ${paint("2.", style.faint)} ${t("initRestart")}`);
  write();
}

async function runSessions(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "list";
  const roots = getRoots();
  const settings = loadSettings(roots.config);

  if (sub === "list") {
    banner(t("sesTitle"));
    if (!(await sqliteAvailable())) {
      fail(t("sesNoSqlite"));
      write();
      return;
    }
    const limit = Number(args.values.get("limit") ?? 20);
    const sessions = await listSessions(getDatabasePath(roots), limit);
    if (sessions.length === 0) {
      info(t("sesNone"));
      write();
      return;
    }
    for (const session of sessions) {
      const when = new Date(session.timeUpdated).toISOString().slice(0, 16).replace("T", " ");
      const title = session.title || paint(t("sesUntitled"), style.faint);
      write(`  ${paint(when, style.faint)}  ${title}`);
      write(`  ${paint(" ".repeat(16), style.faint)}  ${paint(session.id, style.faint)}`);
    }
    write();
    detail(t("sesPinHint"));
    write();
    return;
  }

  if (sub === "include" || sub === "exclude") {
    const id = args.positional[1];
    if (!id) throw new SyncError(t("sesUsage", { sub }));
    const list = sub === "include" ? settings.sessions.include : settings.sessions.exclude;
    if (!list.includes(id)) list.push(id);
    saveSettings(settings, roots.config);
    banner(t("sesTitle"));
    ok(
      sub === "include"
        ? t("sesPinned", { id: paint(id, style.text) })
        : t("sesExcluded", { id: paint(id, style.text) }),
    );
    write();
    return;
  }

  if (sub === "enable" || sub === "disable") {
    settings.sessions.enabled = sub === "enable";
    saveSettings(settings, roots.config);
    banner(t("sesTitle"));
    ok(sub === "enable" ? t("sesEnabled") : t("sesDisabled"));
    if (sub === "enable") {
      detail(t("sesWindow", { days: settings.sessions.days, max: settings.sessions.maxSessions }));
      detail(t("sesCap", { size: formatBytes(settings.sessions.maxSessionBytes) }));
      warn(t("sessionsWarn"));
    }
    write();
    return;
  }

  throw new SyncError(t("sesUnknown", { sub }));
}

function runOverrides(): void {
  banner(t("ovCliTitle"));
  const roots = getRoots();
  const file = overridesPath(roots.config);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, OVERRIDES_TEMPLATE);
    ok(t("ovCreated"));
  }
  detail(file);
  write();
  info(t("ovCliInfo"));
  write();
}

function runConfig(): void {
  banner(t("cfgTitle"));
  const roots = getRoots();
  const file = settingsPath(roots.config);
  if (!fs.existsSync(file)) {
    fail(t("cfgMissing"));
    write();
    return;
  }
  detail(file);
  write();
  write(fs.readFileSync(file, "utf8").trimEnd());
  write();
}

async function runAutosyncCommand(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "status";
  const roots = getRoots();
  const ctx = { roots, scheduler: realScheduler };

  switch (sub) {
    case "run": {
      // Called by the scheduler: no banner, no colour noise, one log line.
      const trigger = args.values.get("trigger") ?? "scheduled";
      const outcomeResult = await runAutosync(autosyncDeps(roots), trigger);
      write(
        outcomeResult.action === "skip"
          ? t("asRunSkipped", { reason: outcomeResult.reason })
          : t("asRunDone", {
              action: outcomeResult.action,
              message: outcomeResult.message ?? outcomeResult.reason,
            }),
      );
      if (!outcomeResult.ok) process.exitCode = 1;
      return;
    }
    case "install": {
      banner(t("asTitle"));
      const settings = loadSettings(roots.config);
      const result = realScheduler.install(roots, settings);
      if (!result.ok) {
        fail(t("autoInstallFailed", { error: result.detail.join("; ") }));
        process.exitCode = 1;
        return;
      }
      ok(t("asInstalled", { kind: result.kind }));
      for (const d of result.detail) detail(d);
      for (const w of result.warnings) warn(t("autoWarning", { text: w }));
      if (!settings.autosync.enabled) warn(`${t("autoOff")} opencode-sync autosync enable`);
      write();
      return;
    }
    case "uninstall": {
      banner(t("asTitle"));
      const result = realScheduler.uninstall(roots);
      ok(result.removed ? t("asUninstalled") : t("asNotInstalled"));
      write();
      return;
    }
    case "enable": {
      banner(t("asTitle"));
      const interval = Number(args.values.get("interval"));
      if (Number.isFinite(interval) && interval >= 2) {
        const s = loadSettings(roots.config);
        s.autosync.intervalMinutes = Math.floor(interval);
        saveSettings(s, roots.config);
      }
      if (!(await enableAutosync(ctx))) process.exitCode = 1;
      write();
      return;
    }
    case "disable":
      banner(t("asTitle"));
      disableAutosync(ctx);
      write();
      return;
    case "reset": {
      banner(t("asTitle"));
      const before = failureCount(readState(roots));
      writeState(roots, {
        consecutiveFailures: 0,
        lastError: null,
        failureNotifiedAt: null,
        lastAttemptAt: 0,
      });
      appendLog(roots, `reset: cleared ${before} failure(s)`);
      ok(t("resetDone", { n: before }));
      write();
      return;
    }
    case "pause":
    case "resume": {
      banner(t("asTitle"));
      const s = loadSettings(roots.config);
      if (sub === "resume") {
        s.autosync.pausedUntil = 0;
        saveSettings(s, roots.config);
        ok(t("resumed"));
      } else {
        const arg = args.positional[1] ?? "1";
        const until = arg === "tomorrow" ? tomorrowMorning() : Date.now() + Number(arg) * 3600_000;
        if (!Number.isFinite(until) || until <= Date.now()) throw new SyncError(t("asPauseUsage"));
        s.autosync.pausedUntil = until;
        saveSettings(s, roots.config);
        ok(t("pausedUntil", { time: formatTime(until) }));
      }
      write();
      return;
    }
    case "status": {
      banner(t("asTitle"));
      const s = loadSettings(roots.config);
      const state = readState(roots);
      const sched = realScheduler.status();
      keyValue(
        t("asEnabled"),
        s.autosync.enabled ? paint(t("on"), style.green) : paint(t("off"), style.muted),
        20,
      );
      keyValue(t("asInterval"), t("intervalMinutes", { n: s.autosync.intervalMinutes }), 20);
      keyValue(
        t("asScheduler"),
        sched.installed
          ? `${t("diagRegistered", { kind: sched.kind })}${sched.nextRun ? ` · ${sched.nextRun}` : ""}`
          : t("diagNotRegistered"),
        20,
      );
      if (s.autosync.pausedUntil > Date.now())
        keyValue(t("asPaused"), formatTime(s.autosync.pausedUntil), 20);
      keyValue(t("asLastRun"), ago(state.lastRunAt), 20);
      keyValue(t("asLastSuccess"), ago(state.lastSuccessAt), 20);
      if (state.lastOutcome) keyValue(t("asOutcome"), state.lastOutcome, 20);
      const failures = failureCount(state);
      if (failures) keyValue(t("asFailures"), String(failures), 20);
      const wait = backoffRemainingMs(state, Date.now());
      if (wait > 0)
        keyValue(t("asNextAttempt"), t("inMinutes", { n: Math.ceil(wait / 60000) }), 20);
      if (state.lastError) keyValue(t("asLastError"), paint(state.lastError, style.red), 20);
      write();
      return;
    }
    default:
      throw new SyncError(t("asUsage"));
  }
}

function setupFlags(args: Args): SetupFlags {
  const mode = (args.values.get("mode") ?? "cli") as SetupFlags["mode"];
  if (!["cli", "link", "auto"].includes(mode))
    throw new SetupError(t("invalidValue", { value: mode }));
  const interval = args.values.get("interval");
  const prefer = args.values.get("prefer");
  return {
    mode,
    repo: args.values.get("repo") ?? args.positional[0],
    interval: interval ? Number(interval) : undefined,
    lang: args.values.get("lang"),
    proxy: args.values.get("proxy"),
    prefer: prefer === "local" ? "local" : prefer === "repo" ? "repo" : undefined,
  };
}

function runHelp(): void {
  banner(t("helpTitle"));

  heading(t("helpSetup"));
  command("(no arguments) | menu", t("helpMenu"));
  command("init [name|owner/repo]", t("helpInit"));
  command("link <owner/repo|url>", t("helpLink"));
  command("setup --mode cli|link|auto", t("helpSetupCmd"));

  heading(t("helpSync"));
  command("push", t("helpPush"));
  command("pull", t("helpPull"));
  command("status", t("helpStatus"));

  heading(t("helpAutosync"));
  command("autosync install | uninstall", t("helpAsInstall"));
  command("autosync enable | disable", t("helpAsToggle"));
  command("autosync status", t("helpAsStatus"));
  command("autosync run", t("helpAsRun"));
  command("autosync pause <h> | resume", t("helpAsPause"));
  command("autosync reset", t("helpAsReset"));

  heading(t("helpSessions"));
  command("sessions list", t("helpSesList"));
  command("sessions enable | disable", t("helpSesToggle"));
  command("sessions include <id>", t("helpSesInclude"));
  command("sessions exclude <id>", t("helpSesExclude"));

  heading(t("helpLocal"));
  command("overrides", t("helpOverrides"));
  command("config", t("helpConfig"));

  heading(t("helpFlags"));
  command("--force", t("helpForce"));
  command("--dry-run", t("helpDryRun"));
  command("--allow-large", t("helpAllowLarge"));
  command("--yes", t("helpYes"));
  command("--prefer repo|local", t("helpPrefer"));
  command("--lang en|zh-CN", t("helpLang"));

  write();
  rule();
  write(
    `  ${paint("docs", style.faint)}  ${paint("https://github.com/doomsday616/opencode-github-sync", style.muted)}`,
  );
  write();
}

function command(name: string, description: string): void {
  const padded = name.padEnd(32);
  write(`  ${paint(padded, style.cyan)}${paint(description, style.muted)}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const roots = getRoots();
  applyLocalSettings(safeLoadSettings(roots), args.values.get("lang"));

  switch (args.command) {
    case "menu": {
      const ui = newUi();
      try {
        await runMenu({ ui, roots });
      } finally {
        ui.close();
      }
      return;
    }
    case "setup": {
      const ui = newUi();
      try {
        await runSetup(setupFlags(args), { ui, roots });
      } finally {
        ui.close();
      }
      return;
    }
    case "push":
    case "pull":
      await runSync(args.command, args);
      return;
    case "status":
      runStatus();
      return;
    case "init":
      runInit(args, "init");
      return;
    case "link":
      runInit(args, "link");
      return;
    case "sessions":
      await runSessions(args);
      return;
    case "autosync":
      await runAutosyncCommand(args);
      return;
    case "overrides":
      runOverrides();
      return;
    case "config":
      runConfig();
      return;
    case "help":
    case "--help":
    case "-h":
      runHelp();
      return;
    default:
      banner();
      fail(t("cliUnknown", { cmd: args.command }));
      write();
      info(t("cliHelpHint"));
      write();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const err = error as Error;
  write();
  if (err instanceof SyncError || err instanceof SetupError || err.name === "GitAuthError") {
    fail(err.message);
  } else {
    fail(err.message || String(error));
    if (process.env.OPENCODE_SYNC_VERBOSE === "1" && err.stack) {
      write();
      detail(err.stack);
    }
  }
  write();
  process.exit(1);
});
