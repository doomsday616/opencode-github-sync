import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGLISH_MESSAGES, defaultDeps, readState, runAutosync } from "../src/core/autosync.js";
import { compareWithRemote } from "../src/core/compare.js";
import { git } from "../src/core/git.js";
import { LargeChangeError } from "../src/core/guard.js";
import { fileHistory, listDevices, restoreFile } from "../src/core/history.js";
import type { Roots } from "../src/core/paths.js";
import { listRecovery } from "../src/core/recovery.js";
import { CollectingReporter } from "../src/core/reporter.js";
import { type Settings, defaultSettings, saveSettings } from "../src/core/settings.js";
import { pull, push } from "../src/core/sync.js";

/**
 * Two simulated machines, each with its own set of roots, syncing through a
 * bare repository on disk. Nothing touches the real home directory.
 */

let sandbox: string;
let remote: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-2m-"));
  remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  process.env.OPENCODE_SYNC_NO_STAGGER = "1";
});

afterEach(() => {
  delete process.env.OPENCODE_SYNC_NO_STAGGER;
  delete process.env.OPENCODE_SYNC_HOST_ALIAS;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

interface Machine {
  name: string;
  roots: Roots;
  settings: Settings;
}

function machine(name: string, patch: (s: Settings) => void = () => {}): Machine {
  const base = path.join(sandbox, name);
  const roots: Roots = {
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    agents: path.join(base, "agents", "skills"),
    cache: path.join(base, "cache"),
  };
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
  const settings = defaultSettings();
  settings.repo = { url: remote, branch: "main" };
  settings.machineAlias = name;
  settings.autosync.enabled = true;
  settings.autosync.settleSeconds = 60;
  patch(settings);
  saveSettings(settings, roots.config);
  return { name, roots, settings };
}

const write = (file: string, content: string, mtime?: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
};
const read = (file: string): string => fs.readFileSync(file, "utf8");

/** Push with the machine's own settings. */
const pushFrom = (m: Machine, extra = {}) =>
  push({ settings: m.settings, roots: m.roots, reporter: new CollectingReporter(), ...extra });
const pullTo = (m: Machine, extra = {}) =>
  pull({ settings: m.settings, roots: m.roots, reporter: new CollectingReporter(), ...extra });

/** Age every file under the machine's trees so the settle rule sees quiet. */
function settle(m: Machine, ageMs = 10 * 60_000): void {
  const stamp = new Date(Date.now() - ageMs);
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(p);
      else fs.utimesSync(p, stamp, stamp);
    }
  };
  for (const dir of [m.roots.config, m.roots.agents]) if (fs.existsSync(dir)) walk(dir);
}

function autosync(m: Machine) {
  const deps = defaultDeps(m.roots, {
    home: path.join(sandbox, m.name, "home"),
    notify: () => false,
    messages: ENGLISH_MESSAGES,
    sleep: async () => {},
  });
  return runAutosync(deps, "test");
}

describe("autosync between two machines", () => {
  it("propagates an edit from A to B through scheduled runs", async () => {
    const a = machine("alpha");
    const b = machine("beta");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "one" }\n');
    write(path.join(a.roots.agents, "s1", "SKILL.md"), "skill one\n");
    settle(a);
    expect((await autosync(a)).action).toBe("push");

    // B starts empty: its first scheduled run sends nothing and receives.
    settle(b);
    const first = await autosync(b);
    expect(first.ok).toBe(true);
    expect(read(path.join(b.roots.config, "opencode.jsonc"))).toContain("one");
    expect(read(path.join(b.roots.agents, "s1", "SKILL.md"))).toBe("skill one\n");

    // A edits again; B picks it up on its next due run. The new content has a
    // different size and age: `settle` backdates mtimes, and a same-size file
    // with an identical backdated mtime would look unchanged to git's stat cache.
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "second" }\n');
    settle(a, 5 * 60_000);
    fs.rmSync(path.join(a.roots.state, "opencode-sync-autosync.json"), { force: true });
    expect((await autosync(a)).action).toBe("push");
    settle(b);
    fs.rmSync(path.join(b.roots.state, "opencode-sync-autosync.json"), { force: true });
    expect((await autosync(b)).ok).toBe(true);
    expect(read(path.join(b.roots.config, "opencode.jsonc"))).toContain("second");
  });

  it("receives only while this machine's files are still changing", async () => {
    const a = machine("alpha");
    const b = machine("beta");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "one" }\n');
    await pushFrom(a);
    await pullTo(b);

    write(path.join(a.roots.config, "AGENTS.md"), "from alpha\n");
    await pushFrom(a);

    // B is busy: a file just changed in its config directory, but the edit is
    // in a tracked file, so the repository is dirty and nothing is received.
    write(path.join(b.roots.config, "notes.md"), "typing...\n");
    let outcome = await autosync(b);
    expect(outcome.action).toBe("skip");
    expect(fs.existsSync(path.join(b.roots.config, "AGENTS.md"))).toBe(false);

    // Once the edit is gone but the tree was just touched, receive-only runs.
    fs.rmSync(path.join(b.roots.config, "notes.md"));
    write(path.join(b.roots.cache, "touch"), "x");
    const busy = path.join(b.roots.config, "opencode.jsonc");
    fs.utimesSync(busy, new Date(), new Date());
    outcome = await autosync(b);
    expect(outcome.action).toBe("receive");
    expect(read(path.join(b.roots.config, "AGENTS.md"))).toBe("from alpha\n");
    expect(git(["log", "-1", "--format=%s"], { cwd: b.roots.config }).stdout).toContain("alpha");
  });

  it("skips while another process holds the lock", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    settle(a);
    const lockDir = path.join(a.roots.config, ".opencode-sync.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ id: "x", pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const outcome = await autosync(a);
    expect(outcome).toMatchObject({ action: "skip", reason: "another sync is in progress" });
    fs.rmSync(lockDir, { recursive: true });
  });

  it("records failures and backs off when the remote is unreachable", async () => {
    const a = machine("alpha", (s) => {
      s.repo.url = path.join(sandbox, "missing.git");
    });
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    settle(a);
    const outcome = await autosync(a);
    expect(outcome.ok).toBe(false);
    expect(readState(a.roots).consecutiveFailures).toBe(1);
  });
});

describe("push race", () => {
  it("rebases and retries when another machine published in between", async () => {
    const a = machine("alpha");
    const b = machine("beta");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    await pushFrom(a);
    await pullTo(b);

    write(path.join(a.roots.config, "a.md"), "a\n");
    write(path.join(b.roots.config, "b.md"), "b\n");

    // Install a pre-push hook on B that lets A publish first, once.
    const hook = path.join(b.roots.config, ".git", "hooks", "pre-push");
    const marker = path.join(sandbox, "raced");
    const script = [
      "#!/bin/sh",
      `if [ ! -f '${marker.replace(/\\/g, "/")}' ]; then`,
      `  touch '${marker.replace(/\\/g, "/")}'`,
      `  cd '${a.roots.config.replace(/\\/g, "/")}' && git add -A && git commit -qm 'race: from alpha' && git push -q origin main`,
      "fi",
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(hook, script, { mode: 0o755 });

    const result = await pushFrom(b);
    expect(result.changed).toBe(true);
    const log = git(["log", "--format=%s", "origin/main"], { cwd: b.roots.config }).stdout;
    expect(log).toContain("race: from alpha");
    expect(log.split("\n")[0]).toContain("beta");
    expect(read(path.join(b.roots.config, "a.md"))).toBe("a\n");
  });
});

describe("large-change guard", () => {
  it("refuses an oversized push unless confirmed", async () => {
    const a = machine("alpha", (s) => {
      s.guard.maxFiles = 5;
    });
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    await pushFrom(a);
    const before = git(["ls-remote", remote], { cwd: sandbox }).stdout;
    for (let i = 0; i < 8; i++) write(path.join(a.roots.config, "command", `c${i}.md`), `${i}\n`);
    await expect(pushFrom(a)).rejects.toBeInstanceOf(LargeChangeError);
    expect(git(["ls-remote", remote], { cwd: sandbox }).stdout).toBe(before);

    let asked = 0;
    const confirmed = await pushFrom(a, {
      confirmLarge: () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(1);
    expect(confirmed.changed).toBe(true);
  });

  it("lets the first push into an empty repository carry the whole setup", async () => {
    const a = machine("alpha", (s) => {
      s.guard.maxFiles = 5;
    });
    for (let i = 0; i < 8; i++) write(path.join(a.roots.config, "command", `c${i}.md`), `${i}\n`);
    expect((await pushFrom(a)).changed).toBe(true);
  });

  it("flags a single oversized file", async () => {
    const a = machine("alpha", (s) => {
      s.guard.maxFileBytes = 1024;
    });
    write(path.join(a.roots.config, "big.bin"), "x".repeat(4096));
    const dry = await pushFrom(a, { dryRun: true });
    expect(dry.guard?.reasons).toContain("file");
    expect(dry.guard?.oversized[0]?.path).toBe("big.bin");
  });

  it("never stages generated directories inside synced trees", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.config, "tools", ".venv", "lib", "x.py"), "x\n");
    write(path.join(a.roots.config, "tools", "dist", "bundle.js"), "x\n");
    write(path.join(a.roots.config, "tools", "main.py"), "x\n");
    await pushFrom(a);
    const files = git(["ls-files"], { cwd: a.roots.config }).stdout;
    expect(files).toContain("tools/main.py");
    expect(files).not.toContain(".venv");
    expect(files).not.toContain("dist/bundle.js");
  });
});

describe("category toggles", () => {
  it("keeps a disabled category local in both directions", async () => {
    const a = machine("alpha");
    const b = machine("beta", (s) => {
      s.categories.instructions = false;
    });
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.config, "AGENTS.md"), "shared\n");
    await pushFrom(a);

    write(path.join(b.roots.config, "AGENTS.md"), "local only\n");
    await pullTo(b);
    expect(read(path.join(b.roots.config, "AGENTS.md"))).toBe("local only\n");
    expect(fs.existsSync(path.join(b.roots.config, "opencode.jsonc"))).toBe(true);

    write(path.join(b.roots.config, "AGENTS.md"), "local edit\n");
    write(path.join(b.roots.config, "command", "x.md"), "x\n");
    await pushFrom(b);
    const shared = git(["show", "origin/main:AGENTS.md"], { cwd: b.roots.config }).stdout;
    expect(shared).toBe("shared");
    expect(read(path.join(b.roots.config, "AGENTS.md"))).toBe("local edit\n");

    await pullTo(a);
    expect(read(path.join(a.roots.config, "command", "x.md"))).toBe("x\n");
    expect(read(path.join(a.roots.config, "AGENTS.md"))).toBe("shared\n");
  });
});

describe("history", () => {
  it("restores an earlier version and keeps the replaced bytes", async () => {
    const a = machine("alpha");
    const file = path.join(a.roots.config, "AGENTS.md");
    write(file, "version 1\n");
    await pushFrom(a);
    write(file, "version 2\n");
    await pushFrom(a);

    const history = fileHistory(a.roots.config, "AGENTS.md");
    expect(history).toHaveLength(2);
    const result = restoreFile(a.roots, "AGENTS.md", history[1]!.commit);
    expect(read(file)).toBe("version 1\n");
    expect(result.recovery).toBeDefined();
    expect(read(path.join(result.recovery!, "AGENTS.md"))).toBe("version 2\n");
  });

  it("lists devices from trailers and legacy subjects", async () => {
    const a = machine("alpha");
    const b = machine("beta");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    await pushFrom(a);
    await pullTo(b);
    write(path.join(b.roots.config, "x.md"), "x\n");
    await pushFrom(b);
    // A commit from an older release has no trailer, only the subject.
    write(path.join(b.roots.config, "y.md"), "y\n");
    git(["add", "-A"], { cwd: b.roots.config });
    git(["commit", "-qm", "sync: 2026-01-01 00:00:00 from gamma-old"], { cwd: b.roots.config });

    const devices = listDevices(b.roots.config).map((d) => d.alias);
    expect(devices).toEqual(["gamma-old", "beta", "alpha"]);
  });
});

describe("forced pull recovery", () => {
  it("saves new folders, non-ASCII names and local-only skills before replacing them", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.agents, "shared", "SKILL.md"), "shared\n");
    await pushFrom(a);

    const b = machine("beta");
    await pullTo(b);
    write(path.join(a.roots.config, "AGENTS.md"), "from alpha\n");
    await pushFrom(a);

    write(path.join(b.roots.config, "notes", "draft.md"), "draft\n");
    write(path.join(b.roots.config, "技能.md"), "中文\n");
    write(path.join(b.roots.agents, "mine", "SKILL.md"), "mine\n");
    await pullTo(b, { force: true });

    expect(fs.existsSync(path.join(b.roots.config, "notes"))).toBe(false);
    expect(fs.existsSync(path.join(b.roots.agents, "mine"))).toBe(false);
    const saved = listRecovery(b.roots).map((dir) => dir);
    const find = (rel: string) => saved.find((dir) => fs.existsSync(path.join(dir, rel)));
    expect(read(path.join(find(path.join("notes", "draft.md"))!, "notes", "draft.md"))).toBe(
      "draft\n",
    );
    expect(read(path.join(find("技能.md")!, "技能.md"))).toBe("中文\n");
    const skill = path.join("skills", "mine", "SKILL.md");
    expect(read(path.join(find(skill)!, skill))).toBe("mine\n");
    expect(find(path.join("skills", "shared", "SKILL.md"))).toBeUndefined();
  });
});

describe("first link", () => {
  it("compares local files with the remote without touching either", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "a" }\n');
    write(path.join(a.roots.config, "AGENTS.md"), "same\n");
    await pushFrom(a);

    const b = machine("beta");
    write(path.join(b.roots.config, "opencode.jsonc"), '{ "model": "b" }\r\n');
    write(path.join(b.roots.config, "AGENTS.md"), "same\r\n");
    write(path.join(b.roots.config, "mine.md"), "mine\n");

    const diff = compareWithRemote(b.roots.config, remote, "main");
    expect(diff.empty).toBe(false);
    expect(diff.differences).toEqual([
      { path: "mine.md", kind: "onlyLocal" },
      { path: "opencode.jsonc", kind: "different" },
    ]);
    expect(fs.existsSync(path.join(b.roots.config, ".git"))).toBe(false);

    const empty = path.join(sandbox, "empty.git");
    execFileSync("git", ["init", "--bare", "-b", "main", empty], { stdio: "pipe" });
    expect(compareWithRemote(b.roots.config, empty, "main").empty).toBe(true);
  });

  it("repository wins: local files go to recovery first", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "a" }\n');
    await pushFrom(a);

    const b = machine("beta");
    write(path.join(b.roots.config, "opencode.jsonc"), '{ "model": "b" }\n');
    await pullTo(b);
    expect(read(path.join(b.roots.config, "opencode.jsonc"))).toContain('"a"');
    const saved = listRecovery(b.roots)[0];
    expect(saved).toBeDefined();
    expect(read(path.join(saved!, "opencode.jsonc"))).toContain('"b"');
  });

  it("local wins: this machine's files are pushed on top", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "a" }\n');
    write(path.join(a.roots.config, "theirs.md"), "theirs\n");
    await pushFrom(a);

    const b = machine("beta");
    write(path.join(b.roots.config, "opencode.jsonc"), '{ "model": "b" }\n');
    await pushFrom(b, { adopt: "local" });
    const shared = git(["show", "origin/main:opencode.jsonc"], { cwd: b.roots.config }).stdout;
    expect(shared).toContain('"b"');
    expect(read(path.join(b.roots.config, "opencode.jsonc"))).toContain('"b"');
  });
});
