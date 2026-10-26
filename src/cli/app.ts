import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AutosyncDeps,
  type AutosyncMessages,
  defaultDeps,
  readState,
} from "../core/autosync.js";
import { setChildProxy } from "../core/env.js";
import { git } from "../core/git.js";
import { notify } from "../core/notify.js";
import type { Roots } from "../core/paths.js";
import {
  type InstallContext,
  type InstallResult,
  type Platform,
  type ScheduleSpec,
  type SchedulerStatus,
  installScheduler,
  isElevated,
  realRunner,
  resolveNode,
  schedulerStatus,
  uninstallScheduler,
} from "../core/scheduler.js";
import { type Settings, loadSettings } from "../core/settings.js";
import { checkForUpdate, installLatest, uninstallGlobal } from "../core/update.js";
import { type Lang, detectLang, setLang, t } from "./i18n.js";

/** Directory of the compiled CLI module (`dist/cli`). */
export const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

export function homeDir(): string {
  return process.env.SYNC_HOME || os.homedir();
}

/** Apply the language and proxy from settings (and flags) to this process. */
export function applyLocalSettings(settings: Settings | undefined, langFlag?: string): Lang {
  const lang = detectLang(langFlag, settings?.language);
  setLang(lang);
  setChildProxy(process.env.OPENCODE_SYNC_PROXY || settings?.proxy || undefined);
  return lang;
}

export function safeLoadSettings(roots: Roots): Settings | undefined {
  try {
    return loadSettings(roots.config);
  } catch {
    return undefined;
  }
}

// ── Scheduler wiring ────────────────────────────────────────────────────────

/** Environment variables carried into the scheduled job when set at install time. */
const PASSTHROUGH_ENV = [
  "SYNC_CONFIG_ROOT",
  "SYNC_DATA_ROOT",
  "SYNC_STATE_ROOT",
  "SYNC_AGENTS_ROOT",
  "SYNC_CACHE_ROOT",
  "SYNC_HOME",
  "SYNC_REMOTE_URL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_SYNC_LANG",
  "OPENCODE_SYNC_HOST_ALIAS",
];

function gitDirectory(): string | undefined {
  const probe =
    process.platform === "win32"
      ? realRunner.run("where.exe", ["git"])
      : realRunner.run("/bin/sh", ["-c", "command -v git"]);
  const first = probe.stdout.split(/\r?\n/).find(Boolean)?.trim();
  return first ? path.dirname(first) : undefined;
}

export function scheduleSpec(roots: Roots, settings: Settings): ScheduleSpec {
  const node = resolveNode();
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (process.platform !== "win32") {
    // launchd, systemd and cron start with a bare PATH; git and node must be
    // reachable from it.
    const dirs = [
      path.dirname(node),
      gitDirectory(),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ];
    env.PATH = [...new Set(dirs.filter(Boolean) as string[])].join(":");
  }
  return {
    node,
    cli: path.join(CLI_DIR, "index.js"),
    intervalMinutes: settings.autosync.intervalMinutes,
    env,
    logDir: path.join(roots.config, "logs"),
  };
}

export interface SchedulerApi {
  install: (roots: Roots, settings: Settings) => InstallResult;
  uninstall: (roots: Roots) => { removed: boolean };
  status: () => SchedulerStatus;
  elevated: () => boolean;
}

function installContext(roots: Roots, settings: Settings): InstallContext {
  return {
    platform: process.platform as Platform,
    spec: scheduleSpec(roots, settings),
    home: os.homedir(),
    runner: realRunner,
    configRoot: roots.config,
    runWhenLoggedOff: settings.autosync.runWhenLoggedOff,
    elevated: isElevated(),
  };
}

export const realScheduler: SchedulerApi = {
  install: (roots, settings) => installScheduler(installContext(roots, settings)),
  uninstall: (roots) =>
    uninstallScheduler(
      installContext(roots, safeLoadSettings(roots) ?? loadSettings(roots.config)),
    ),
  status: () =>
    schedulerStatus({
      platform: process.platform as Platform,
      runner: realRunner,
      home: os.homedir(),
    }),
  elevated: () => isElevated(),
};

// ── Update wiring ───────────────────────────────────────────────────────────

export interface UpdateApi {
  check: () => ReturnType<typeof checkForUpdate>;
  install: () => void;
  uninstall: () => void;
}

export const realUpdater: UpdateApi = {
  check: () => checkForUpdate(path.resolve(CLI_DIR, "..", "core")),
  install: () => installLatest(),
  uninstall: () => uninstallGlobal(),
};

// ── Autosync wiring ─────────────────────────────────────────────────────────

export function localizedMessages(): AutosyncMessages {
  return {
    backoffTitle: t("ntBackoffTitle"),
    backoffBody: (failures, minutes) => t("ntBackoffBody", { n: failures, m: minutes }),
    recoveredTitle: t("ntRecoveredTitle"),
    recoveredBody: t("ntRecoveredBody"),
    largeTitle: t("ntLargeTitle"),
    largeBody: t("ntLargeBody"),
  };
}

export function autosyncDeps(roots: Roots, updater: UpdateApi = realUpdater): AutosyncDeps {
  return defaultDeps(roots, {
    home: homeDir(),
    notify: (title, body) => notify(title, body),
    messages: localizedMessages(),
    selfUpdate: () => {
      const check = updater.check();
      if (check.error) return `check failed: ${check.error}`;
      if (!check.newer) return `up to date (${check.current})`;
      updater.install();
      return `upgraded ${check.current} -> ${check.latest}`;
    },
  });
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** ISO date of the newest commit in the sync repository, if any. */
export function lastCommitTime(roots: Roots): number | undefined {
  if (!fs.existsSync(path.join(roots.config, ".git"))) return undefined;
  const log = git(["log", "-1", "--format=%cI"], { cwd: roots.config });
  const time = log.ok ? Date.parse(log.stdout) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** Best estimate of the next scheduled run, from the last run and the interval. */
export function nextRunEstimate(
  roots: Roots,
  settings: Settings,
  now = Date.now(),
): number | undefined {
  const state = readState(roots);
  if (!state.lastRunAt) return undefined;
  const next = state.lastRunAt + settings.autosync.intervalMinutes * 60000;
  return next > now ? next : undefined;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tomorrow at 08:00 local time. */
export function tomorrowMorning(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

export function isValidProxy(value: string): boolean {
  return /^(https?|socks5h?|socks4):\/\/[^\s]+$/i.test(value.trim());
}
