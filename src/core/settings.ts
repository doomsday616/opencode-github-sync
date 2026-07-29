import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "./jsonc.js";
import { getConfigRoot } from "./paths.js";

/** Filename of the tool's own settings (local-only, never committed). */
export const SETTINGS_FILE = "opencode-sync.jsonc";
/** Filename of the per-machine OpenCode config patch (local-only). */
export const OVERRIDES_FILE = "opencode-sync.overrides.jsonc";

export interface RepoSettings {
  /** Full git remote URL. Takes precedence over owner/name. */
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
}

export interface SessionSettings {
  /** Master switch. Session sync is opt-in. */
  enabled: boolean;
  /** Only sync sessions touched within this many days. */
  days: number;
  /** Hard cap on how many sessions a single push may export. */
  maxSessions: number;
  /**
   * Skip any single session whose exported payload exceeds this many bytes.
   * Tool output can make one session hundreds of megabytes; without a cap a
   * single runaway session would dominate the repository.
   */
  maxSessionBytes: number;
  /** Explicit session ids to always include, regardless of the time window. */
  include: string[];
  /** Session ids to never export. */
  exclude: string[];
  /** Only export sessions belonging to these project directories. */
  directories: string[];
}

export interface Settings {
  repo: RepoSettings;
  /** Stable alias for this machine used in commit messages. */
  machineAlias?: string;
  /** Sync `auth.json` / `account.json`. Requires a private repository. */
  includeCredentials: boolean;
  /** Sync `~/.agents/skills`. */
  includeSkills: boolean;
  /** Sync `~/.local/state/opencode`. */
  includeState: boolean;
  /** Extra absolute paths to sync, relative to the home directory. */
  extraPaths: string[];
  sessions: SessionSettings;
  /** Pull automatically when OpenCode starts (plugin only). */
  autoPullOnStartup: boolean;
  /** Push automatically when a session goes idle (plugin only). */
  autoPushOnIdle: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  repo: { branch: "main" },
  includeCredentials: false,
  includeSkills: true,
  includeState: true,
  extraPaths: [],
  sessions: {
    enabled: false,
    days: 7,
    maxSessions: 50,
    maxSessionBytes: 5 * 1024 * 1024,
    include: [],
    exclude: [],
    directories: [],
  },
  autoPullOnStartup: true,
  autoPushOnIdle: false,
};

export function settingsPath(configRoot = getConfigRoot()): string {
  return path.join(configRoot, SETTINGS_FILE);
}

export function overridesPath(configRoot = getConfigRoot()): string {
  return path.join(configRoot, OVERRIDES_FILE);
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    repo: { ...base.repo, ...(patch.repo ?? {}) },
    sessions: { ...base.sessions, ...(patch.sessions ?? {}) },
  };
}

export function loadSettings(configRoot = getConfigRoot()): Settings {
  const file = settingsPath(configRoot);
  if (!fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
  let parsed: Partial<Settings>;
  try {
    parsed = parseJsonc<Partial<Settings>>(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${SETTINGS_FILE}: ${(e as Error).message}`);
  }
  return mergeSettings(DEFAULT_SETTINGS, parsed ?? {});
}

export function saveSettings(settings: Settings, configRoot = getConfigRoot()): void {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(settingsPath(configRoot), `${JSON.stringify(settings, null, 2)}\n`);
}

export function repoUrl(settings: Settings): string | undefined {
  if (process.env.SYNC_REMOTE_URL) return process.env.SYNC_REMOTE_URL;
  if (settings.repo.url) return settings.repo.url;
  if (settings.repo.owner && settings.repo.name) {
    return `https://github.com/${settings.repo.owner}/${settings.repo.name}.git`;
  }
  return undefined;
}

export function repoBranch(settings: Settings): string {
  return settings.repo.branch || "main";
}

export const SETTINGS_TEMPLATE = `{
  // opencode-github-sync settings. This file is never committed.
  "repo": {
    "owner": "YOUR_GITHUB_USERNAME",
    "name": "my-opencode-config",
    "branch": "main"
  },

  // A short name for this machine, used in commit messages.
  // Leave unset to auto-generate a stable pseudonym from the hostname.
  // "machineAlias": "laptop",

  // Sync auth.json / account.json. Only enable for a PRIVATE repository.
  "includeCredentials": false,

  "includeSkills": true,
  "includeState": true,

  // Selective session sync. Off by default.
  "sessions": {
    "enabled": false,
    "days": 7,
    "maxSessions": 50,
    "maxSessionBytes": 5242880,
    "include": [],
    "exclude": [],
    "directories": []
  },

  "autoPullOnStartup": true,
  "autoPushOnIdle": false
}
`;

export const OVERRIDES_TEMPLATE = `{
  // Per-machine OpenCode configuration.
  //
  // This file is never committed. After every pull its contents are merged
  // back into opencode.json(c), so machine-specific settings survive syncing.
  //
  // Merge rules:
  //   - objects merge key by key
  //   - arrays and scalars replace whatever is in the shared config
  //   - null deletes the key
  //
  // Example:
  //   "model": "github-copilot/claude-sonnet-4",
  //   "mcp": { "playwright": { "enabled": true } }
}
`;
