import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyDirRecursive,
  copyPath,
  ensureDir,
  mirrorFile,
  removeNestedGitDirs,
  removeRecursive,
  replaceDirAtomically,
  replaceFileAtomically,
  syncDirIncremental,
  writeIfDiffers,
} from "./fsx.js";
import { git } from "./git.js";
import { parseJsonc } from "./jsonc.js";
import { configTextForRepo, findConfigFile } from "./overrides.js";
import { AGENTS_DIR, DATA_DIR, type Roots, STATE_DIR, getRoots } from "./paths.js";
import type { Reporter } from "./reporter.js";
import type { Settings } from "./settings.js";

/**
 * Move files between their real locations and the sync repository.
 *
 * The repository worktree *is* `~/.config/opencode`, so config files need no
 * copying at all. Everything that lives outside that directory is mirrored into
 * a prefixed folder:
 *
 *   ~/.local/share/opencode  ->  _data/
 *   ~/.local/state/opencode  ->  _state/
 *   ~/.agents/skills         ->  _agents/
 *
 * Staging in (push) is *local-consistent*: a file deleted on this machine is
 * deleted in the repository too. Staging out (pull) is conservative by default
 * and only becomes destructive with `force`, so an interrupted pull cannot wipe
 * a skill directory.
 */

/** Credential-bearing files, only staged when the user opts in. */
const CREDENTIAL_FILES = ["auth.json", "account.json"];
/** Non-credential data files that are always safe to sync. */
const DATA_FILES = ["sync-state.json"];
/**
 * Configuration metadata under the data root. `storage/project` is a directory
 * and `storage/migration` is a one-byte file — `copyPath` resolves which.
 */
const DATA_PATHS = ["storage/project", "storage/migration"];
/** State files that describe this machine's current UI, not its configuration. */
const MACHINE_STATE_FILES = new Set(["session.json"]);

const SKILL_LOCK = ".skill-lock.json";

export interface StageContext {
  repoRoot: string;
  roots: Roots;
  settings: Settings;
  reporter: Reporter;
  force: boolean;
}

export function createStageContext(
  repoRoot: string,
  settings: Settings,
  reporter: Reporter,
  force: boolean,
  roots: Roots = getRoots(),
): StageContext {
  return { repoRoot, roots, settings, reporter, force };
}

function dataFilesFor(settings: Settings): string[] {
  return settings.includeCredentials ? [...DATA_FILES, ...CREDENTIAL_FILES] : DATA_FILES;
}

/** Copy everything from the machine into the repository worktree. */
export function stageIn(ctx: StageContext): void {
  const { repoRoot, roots, settings } = ctx;
  const repoData = path.join(repoRoot, DATA_DIR);
  const repoState = path.join(repoRoot, STATE_DIR);
  const repoAgents = path.join(repoRoot, AGENTS_DIR);

  ensureDir(repoData);
  for (const file of dataFilesFor(settings)) {
    mirrorFile(path.join(roots.data, file), path.join(repoData, file));
  }
  // A credential file that was previously synced must disappear from the repo
  // the moment the user turns the option off.
  if (!settings.includeCredentials) {
    for (const file of CREDENTIAL_FILES) removeRecursive(path.join(repoData, file));
  }

  for (const rel of DATA_PATHS) {
    copyPath(path.join(roots.data, rel), path.join(repoData, rel));
  }

  if (settings.includeState) {
    if (fs.existsSync(roots.state)) {
      removeRecursive(repoState);
      copyDirRecursive(roots.state, repoState, { excludeFiles: MACHINE_STATE_FILES });
    } else {
      removeRecursive(repoState);
    }
  }

  if (settings.includeSkills) {
    syncDirIncremental(roots.agents, repoAgents, {
      excludeFiles: new Set([".git"]),
      excludeDirs: new Set([".git"]),
    });
    // Nested repositories would be committed as unusable gitlinks. Only the
    // staging copy is cleaned; the real skills directory is never touched.
    removeRecursive(path.join(repoAgents, ".git"));
    removeNestedGitDirs(repoAgents);
    stageSkillLockIn(ctx, repoAgents);
  }

  stageExtraPathsIn(ctx);
  stageConfigIn(ctx);
}

/**
 * The skills lock file records which skills are installed and which update
 * prompts were dismissed. Merging instead of overwriting means installing a
 * skill on one machine never un-installs one from another.
 */
function stageSkillLockIn(ctx: StageContext, repoAgents: string): void {
  const localLock = path.join(path.dirname(ctx.roots.agents), SKILL_LOCK);
  const repoLock = path.join(repoAgents, SKILL_LOCK);

  if (ctx.force || !fs.existsSync(localLock) || !fs.existsSync(repoLock)) {
    mirrorFile(localLock, repoLock);
    return;
  }
  const merged = mergeSkillLocks(readJson(repoLock), readJson(localLock));
  if (merged) writeIfDiffers(repoLock, `${JSON.stringify(merged, null, 2)}\n`);
  else mirrorFile(localLock, repoLock);
}

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function mergeSkillLocks(
  remote: Record<string, any> | undefined,
  local: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!remote || !local) return undefined;
  return {
    ...remote,
    ...local,
    skills: { ...(remote.skills ?? {}), ...(local.skills ?? {}) },
    dismissed: { ...(remote.dismissed ?? {}), ...(local.dismissed ?? {}) },
  };
}

/**
 * Rewrite the repository's config file with override-owned keys removed.
 *
 * The baseline comes from `git show HEAD:<file>`, not from disk: the worktree
 * and the config directory are the same place, so the file on disk already has
 * this machine's overrides applied to it.
 *
 * Without overrides nothing happens at all, which keeps comments and formatting
 * byte-identical for the majority of users.
 *
 * Returns true when the file on disk was changed.
 */
export function normalizeConfigForRepo(ctx: StageContext): boolean {
  const configFile = findConfigFile(ctx.roots.config);
  if (!configFile) return false;

  const relative = path.relative(ctx.repoRoot, configFile).split(path.sep).join("/");
  const head = git(["show", `HEAD:${relative}`], { cwd: ctx.repoRoot });
  const text = configTextForRepo(ctx.roots.config, head.ok ? head.stdout : undefined);
  if (!text) return false;

  return writeIfDiffers(configFile, text);
}

function stageConfigIn(ctx: StageContext): void {
  if (normalizeConfigForRepo(ctx)) {
    ctx.reporter.detail("Removed per-machine overrides from the committed config");
  }
}

function extraPathEntries(ctx: StageContext): { source: string; repo: string }[] {
  return ctx.settings.extraPaths.map((entry) => {
    const source = path.isAbsolute(entry) ? entry : path.join(homeDir(), entry);
    const repo = path.join(ctx.repoRoot, "_extra", sanitizeRelative(entry));
    return { source, repo };
  });
}

function homeDir(): string {
  return process.env.SYNC_HOME || os.homedir();
}

function sanitizeRelative(entry: string): string {
  return entry
    .replace(/^[A-Za-z]:/, "")
    .replace(/[\\/]+/g, "_")
    .replace(/^[._]+/, "");
}

function stageExtraPathsIn(ctx: StageContext): void {
  for (const { source, repo } of extraPathEntries(ctx)) {
    if (!fs.existsSync(source)) {
      removeRecursive(repo);
      continue;
    }
    if (fs.statSync(source).isDirectory()) syncDirIncremental(source, repo);
    else mirrorFile(source, repo);
  }
}

/** Copy everything from the repository worktree back onto the machine. */
export function stageOut(ctx: StageContext): void {
  const { repoRoot, roots, settings, force } = ctx;
  const repoData = path.join(repoRoot, DATA_DIR);
  const repoState = path.join(repoRoot, STATE_DIR);
  const repoAgents = path.join(repoRoot, AGENTS_DIR);

  ensureDir(roots.data);
  for (const file of dataFilesFor(settings)) {
    // `preserveMissing` matters for credentials: a machine that syncs without
    // them must keep its own auth.json rather than have it deleted.
    replaceFileAtomically(path.join(repoData, file), path.join(roots.data, file), {
      preserveMissing: true,
    });
  }

  for (const rel of DATA_PATHS) {
    const source = path.join(repoData, rel);
    if (fs.existsSync(source)) copyPath(source, path.join(roots.data, rel));
  }

  if (settings.includeState && fs.existsSync(repoState)) {
    replaceDirAtomically(repoState, roots.state, { preserveRootFiles: MACHINE_STATE_FILES });
  }

  if (settings.includeSkills && fs.existsSync(repoAgents)) {
    if (force) {
      replaceDirAtomically(repoAgents, roots.agents, {
        excludeFiles: new Set([SKILL_LOCK]),
      });
    } else {
      syncDirIncremental(repoAgents, roots.agents, {
        excludeFiles: new Set([SKILL_LOCK]),
        deleteExtraneous: false,
      });
    }
    stageSkillLockOut(ctx, repoAgents);
  }

  stageExtraPathsOut(ctx);
}

function stageSkillLockOut(ctx: StageContext, repoAgents: string): void {
  const repoLock = path.join(repoAgents, SKILL_LOCK);
  const localLock = path.join(path.dirname(ctx.roots.agents), SKILL_LOCK);
  if (ctx.force || !fs.existsSync(repoLock) || !fs.existsSync(localLock)) {
    replaceFileAtomically(repoLock, localLock, { preserveMissing: true });
    return;
  }
  const merged = mergeSkillLocks(readJson(localLock), readJson(repoLock));
  if (merged) writeIfDiffers(localLock, `${JSON.stringify(merged, null, 2)}\n`);
  else replaceFileAtomically(repoLock, localLock);
}

function stageExtraPathsOut(ctx: StageContext): void {
  for (const { source, repo } of extraPathEntries(ctx)) {
    if (!fs.existsSync(repo)) continue;
    if (fs.statSync(repo).isDirectory()) replaceDirAtomically(repo, source);
    else replaceFileAtomically(repo, source);
  }
}

/**
 * Drop cached plugin packages that the config no longer references.
 *
 * Only `package.json` and the stale module directories are touched; OpenCode
 * reinstalls whatever it still needs on the next start. Returns how many
 * packages were removed.
 */
export function prunePluginCache(configRoot: string, cacheRoot: string): number {
  const cachePackage = path.join(cacheRoot, "package.json");
  const configFile = findConfigFile(configRoot);
  if (!fs.existsSync(cachePackage) || !configFile) return 0;

  let config: any;
  try {
    config = parseJsonc(fs.readFileSync(configFile, "utf8"));
  } catch {
    return 0;
  }

  const enabled = new Set<string>((config?.plugin ?? []).map(pluginSpecToName));
  const pkg = readJson(cachePackage);
  if (!pkg) return 0;

  const dependencies: Record<string, string> = pkg.dependencies ?? {};
  const stale = Object.keys(dependencies).filter((name) => !enabled.has(name));
  if (stale.length === 0) return 0;

  for (const name of stale) delete dependencies[name];
  pkg.dependencies = dependencies;
  fs.writeFileSync(cachePackage, `${JSON.stringify(pkg, null, 2)}\n`);

  for (const name of stale) {
    removeRecursive(path.join(cacheRoot, "node_modules", ...name.split("/")));
  }
  removeRecursive(path.join(cacheRoot, "package-lock.json"));
  removeRecursive(path.join(cacheRoot, "bun.lock"));

  return stale.length;
}

/**
 * Reduce a plugin specifier to its package name.
 *
 * `opencode-foo@1.2.3` -> `opencode-foo`
 * `@scope/opencode-foo@1.2.3` -> `@scope/opencode-foo`
 */
export function pluginSpecToName(spec: string): string {
  if (spec.startsWith("@")) {
    const rest = spec.slice(1);
    const slash = rest.indexOf("/");
    if (slash === -1) return spec;
    const after = rest.slice(slash + 1);
    const at = after.indexOf("@");
    if (at === -1) return spec;
    return `@${rest.slice(0, slash + 1)}${after.slice(0, at)}`;
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}
