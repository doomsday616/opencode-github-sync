import fs from "node:fs";
import path from "node:path";
import type { ChangedFile } from "./reporter.js";
import type { GuardSettings } from "./settings.js";

/**
 * Large-change guard.
 *
 * The usual way a sync repository gets ruined is not a conflict but an
 * accident: a virtualenv created inside a skill, a build output dropped into
 * the config directory, a log that grew to a gigabyte. Each is one `git add`
 * away from being in the history of every machine for ever. A push that adds
 * an unusual amount of data is therefore held back until a person confirms it.
 * The unattended scheduler never confirms; it records a failure instead.
 */

export interface GuardReport {
  addedFiles: number;
  totalBytes: number;
  largest?: { path: string; bytes: number };
  /** Files above the single-file limit, largest first. */
  oversized: { path: string; bytes: number }[];
  /** Human-readable reasons; empty when the push is within limits. */
  reasons: ("files" | "bytes" | "file")[];
}

export function evaluateGuard(
  root: string,
  files: ChangedFile[],
  limits: GuardSettings,
): GuardReport {
  let addedFiles = 0;
  let totalBytes = 0;
  const sizes: { path: string; bytes: number }[] = [];

  for (const file of files) {
    if (file.kind === "deleted") continue;
    if (file.kind === "added") addedFiles++;
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(root, file.path)).size;
    } catch {
      // Vanished or unreadable: it cannot add weight to the push.
    }
    totalBytes += bytes;
    sizes.push({ path: file.path, bytes });
  }

  sizes.sort((a, b) => b.bytes - a.bytes);
  const oversized = sizes.filter((s) => s.bytes > limits.maxFileBytes);
  const reasons: GuardReport["reasons"] = [];
  if (addedFiles > limits.maxFiles) reasons.push("files");
  if (totalBytes > limits.maxBytes) reasons.push("bytes");
  if (oversized.length > 0) reasons.push("file");

  return { addedFiles, totalBytes, largest: sizes[0], oversized, reasons };
}

export class LargeChangeError extends Error {
  constructor(readonly report: GuardReport) {
    super(
      `This push is unusually large (${report.addedFiles} new file(s), ${report.totalBytes} bytes).\n` +
        "Confirm it interactively, raise the limits in the menu, or add the directory to the skip list.",
    );
    this.name = "LargeChangeError";
  }
}

/** Patterns written to `.git/info/exclude` so generated trees are never staged. */
export function excludeFileContent(skipDirs: string[]): string {
  const lines = [
    "# Managed by opencode-github-sync: generated directories never synced.",
    ...skipDirs.filter((d) => /^[^\\/*?[\]]+$/.test(d)).map((d) => `${d}/`),
  ];
  return `${lines.join("\n")}\n`;
}

export function writeLocalExcludes(root: string, skipDirs: string[]): void {
  const file = path.join(root, ".git", "info", "exclude");
  if (!fs.existsSync(path.join(root, ".git"))) return;
  const content = excludeFileContent(skipDirs);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch {
    // Best effort: the large-change guard still catches what slips through.
  }
}
