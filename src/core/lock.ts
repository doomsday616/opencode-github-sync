import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process advisory lock.
 *
 * `mkdir` is atomic on every platform we target, which makes it a better
 * primitive than an exclusive file open (Windows leaves the file behind after a
 * hard kill and the next process can never acquire it).
 *
 * A stale lock is reclaimed in two situations:
 *   - the recorded pid no longer exists, or
 *   - the lock is unreadable/corrupt and older than the grace period.
 */

const MALFORMED_GRACE_MS = 30_000;

export interface SyncLock {
  dir: string;
  id: string;
}

export interface AcquireOptions {
  /** How long to wait for an existing holder. Default: fail immediately. */
  waitMs?: number;
  pollMs?: number;
}

function lockDir(configRoot: string): string {
  return path.join(configRoot, ".opencode-sync.lock");
}

function readOwner(dir: string): { id?: string; pid?: number } {
  return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireSyncLock(configRoot: string, options: AcquireOptions = {}): SyncLock | null {
  const { waitMs = 0, pollMs = 250 } = options;
  const dir = lockDir(configRoot);
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      const id = randomUUID();
      fs.mkdirSync(dir, { recursive: false });
      fs.writeFileSync(
        path.join(dir, "owner.json"),
        JSON.stringify({
          id,
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
      return { dir, id };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      if (reclaimIfStale(dir)) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
}

function reclaimIfStale(dir: string): boolean {
  try {
    const owner = readOwner(dir);
    if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) {
      throw new SyntaxError("invalid lock owner");
    }
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(owner.pid as number, 0);
    return false;
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
    const malformed =
      err instanceof SyntaxError || err?.code === "ENOENT" || err?.code === "ENOTDIR";
    if (malformed) {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > MALFORMED_GRACE_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          return true;
        }
      } catch {
        // Lock vanished underneath us — retry the acquire.
        return true;
      }
    }
    return false;
  }
}

export function releaseSyncLock(lock: SyncLock | null): void {
  if (!lock) return;
  try {
    if (readOwner(lock.dir).id === lock.id) {
      fs.rmSync(lock.dir, { recursive: true, force: true });
    }
  } catch {
    // Already released or reclaimed by someone else.
  }
}

/** Run `fn` while holding the lock, always releasing it. */
export async function withSyncLock<T>(
  configRoot: string,
  options: AcquireOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lock = acquireSyncLock(configRoot, options);
  if (!lock) {
    throw new Error("Another opencode-sync operation is already running. Wait for it to finish.");
  }
  try {
    return await fn();
  } finally {
    releaseSyncLock(lock);
  }
}
