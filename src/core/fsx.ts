import fs from "node:fs";
import path from "node:path";

/**
 * Filesystem helpers used by staging.
 *
 * Two properties matter throughout this module:
 *
 * 1. **Symlinks are refused, never followed.** A sync repo that follows a
 *    symlink can be tricked into copying arbitrary files off the machine, and
 *    on Windows a directory junction silently turns a delete into a delete of
 *    something else entirely.
 * 2. **Replacements are atomic.** Destinations are built beside the target and
 *    renamed into place, so a crash mid-copy can never leave a half-written
 *    config that stops OpenCode from starting.
 */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

export function removeRecursive(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

export class SymlinkRefusedError extends Error {
  constructor(role: string, target: string) {
    super(`Refusing to sync ${role} symlink/junction: ${target}`);
    this.name = "SymlinkRefusedError";
  }
}

export function rejectLink(target: string, role: "source" | "target"): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new SymlinkRefusedError(role, target);
  } catch (err: any) {
    if (err instanceof SymlinkRefusedError) throw err;
    if (err?.code !== "ENOENT") throw err;
  }
}

/** Write only when the content actually differs. Returns true if written. */
export function writeIfDiffers(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

/** Create the file only when missing. Returns true if created. */
export function ensureFile(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

export function copyFileIfExists(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  rejectLink(src, "source");
  rejectLink(dst, "target");
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

/** Copy `src` onto `dst`, deleting `dst` when `src` does not exist. */
export function mirrorFile(src: string, dst: string): number {
  rejectLink(src, "source");
  rejectLink(dst, "target");
  if (!fs.existsSync(src)) {
    fs.rmSync(dst, { recursive: true, force: true });
    return 0;
  }
  return copyFileIfExists(src, dst) ? 1 : 0;
}

export interface CopyOptions {
  excludeFiles?: Set<string>;
  excludeDirs?: Set<string>;
}

export function copyDirRecursive(src: string, dst: string, options: CopyOptions = {}): number {
  const { excludeFiles = new Set<string>(), excludeDirs = new Set<string>() } = options;
  if (!fs.existsSync(src)) return 0;
  rejectLink(src, "source");
  rejectLink(dst, "target");
  ensureDir(dst);

  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    if (entry.isSymbolicLink()) throw new SymlinkRefusedError("source", srcPath);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      rejectLink(dstPath, "target");
      count += copyDirRecursive(srcPath, dstPath, options);
    } else {
      if (excludeFiles.has(entry.name)) continue;
      rejectLink(dstPath, "target");
      fs.copyFileSync(srcPath, dstPath);
      count++;
    }
  }
  return count;
}

export interface IncrementalOptions extends CopyOptions {
  /** Delete files in `dst` that no longer exist in `src`. Default true. */
  deleteExtraneous?: boolean;
}

export interface IncrementalResult {
  copied: number;
  deleted: number;
}

/**
 * Mirror `srcDir` into `dstDir`, copying only what changed.
 *
 * Change detection compares size and modification time at **one-second
 * granularity**, then falls back to a content compare. Whole seconds are
 * exactly representable on every filesystem we support; sub-second precision
 * drifts between NTFS and APFS and would make every run re-copy the entire
 * tree, which defeats the point.
 */
export function syncDirIncremental(
  srcDir: string,
  dstDir: string,
  options: IncrementalOptions = {},
): IncrementalResult {
  const {
    excludeFiles = new Set<string>(),
    excludeDirs = new Set<string>(),
    deleteExtraneous = true,
  } = options;

  rejectLink(srcDir, "source");
  rejectLink(dstDir, "target");

  if (!fs.existsSync(srcDir)) {
    // Source gone means the user deleted it; mirror that so the repo stays
    // an accurate reflection of the machine rather than growing forever.
    if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
    return { copied: 0, deleted: 0 };
  }

  ensureDir(dstDir);
  let copied = 0;
  let deleted = 0;

  const walkSource = (rel: string): void => {
    const srcAbs = rel ? path.join(srcDir, rel) : srcDir;
    const dstAbs = rel ? path.join(dstDir, rel) : dstDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(srcAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const srcPath = path.join(srcAbs, entry.name);
      if (entry.isSymbolicLink()) throw new SymlinkRefusedError("source", srcPath);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        const dstChild = path.join(dstDir, childRel);
        rejectLink(dstChild, "target");
        ensureDir(dstChild);
        walkSource(childRel);
        continue;
      }
      if (excludeFiles.has(entry.name)) continue;
      const dstFile = path.join(dstAbs, entry.name);
      rejectLink(dstFile, "target");
      const srcStat = fs.statSync(srcPath);
      const srcSeconds = Math.floor(srcStat.mtimeMs / 1000);
      let needCopy = true;
      try {
        const dstStat = fs.statSync(dstFile);
        if (dstStat.size === srcStat.size && Math.floor(dstStat.mtimeMs / 1000) === srcSeconds) {
          needCopy = !fs.readFileSync(srcPath).equals(fs.readFileSync(dstFile));
        }
      } catch {
        // Missing destination — copy.
      }
      if (needCopy) {
        fs.copyFileSync(srcPath, dstFile);
        try {
          const stamp = new Date(srcSeconds * 1000);
          fs.utimesSync(dstFile, stamp, stamp);
        } catch {
          // Best effort; a failed utimes only costs one redundant copy later.
        }
        copied++;
      }
    }
  };

  const walkDestination = (rel: string): void => {
    const srcAbs = rel ? path.join(srcDir, rel) : srcDir;
    const dstAbs = rel ? path.join(dstDir, rel) : dstDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dstAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const srcChild = path.join(srcAbs, entry.name);
      const dstChild = path.join(dstDir, childRel);
      if (entry.isSymbolicLink()) throw new SymlinkRefusedError("target", dstChild);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (!fs.existsSync(srcChild)) {
          fs.rmSync(dstChild, { recursive: true, force: true });
          deleted++;
        } else {
          walkDestination(childRel);
        }
        continue;
      }
      if (excludeFiles.has(entry.name)) continue;
      if (!fs.existsSync(srcChild)) {
        fs.unlinkSync(dstChild);
        deleted++;
      }
    }
  };

  walkSource("");
  if (deleteExtraneous) walkDestination("");
  return { copied, deleted };
}

export interface ReplaceFileOptions {
  /** When `src` is missing, keep the existing destination instead of deleting. */
  preserveMissing?: boolean;
}

/** Replace a single file atomically. */
export function replaceFileAtomically(
  src: string,
  dst: string,
  options: ReplaceFileOptions = {},
): number {
  rejectLink(src, "source");
  rejectLink(dst, "target");
  if (!fs.existsSync(src)) {
    if (!options.preserveMissing) fs.rmSync(dst, { recursive: true, force: true });
    return 0;
  }
  ensureDir(path.dirname(dst));
  const temp = `${dst}.sync-${process.pid}-${Date.now()}`;
  const backup = `${temp}.old`;
  try {
    fs.copyFileSync(src, temp);
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(dst)) fs.renameSync(dst, backup);
    fs.renameSync(temp, dst);
    fs.rmSync(backup, { recursive: true, force: true });
    return 1;
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    if (!fs.existsSync(dst) && fs.existsSync(backup)) fs.renameSync(backup, dst);
    throw err;
  }
}

export interface ReplaceDirOptions extends CopyOptions {
  /** Files at the destination root that survive the replacement. */
  preserveRootFiles?: Iterable<string>;
}

/** Replace a whole directory atomically. */
export function replaceDirAtomically(
  src: string,
  dst: string,
  options: ReplaceDirOptions = {},
): number {
  rejectLink(src, "source");
  rejectLink(dst, "target");
  if (!fs.existsSync(src)) {
    removeRecursive(dst);
    return 0;
  }
  const parent = path.dirname(dst);
  ensureDir(parent);
  const temp = path.join(parent, `.${path.basename(dst)}.sync-${process.pid}-${Date.now()}`);
  const backup = `${temp}.old`;
  removeRecursive(temp);
  try {
    const count = copyDirRecursive(src, temp, options);
    for (const file of options.preserveRootFiles ?? []) {
      copyFileIfExists(path.join(dst, file), path.join(temp, file));
    }
    if (fs.existsSync(dst)) fs.renameSync(dst, backup);
    fs.renameSync(temp, dst);
    removeRecursive(backup);
    return count;
  } catch (err) {
    removeRecursive(temp);
    if (!fs.existsSync(dst) && fs.existsSync(backup)) fs.renameSync(backup, dst);
    throw err;
  }
}

/**
 * Copy a path that may be either a file or a directory.
 *
 * OpenCode's `storage/migration` is a one-byte file while `storage/project` is
 * a directory, and which is which has changed between releases — so the type is
 * decided by looking at the source, not by assumption.
 */
export function copyPath(src: string, dst: string): number {
  rejectLink(src, "source");
  rejectLink(dst, "target");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    return 0;
  }
  return stat.isDirectory() ? replaceDirAtomically(src, dst) : replaceFileAtomically(src, dst);
}

/**
 * Strip nested `.git` directories from a staging copy.
 *
 * The `skills` CLI installs by cloning, which leaves a `.git` inside the skill
 * directory. Git records a nested repository as a gitlink instead of tracking
 * the files, so the skill's contents become invisible to every other machine.
 * Only staging copies are touched; the real source directories are never
 * modified.
 */
export function removeNestedGitDirs(...dirs: string[]): number {
  let removed = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.name === ".git") {
        fs.rmSync(child, { recursive: true, force: true });
        removed++;
        continue;
      }
      if (entry.isDirectory()) walk(child);
    }
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    // Walk the children rather than `dir` itself so the sync repo's own
    // top-level `.git` is never deleted.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      walk(path.join(dir, entry.name));
    }
  }
  return removed;
}
