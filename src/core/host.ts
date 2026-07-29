import { createHash } from "node:crypto";
import os from "node:os";

/**
 * A short, stable alias for the current machine.
 *
 * Commit messages record which machine produced a change. Raw hostnames are a
 * bad idea: corporate machines are often named after an asset tag, which is
 * effectively personally identifying information, and the sync repo may not
 * stay private forever. So unless the user picks a name explicitly we derive a
 * stable pseudonym from a hash of the hostname.
 *
 * Precedence:
 *   1. `OPENCODE_SYNC_HOST_ALIAS` environment variable
 *   2. `machine.alias` in the sync config file (passed in as `configured`)
 *   3. `<platform>-<hash>` fallback
 */
export function hostAlias(configured?: string): string {
  const fromEnv = process.env.OPENCODE_SYNC_HOST_ALIAS;
  if (fromEnv) return sanitizeAlias(fromEnv);
  if (configured) return sanitizeAlias(configured);

  const raw = os.hostname() || "unknown";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 6);
  return `${platformTag()}-${digest}`;
}

function platformTag(): string {
  switch (process.platform) {
    case "win32":
      return "win";
    case "darwin":
      return "mac";
    default:
      return "linux";
  }
}

/** Keep aliases filesystem- and commit-message-safe. */
export function sanitizeAlias(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/** Build a sync commit message: `sync: 2026-07-29 10:04:11 from mac-1a2b3c`. */
export function commitMessage(prefix: string, alias: string): string {
  const time = new Date().toISOString().replace("T", " ").replace(/\..+/, "");
  return `${prefix}: ${time} from ${alias}`;
}
