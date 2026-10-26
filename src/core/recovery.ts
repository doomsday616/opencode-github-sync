import fs from "node:fs";
import path from "node:path";
import type { Roots } from "./paths.js";

/**
 * Recovery copies.
 *
 * Whenever this tool is about to replace bytes the user may still want — a
 * forced pull, a "repository wins" first link, a file restored from history —
 * the current version is copied here first. The directory lives under the data
 * root, which is never mirrored into the repository as a whole, so recovery
 * copies stay on this machine.
 */

export const RECOVERY_DIR = "opencode-sync-recovery";

export function recoveryRoot(roots: Roots): string {
  return path.join(roots.data, RECOVERY_DIR);
}

export interface RecoveryEntry {
  /** Absolute path of the file being replaced. */
  source: string;
  /** Relative path used inside the recovery folder. */
  rel: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/**
 * Copy files into a fresh recovery folder. Missing sources are skipped.
 * Returns the folder, or `undefined` when nothing needed saving.
 */
export function saveToRecovery(
  roots: Roots,
  label: string,
  entries: RecoveryEntry[],
  now = new Date(),
): string | undefined {
  const existing = entries.filter((e) => {
    try {
      return fs.statSync(e.source).isFile();
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return undefined;
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = path.join(recoveryRoot(roots), `${stamp(now)}-${safeLabel}`);
  for (const entry of existing) {
    const rel = entry.rel.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, "");
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.source, target);
  }
  return dir;
}

/** Recovery folders, newest first. */
export function listRecovery(roots: Roots): string[] {
  const root = recoveryRoot(roots);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .sort()
    .reverse();
}
