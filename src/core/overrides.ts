import fs from "node:fs";
import path from "node:path";
import { deepMerge, parseJsonc } from "./jsonc.js";
import { OVERRIDES_FILE, overridesPath } from "./settings.js";

/**
 * Per-machine configuration overrides.
 *
 * A synced repository makes every machine identical, which is wrong for the
 * settings that are genuinely machine-specific: a corporate proxy, a local
 * toolchain path, an MCP server that only exists on one box. Overrides restore
 * that freedom by splitting the config into two layers.
 *
 *   repo `opencode.jsonc`            shared baseline, committed
 *   local `opencode-sync.overrides.jsonc`  this machine only, never committed
 *   ───────────────────────────────  deep merge
 *   effective `opencode.jsonc`       what OpenCode actually reads
 *
 * The interesting half is push. Because the effective file is what lives on
 * disk, a naive push would upload this machine's overrides to everyone. So on
 * push any key that the overrides file claims is restored to the value the
 * repository already had (or removed entirely if the repository never had it).
 * Overridden keys therefore become invisible to sync in both directions.
 *
 * When no overrides file exists the config is copied byte for byte, which keeps
 * comments and formatting untouched. The structural rewrite only happens for
 * users who actually opted into overrides.
 */

const CONFIG_FILENAMES = ["opencode.jsonc", "opencode.json"] as const;

/** Locate the OpenCode config file inside a directory, if there is one. */
export function findConfigFile(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function hasOverrides(configRoot: string): boolean {
  const file = overridesPath(configRoot);
  if (!fs.existsSync(file)) return false;
  const parsed = loadOverrides(configRoot);
  return Object.keys(parsed).length > 0;
}

export function loadOverrides(configRoot: string): Record<string, any> {
  const file = overridesPath(configRoot);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseJsonc<Record<string, any>>(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    throw new Error(`Cannot read ${OVERRIDES_FILE}: ${(e as Error).message}`);
  }
}

/**
 * Merge the local overrides into the config file after a pull.
 *
 * Returns true when the file was rewritten.
 */
export function applyOverrides(configRoot: string): boolean {
  const overrides = loadOverrides(configRoot);
  if (Object.keys(overrides).length === 0) return false;

  const configFile = findConfigFile(configRoot);
  if (!configFile) return false;

  const base = parseJsonc<Record<string, any>>(fs.readFileSync(configFile, "utf8"));
  const merged = deepMerge(base, overrides);
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  if (fs.readFileSync(configFile, "utf8") === next) return false;
  fs.writeFileSync(configFile, next);
  return true;
}

/**
 * Remove override-owned keys from an effective config so it can be pushed.
 *
 * `previous` is the version currently stored in the repository; the values it
 * holds for overridden keys are what gets restored. Keys the repository has
 * never seen are dropped.
 */
export function stripOverrides(
  effective: Record<string, any>,
  overrides: Record<string, any>,
  previous: Record<string, any> | undefined,
): Record<string, any> {
  const result: Record<string, any> = { ...effective };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const previousValue = previous?.[key];
    const isNestedMerge =
      isPlainObject(overrideValue) && isPlainObject(result[key]) && isPlainObject(previousValue);

    if (isNestedMerge) {
      result[key] = stripOverrides(result[key], overrideValue, previousValue);
      continue;
    }

    if (previous && Object.hasOwn(previous, key)) {
      result[key] = previousValue;
    } else {
      delete result[key];
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produce the text that should be committed for the config file.
 *
 * `previousText` is the version currently recorded in the repository. It has to
 * be read out of git rather than off disk, because the worktree *is* the config
 * directory — the file on disk is the effective config, overrides and all, so
 * using it as the baseline would quietly publish this machine's overrides.
 *
 * Returns `undefined` when the file can be committed as-is.
 */
export function configTextForRepo(
  configRoot: string,
  previousText: string | undefined,
): string | undefined {
  const overrides = loadOverrides(configRoot);
  if (Object.keys(overrides).length === 0) return undefined;

  const configFile = findConfigFile(configRoot);
  if (!configFile) return undefined;

  const effective = parseJsonc<Record<string, any>>(fs.readFileSync(configFile, "utf8"));
  const previous = previousText ? parseJsonc<Record<string, any>>(previousText) : undefined;

  return `${JSON.stringify(stripOverrides(effective, overrides, previous), null, 2)}\n`;
}
