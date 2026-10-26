import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git.js";
import { AGENTS_DIR, DATA_DIR, SESSIONS_DIR, STATE_DIR } from "./paths.js";
import { OVERRIDES_FILE, SETTINGS_FILE } from "./settings.js";

/**
 * Compare this machine's config directory with a remote branch without
 * touching either: the remote is fetched into a throwaway bare repository and
 * local files are hashed in-process the way git would store them.
 *
 * Used before the first link, so the user can choose which side wins knowing
 * what would change.
 */

export interface FileDifference {
  path: string;
  kind: "onlyLocal" | "different" | "onlyRemote";
}

export interface CompareResult {
  /** The remote branch has no commits yet. */
  empty: boolean;
  differences: FileDifference[];
}

const SKIP_TOP = new Set([
  ".git",
  DATA_DIR,
  STATE_DIR,
  AGENTS_DIR,
  SESSIONS_DIR,
  "_extra",
  SETTINGS_FILE,
  OVERRIDES_FILE,
  ".opencode-sync.lock",
  // Written by the tool itself on the first sync.
  ".gitignore",
  ".gitattributes",
]);
const SKIP_ANY = new Set(["node_modules", "logs", "log", "__pycache__", ".venv", "venv"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "bun.lock"]);

/** The blob id git would assign to this content once normalised to LF. */
export function gitBlobId(content: Buffer): string {
  const binary = content.includes(0);
  const data = binary ? content : Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"));
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

function localFiles(root: string, skipDirs: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const skipAny = new Set([...SKIP_ANY, ...skipDirs]);
  const walk = (rel: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && SKIP_TOP.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!skipAny.has(entry.name)) walk(childRel, depth + 1);
        continue;
      }
      if (SKIP_FILES.has(entry.name) || entry.name.endsWith(".pyc")) continue;
      try {
        files.set(childRel, gitBlobId(fs.readFileSync(path.join(root, childRel))));
      } catch {
        // Unreadable files cannot be compared; skip them.
      }
    }
  };
  if (fs.existsSync(root)) walk("", 0);
  return files;
}

function remoteFiles(tree: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of tree.split("\n")) {
    const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) continue;
    const [, id, rel] = match;
    const top = rel!.split("/")[0]!;
    if (SKIP_TOP.has(top)) continue;
    files.set(rel!.replace(/^"(.*)"$/, "$1"), id!);
  }
  return files;
}

export function compareWithRemote(
  root: string,
  remote: string,
  branch: string,
  skipDirs: string[] = [],
): CompareResult {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-compare-"));
  try {
    git(["init", "--bare", "-q", scratch], { cwd: os.tmpdir() });
    const fetched = git(["fetch", "-q", "--depth=1", remote, branch], {
      cwd: scratch,
      timeoutMs: 120_000,
    });
    if (!fetched.ok) {
      if (/couldn't find remote ref|not found|does not appear/i.test(fetched.stderr)) {
        return { empty: true, differences: [] };
      }
      // An empty repository answers the fetch with a missing ref as well.
      const listed = git(["ls-remote", remote], { cwd: scratch, timeoutMs: 60_000 });
      if (listed.ok && listed.stdout.trim() === "") return { empty: true, differences: [] };
      throw new Error(`Cannot read ${remote}: ${fetched.stderr.split("\n")[0]}`);
    }
    const tree = git(["-c", "core.quotepath=off", "ls-tree", "-r", "FETCH_HEAD"], {
      cwd: scratch,
    });
    const theirs = remoteFiles(tree.ok ? tree.stdout : "");
    const ours = localFiles(root, skipDirs);
    const differences: FileDifference[] = [];
    for (const [rel, id] of ours) {
      const other = theirs.get(rel);
      if (other === undefined) differences.push({ path: rel, kind: "onlyLocal" });
      else if (other !== id) differences.push({ path: rel, kind: "different" });
    }
    for (const rel of theirs.keys()) {
      if (!ours.has(rel)) differences.push({ path: rel, kind: "onlyRemote" });
    }
    differences.sort((a, b) => a.path.localeCompare(b.path));
    return { empty: false, differences };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
