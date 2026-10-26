import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import type { Roots } from "./paths.js";
import { saveToRecovery } from "./recovery.js";
import { DEVICE_TRAILER } from "./sync.js";

/**
 * Read-only views of the sync repository's history: which machines sync, when
 * each last did, and earlier versions of a file.
 */

export interface DeviceInfo {
  alias: string;
  lastSync: string;
  commits: number;
}

const SUBJECT_ALIAS = / from ([A-Za-z0-9._-]+)\s*$/;

/**
 * Machines seen in the history, newest first.
 *
 * The alias is taken from the commit trailer written since 3.2.0, falling back
 * to the `... from <alias>` subject that every earlier release used.
 */
export function listDevices(root: string, limit = 2000): DeviceInfo[] {
  const sep = "\x1f";
  const end = "\x1e";
  const log = git(
    [
      "log",
      `-n${limit}`,
      `--format=%cI${sep}%s${sep}%(trailers:key=${DEVICE_TRAILER},valueonly,separator=%x2C)${end}`,
    ],
    { cwd: root },
  );
  if (!log.ok) return [];
  const seen = new Map<string, DeviceInfo>();
  for (const record of log.stdout.split(end)) {
    const [date, subject, trailer] = record.trim().split(sep);
    if (!date) continue;
    const alias = (trailer ?? "").trim() || SUBJECT_ALIAS.exec(subject ?? "")?.[1];
    if (!alias) continue;
    const existing = seen.get(alias);
    if (existing) existing.commits++;
    else seen.set(alias, { alias, lastSync: date, commits: 1 });
  }
  return [...seen.values()];
}

export interface FileVersion {
  commit: string;
  date: string;
  subject: string;
}

/** Commits that touched a repository-relative file, newest first. */
export function fileHistory(root: string, rel: string, limit = 30): FileVersion[] {
  const sep = "\x1f";
  const log = git(["log", `-n${limit}`, `--format=%H${sep}%cI${sep}%s`, "--", rel], {
    cwd: root,
  });
  if (!log.ok) return [];
  return log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit = "", date = "", subject = ""] = line.split(sep);
      return { commit, date, subject };
    });
}

/** Tracked files, optionally filtered by a case-insensitive substring. */
export function trackedFiles(root: string, filter = ""): string[] {
  const result = git(["ls-files"], { cwd: root });
  if (!result.ok) return [];
  const needle = filter.toLowerCase();
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((f) => !needle || f.toLowerCase().includes(needle));
}

/**
 * Put the content a file had at `commit` back into the worktree.
 *
 * The current bytes are copied to the recovery folder first, so a restore can
 * itself be undone. The file is left as an ordinary local edit; the next push
 * shares it. Returns the recovery folder, if anything was saved.
 */
export function restoreFile(
  roots: Roots,
  rel: string,
  commit: string,
): { recovery?: string; target: string } {
  const root = roots.config;
  const target = path.join(root, rel);
  const show = git(["cat-file", "-e", `${commit}:${rel}`], { cwd: root });
  if (!show.ok) throw new Error(`${rel} does not exist in ${commit.slice(0, 8)}`);
  const recovery = saveToRecovery(roots, "restore", [{ source: target, rel }]);

  // A string pipe would decode as UTF-8 and corrupt binary files, so the blob
  // is read as raw bytes and renamed into place atomically.
  const blob = git(["rev-parse", `${commit}:${rel}`], { cwd: root });
  if (!blob.ok) throw new Error(`Cannot read ${rel} at ${commit.slice(0, 8)}`);
  const raw = execFileSync("git", ["cat-file", "blob", blob.stdout], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const tmp = `${target}.restore-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, target);
  return { recovery, target };
}
