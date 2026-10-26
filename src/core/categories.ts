import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncCategories } from "./settings.js";

/**
 * Optional parts of the config directory.
 *
 * The repository worktree is `~/.config/opencode` itself, so a category is a
 * set of paths at its root. Turning a category off makes those paths local to
 * this machine in both directions: they are never committed from here, and an
 * incoming version never replaces them.
 */

export type CategoryKey = keyof SyncCategories;

interface CategoryPaths {
  files?: string[];
  dirs?: string[];
  /** Match root-level files by extension. */
  rootExtensions?: string[];
}

export const CATEGORY_PATHS: Record<CategoryKey, CategoryPaths> = {
  config: { files: ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"] },
  instructions: { rootExtensions: [".md"] },
  agents: { dirs: ["agent", "agents"] },
  commands: { dirs: ["command", "commands"] },
  plugins: { dirs: ["plugin", "plugins"] },
};

export function disabledCategories(categories: SyncCategories | undefined): CategoryKey[] {
  if (!categories) return [];
  return (Object.keys(CATEGORY_PATHS) as CategoryKey[]).filter((key) => categories[key] === false);
}

/** True when a repository-relative path belongs to a disabled category. */
export function isDisabledPath(rel: string, disabled: CategoryKey[]): boolean {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const key of disabled) {
    const spec = CATEGORY_PATHS[key];
    if (spec.files?.includes(clean)) return true;
    if (spec.dirs?.some((d) => clean === d || clean.startsWith(`${d}/`))) return true;
    if (
      spec.rootExtensions &&
      !clean.includes("/") &&
      spec.rootExtensions.some((ext) => clean.toLowerCase().endsWith(ext))
    ) {
      return true;
    }
  }
  return false;
}

/** Git pathspecs (top-level, literal) covering the disabled categories. */
export function disabledPathspecs(disabled: CategoryKey[]): string[] {
  const specs: string[] = [];
  for (const key of disabled) {
    const spec = CATEGORY_PATHS[key];
    for (const f of spec.files ?? []) specs.push(`:(top,literal)${f}`);
    for (const d of spec.dirs ?? []) specs.push(`:(top,literal)${d}`);
    for (const ext of spec.rootExtensions ?? []) specs.push(`:(top,glob)*${ext}`);
  }
  return specs;
}

/** Every existing file under `root` that belongs to a disabled category. */
export function listDisabledFiles(root: string, disabled: CategoryKey[]): string[] {
  if (disabled.length === 0 || !fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    if (!isDisabledPath(entry.name, disabled)) continue;
    if (entry.isDirectory()) walk(entry.name);
    else out.push(entry.name);
  }
  return out;
}

/**
 * Copy the disabled categories aside, so they can be put back exactly as they
 * were after the worktree is reset to the remote.
 */
export interface CategorySnapshot {
  dir: string;
  files: string[];
}

export function snapshotDisabled(root: string, disabled: CategoryKey[]): CategorySnapshot | null {
  if (disabled.length === 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-keep-"));
  const files = listDisabledFiles(root, disabled);
  for (const rel of files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
  }
  return { dir, files };
}

/** Put the snapshot back: incoming files in those categories are removed. */
export function restoreDisabled(
  root: string,
  disabled: CategoryKey[],
  snapshot: CategorySnapshot | null,
): void {
  if (!snapshot) return;
  try {
    const keep = new Set(snapshot.files);
    for (const rel of listDisabledFiles(root, disabled)) {
      if (!keep.has(rel)) fs.rmSync(path.join(root, rel), { force: true });
    }
    for (const rel of snapshot.files) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(snapshot.dir, rel), target);
    }
  } finally {
    fs.rmSync(snapshot.dir, { recursive: true, force: true });
  }
}
