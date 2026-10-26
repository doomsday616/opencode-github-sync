import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AutosyncDeps,
  BACKOFF_MAX_MS,
  ENGLISH_MESSAGES,
  backoffDelayMs,
  backoffRemainingMs,
  newestWrite,
  readState,
  runAutosync,
  staggerMs,
  writeState,
} from "../src/core/autosync.js";
import { LargeChangeError } from "../src/core/guard.js";
import type { Roots } from "../src/core/paths.js";
import { emptySummary } from "../src/core/reporter.js";
import { type Settings, defaultSettings } from "../src/core/settings.js";
import { PushRaceError, type SyncResult } from "../src/core/sync.js";

/**
 * The scheduling rules, exercised with a fake clock and fake sync functions.
 * End-to-end runs against a real bare repository live in two-machines.test.ts.
 */

let sandbox: string;
let roots: Roots;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-auto-"));
  roots = {
    config: path.join(sandbox, "config"),
    data: path.join(sandbox, "data"),
    state: path.join(sandbox, "state"),
    agents: path.join(sandbox, "agents"),
    cache: path.join(sandbox, "cache"),
  };
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 8, 0, 0);

function result(message: string): SyncResult {
  return {
    action: "push",
    changed: true,
    summary: emptySummary(),
    files: [],
    message,
    restartRequired: false,
  };
}

interface Harness {
  deps: AutosyncDeps;
  clock: { now: number };
  calls: string[];
  notes: string[];
  settings: Settings;
  logs: string[];
}

function harness(patch: Partial<AutosyncDeps> = {}): Harness {
  const clock = { now: T0 };
  const calls: string[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  const settings = defaultSettings();
  settings.autosync.enabled = true;
  const deps: AutosyncDeps = {
    roots,
    now: () => clock.now,
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
    random: () => 0,
    loadSettings: () => settings,
    push: async () => {
      calls.push("push");
      return result("Pushed 1 change(s)");
    },
    pull: async () => {
      calls.push("pull");
      return result("Pulled 1 change(s)");
    },
    fetchBehind: () => {
      calls.push("fetch");
      return { ok: true, behind: 1 };
    },
    repoSnapshot: () => ({ ok: true, dirty: false, ahead: 0 }),
    newestWrite: () => 0,
    newestUntrackedWrite: () => 0,
    stageOutTime: () => T0 - 10 * MIN,
    tryLock: () => ({ release: () => calls.push("release") }),
    notify: (title) => {
      notes.push(title);
      return true;
    },
    log: (line) => logs.push(line),
    messages: ENGLISH_MESSAGES,
    ...patch,
  };
  return { deps, clock, calls, notes, settings, logs };
}

describe("autosync gate", () => {
  it("does nothing unless enabled on this machine", async () => {
    const h = harness();
    h.settings.autosync.enabled = false;
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("skip");
    expect(h.calls).not.toContain("push");
  });

  it("pushes when idle, enabled and due", async () => {
    const h = harness();
    const outcome = await runAutosync(h.deps);
    expect(outcome).toMatchObject({ action: "push", ok: true });
    expect(h.calls).toContain("push");
    expect(h.calls).toContain("release");
    expect(readState(roots).lastSuccessAt).toBe(T0);
  });

  it("respects the interval since the last attempt", async () => {
    const h = harness();
    writeState(roots, { lastAttemptAt: T0 - 2 * MIN });
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("skip");
    expect(outcome.reason).toMatch(/throttled/);
  });

  it("skips while paused and resumes after", async () => {
    const h = harness();
    h.settings.autosync.pausedUntil = T0 + 60 * MIN;
    expect((await runAutosync(h.deps)).reason).toMatch(/paused/);
    h.clock.now = T0 + 61 * MIN;
    expect((await runAutosync(h.deps)).action).toBe("push");
  });

  it("skips when another sync holds the lock", async () => {
    const h = harness({ tryLock: () => null });
    const outcome = await runAutosync(h.deps);
    expect(outcome).toMatchObject({ action: "skip", reason: "another sync is in progress" });
    expect(h.calls).not.toContain("push");
  });

  it("staggers by a stable per-machine offset", async () => {
    const h = harness();
    delete process.env.OPENCODE_SYNC_NO_STAGGER;
    await runAutosync(h.deps);
    const sleep = h.calls.find((c) => c.startsWith("sleep:"));
    expect(sleep).toBeDefined();
    const ms = Number(sleep!.slice(6));
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(45_000);
    expect(staggerMs("laptop", () => 0)).toBe(staggerMs("laptop", () => 0));
    expect(staggerMs("laptop", () => 0.999)).toBeLessThan(staggerMs("laptop", () => 0) + 5000);
  });
});

describe("settle window", () => {
  it("holds the push back while files are still changing and receives instead", async () => {
    const h = harness({ newestWrite: () => T0 - 10_000 });
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("receive");
    expect(h.calls).toEqual(expect.arrayContaining(["fetch", "pull"]));
    expect(h.calls).not.toContain("push");
  });

  it("does not receive when the repository has local work", async () => {
    const h = harness({
      newestWrite: () => T0 - 10_000,
      repoSnapshot: () => ({ ok: true, dirty: true, ahead: 0 }),
    });
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("skip");
    expect(h.calls).not.toContain("pull");
  });

  it("does not receive when commits are waiting to be pushed", async () => {
    const h = harness({
      newestWrite: () => T0 - 10_000,
      repoSnapshot: () => ({ ok: true, dirty: false, ahead: 2 }),
    });
    expect((await runAutosync(h.deps)).reason).toMatch(/2 local commit/);
  });

  it("does not receive over skills edited since the last write-out", async () => {
    const h = harness({
      newestWrite: () => T0 - 10_000,
      newestUntrackedWrite: () => T0 - 20_000,
      stageOutTime: () => T0 - 60_000,
    });
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("skip");
    expect(outcome.reason).toMatch(/skills/);
  });

  it("does not pull when nothing is waiting", async () => {
    const h = harness({
      newestWrite: () => T0 - 10_000,
      fetchBehind: () => ({ ok: true, behind: 0 }),
    });
    const outcome = await runAutosync(h.deps);
    expect(outcome.action).toBe("skip");
    expect(h.calls).not.toContain("pull");
  });

  it("pushes once the tree has been quiet for the settle time", async () => {
    const h = harness({ newestWrite: () => T0 - 61_000 });
    expect((await runAutosync(h.deps)).action).toBe("push");
  });

  it("ignores noisy files when measuring the newest write", () => {
    const dir = path.join(sandbox, "tree");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "real.md"), "x");
    const old = new Date(T0 - 3600_000);
    fs.utimesSync(path.join(dir, "real.md"), old, old);
    for (const noisy of ["logs/a.log", "node_modules/x/i.js", "bun.lock", "prompt-history.jsonl"]) {
      fs.writeFileSync(path.join(dir, noisy), "n");
    }
    expect(Math.round(newestWrite([dir]))).toBe(Math.round(old.getTime()));
  });
});

describe("backoff", () => {
  it("doubles from 30 to a 60 minute cap", () => {
    expect(backoffDelayMs(3)).toBe(30 * MIN);
    expect(backoffDelayMs(4)).toBe(60 * MIN);
    expect(backoffDelayMs(10)).toBe(BACKOFF_MAX_MS);
  });

  it("enters backoff after three failures, notifies once, and recovers", async () => {
    const h = harness({
      push: async () => {
        throw new Error("Push failed: could not resolve host");
      },
    });

    for (let i = 1; i <= 3; i++) {
      h.clock.now = T0 + i * 10 * MIN;
      const outcome = await runAutosync(h.deps);
      expect(outcome).toMatchObject({ action: "push", ok: false });
    }
    let state = readState(roots);
    expect(state.consecutiveFailures).toBe(3);
    expect(h.notes).toEqual([ENGLISH_MESSAGES.backoffTitle]);
    expect(backoffRemainingMs(state, h.clock.now)).toBe(30 * MIN);

    // Inside the backoff window nothing is attempted.
    h.clock.now += 10 * MIN;
    expect((await runAutosync(h.deps)).reason).toMatch(/backing off/);

    // A fourth failure widens the gap and does not notify again.
    h.clock.now += 21 * MIN;
    await runAutosync(h.deps);
    state = readState(roots);
    expect(state.consecutiveFailures).toBe(4);
    expect(backoffRemainingMs(state, h.clock.now)).toBe(60 * MIN);
    expect(h.notes).toHaveLength(1);

    // Never gives up: after the cap it tries again, and success resets.
    h.deps.push = async () => result("Pushed 1 change(s)");
    h.clock.now += 61 * MIN;
    expect((await runAutosync(h.deps)).ok).toBe(true);
    state = readState(roots);
    expect(state.consecutiveFailures).toBe(0);
    expect(h.notes).toEqual([ENGLISH_MESSAGES.backoffTitle, ENGLISH_MESSAGES.recoveredTitle]);
  });

  it("treats a lost push race as contention, not failure", async () => {
    const h = harness({
      push: async () => {
        throw new PushRaceError("Another machine kept publishing first");
      },
    });
    for (let i = 0; i < 5; i++) {
      h.clock.now = T0 + i * 10 * MIN;
      await runAutosync(h.deps);
    }
    expect(readState(roots).consecutiveFailures ?? 0).toBe(0);
    expect(h.notes).toHaveLength(0);
  });

  it("respects the notification toggle", async () => {
    const h = harness({
      push: async () => {
        throw new Error("network down");
      },
    });
    h.settings.notifications = false;
    for (let i = 1; i <= 4; i++) {
      h.clock.now = T0 + i * 40 * MIN;
      await runAutosync(h.deps);
    }
    expect(h.notes).toHaveLength(0);
  });

  it("never confirms a large change: records a failure and notifies", async () => {
    const h = harness({
      push: async () => {
        throw new LargeChangeError({
          addedFiles: 999,
          totalBytes: 1,
          oversized: [],
          reasons: ["files"],
        });
      },
    });
    const outcome = await runAutosync(h.deps);
    expect(outcome.ok).toBe(false);
    expect(readState(roots).consecutiveFailures).toBe(1);
    expect(h.notes).toEqual([ENGLISH_MESSAGES.largeTitle]);
  });

  it("tolerates a corrupted state file", async () => {
    fs.writeFileSync(
      path.join(roots.state, "opencode-sync-autosync.json"),
      '{"consecutiveFailures":"41"',
    );
    const h = harness();
    expect((await runAutosync(h.deps)).ok).toBe(true);
  });
});

describe("self-update", () => {
  it("checks at most once a day and only when switched on", async () => {
    let checks = 0;
    const h = harness({
      selfUpdate: () => {
        checks++;
        return "up to date";
      },
    });
    await runAutosync(h.deps);
    expect(checks).toBe(0);
    h.settings.autosync.autoUpdate = true;
    h.clock.now += 10 * MIN;
    await runAutosync(h.deps);
    h.clock.now += 10 * MIN;
    await runAutosync(h.deps);
    expect(checks).toBe(1);
    h.clock.now += 25 * 60 * MIN;
    await runAutosync(h.deps);
    expect(checks).toBe(2);
  });
});
