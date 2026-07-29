import os from "node:os";
import path from "node:path";

/**
 * Resolve every directory opencode-github-sync knows about.
 *
 * Each root can be overridden with an environment variable, which is what the
 * test-suite uses to run against a scratch directory instead of the real
 * machine.
 */
export interface Roots {
  /** `~/.config/opencode` — also the git worktree for the sync repo. */
  config: string;
  /** `~/.local/share/opencode` — auth, account, sqlite database. */
  data: string;
  /** `~/.local/state/opencode` — frecency, kv store, model cache. */
  state: string;
  /** `~/.agents/skills` — skills installed by the `skills` CLI. */
  agents: string;
  /** `~/.cache/opencode` — plugin package cache. */
  cache: string;
}

function xdg(envVar: string, ...fallback: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ...fallback);
}

export function getConfigRoot(): string {
  if (process.env.SYNC_CONFIG_ROOT) return process.env.SYNC_CONFIG_ROOT;
  return path.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode");
}

export function getDataRoot(): string {
  if (process.env.SYNC_DATA_ROOT) return process.env.SYNC_DATA_ROOT;
  return path.join(xdg("XDG_DATA_HOME", ".local", "share"), "opencode");
}

export function getStateRoot(): string {
  if (process.env.SYNC_STATE_ROOT) return process.env.SYNC_STATE_ROOT;
  return path.join(xdg("XDG_STATE_HOME", ".local", "state"), "opencode");
}

export function getAgentsRoot(): string {
  if (process.env.SYNC_AGENTS_ROOT) return process.env.SYNC_AGENTS_ROOT;
  return path.join(os.homedir(), ".agents", "skills");
}

export function getCacheRoot(): string {
  if (process.env.SYNC_CACHE_ROOT) return process.env.SYNC_CACHE_ROOT;
  return path.join(xdg("XDG_CACHE_HOME", ".cache"), "opencode");
}

export function getRoots(): Roots {
  return {
    config: getConfigRoot(),
    data: getDataRoot(),
    state: getStateRoot(),
    agents: getAgentsRoot(),
    cache: getCacheRoot(),
  };
}

/** Path of the OpenCode SQLite database that holds all sessions. */
export function getDatabasePath(roots: Roots = getRoots()): string {
  return path.join(roots.data, "opencode.db");
}

/** Directory inside the sync repo where session shards are written. */
export const SESSIONS_DIR = "_sessions";
/** Directory inside the sync repo mirroring the OpenCode data root. */
export const DATA_DIR = "_data";
/** Directory inside the sync repo mirroring the OpenCode state root. */
export const STATE_DIR = "_state";
/** Directory inside the sync repo mirroring `~/.agents/skills`. */
export const AGENTS_DIR = "_agents";
