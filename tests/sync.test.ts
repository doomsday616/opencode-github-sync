import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/core/git.js";
import { getRoots } from "../src/core/paths.js";
import { CollectingReporter } from "../src/core/reporter.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings.js";
import { pull, push, status } from "../src/core/sync.js";

/**
 * End-to-end coverage against a real git remote.
 *
 * A bare repository on disk behaves exactly like GitHub for everything the sync
 * logic does — fetch, push, force-with-lease, rebase — while keeping the test
 * offline and fast. Two separate "machines" are simulated by pointing the
 * environment overrides at two directory trees.
 */

let sandbox: string;
let remote: string;

interface Machine {
  config: string;
  data: string;
  state: string;
  agents: string;
  cache: string;
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-sync-"));
  remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
});

afterEach(() => {
  clearEnv();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function makeMachine(name: string): Machine {
  const base = path.join(sandbox, name);
  const machine: Machine = {
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    agents: path.join(base, "agents", "skills"),
    cache: path.join(base, "cache"),
  };
  for (const dir of Object.values(machine)) fs.mkdirSync(dir, { recursive: true });
  return machine;
}

function useMachine(machine: Machine): void {
  process.env.SYNC_CONFIG_ROOT = machine.config;
  process.env.SYNC_DATA_ROOT = machine.data;
  process.env.SYNC_STATE_ROOT = machine.state;
  process.env.SYNC_AGENTS_ROOT = machine.agents;
  process.env.SYNC_CACHE_ROOT = machine.cache;
  process.env.SYNC_REMOTE_URL = remote;
}

function clearEnv(): void {
  for (const key of [
    "SYNC_CONFIG_ROOT",
    "SYNC_DATA_ROOT",
    "SYNC_STATE_ROOT",
    "SYNC_AGENTS_ROOT",
    "SYNC_CACHE_ROOT",
    "SYNC_REMOTE_URL",
    "OPENCODE_SYNC_HOST_ALIAS",
  ]) {
    delete process.env[key];
  }
}

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
  repo: { ...DEFAULT_SETTINGS.repo, url: remote, ...(patch.repo ?? {}) },
  sessions: { ...DEFAULT_SETTINGS.sessions, ...(patch.sessions ?? {}) },
});

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("push and pull", () => {
  it("moves configuration from one machine to another", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "model": "shared" }\n');
    write(path.join(a.config, "command", "hello.md"), "hi\n");
    write(path.join(a.agents, "my-skill", "SKILL.md"), "skill\n");

    const pushed = await push({
      settings: settings(),
      roots: getRoots(),
      reporter: new CollectingReporter(),
    });
    expect(pushed.changed).toBe(true);

    const b = makeMachine("b");
    useMachine(b);
    const pulled = await pull({
      settings: settings(),
      roots: getRoots(),
      reporter: new CollectingReporter(),
    });
    expect(pulled.changed).toBe(true);

    expect(read(path.join(b.config, "opencode.jsonc"))).toContain("shared");
    expect(read(path.join(b.config, "command", "hello.md"))).toBe("hi\n");
    expect(read(path.join(b.agents, "my-skill", "SKILL.md"))).toBe("skill\n");
  });

  it("reports no changes on a second push", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");

    await push({ settings: settings(), roots: getRoots() });
    const again = await push({ settings: settings(), roots: getRoots() });

    expect(again.changed).toBe(false);
    expect(again.message).toMatch(/up to date/i);
  });

  it("propagates a deletion", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.config, "command", "temp.md"), "temp\n");
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });
    expect(fs.existsSync(path.join(b.config, "command", "temp.md"))).toBe(true);

    useMachine(a);
    fs.rmSync(path.join(a.config, "command", "temp.md"));
    await push({ settings: settings(), roots: getRoots() });

    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });
    expect(fs.existsSync(path.join(b.config, "command", "temp.md"))).toBe(false);
  });

  it("refuses to pull over unpushed local commits", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });

    // Machine A moves ahead.
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "a": 1 }\n');
    await push({ settings: settings(), roots: getRoots() });

    // Machine B commits locally without pushing.
    useMachine(b);
    write(path.join(b.config, "opencode.jsonc"), '{ "b": 2 }\n');
    execFileSync("git", ["add", "-A"], { cwd: b.config, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "local"], { cwd: b.config, stdio: "pipe" });

    await expect(pull({ settings: settings(), roots: getRoots() })).rejects.toThrow(
      /never pushed/i,
    );
  });

  it("discards local commits with force", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "shared": true }\n');
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });
    write(path.join(b.config, "opencode.jsonc"), '{ "local": true }\n');
    execFileSync("git", ["add", "-A"], { cwd: b.config, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "local"], { cwd: b.config, stdio: "pipe" });

    await pull({ settings: settings(), roots: getRoots(), force: true });
    expect(read(path.join(b.config, "opencode.jsonc"))).toContain("shared");
  });

  it("keeps uncommitted local edits through a pull", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.config, "command", "one.md"), "one\n");
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });

    useMachine(a);
    write(path.join(a.config, "command", "two.md"), "two\n");
    await push({ settings: settings(), roots: getRoots() });

    useMachine(b);
    write(path.join(b.config, "command", "scratch.md"), "mine\n");
    await pull({ settings: settings(), roots: getRoots() });

    expect(read(path.join(b.config, "command", "two.md"))).toBe("two\n");
    expect(read(path.join(b.config, "command", "scratch.md"))).toBe("mine\n");
  });

  it("never commits the SQLite database", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.data, "opencode.db"), "PRETEND-BINARY");
    write(path.join(a.data, "opencode.db-wal"), "WAL");
    await push({ settings: settings(), roots: getRoots() });

    const tracked = execFileSync("git", ["ls-files"], { cwd: a.config, encoding: "utf8" });
    expect(tracked).not.toMatch(/opencode\.db/);
  });

  it("keeps credentials out of the repository unless enabled", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.data, "auth.json"), '{ "token": "secret" }');

    await push({ settings: settings(), roots: getRoots() });
    let tracked = execFileSync("git", ["ls-files"], { cwd: a.config, encoding: "utf8" });
    expect(tracked).not.toMatch(/auth\.json/);

    await push({ settings: settings({ includeCredentials: true }), roots: getRoots() });
    tracked = execFileSync("git", ["ls-files"], { cwd: a.config, encoding: "utf8" });
    expect(tracked).toMatch(/_data\/auth\.json/);
  });

  it("removes credentials from the repository when the option is turned off", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.data, "auth.json"), '{ "token": "secret" }');
    await push({ settings: settings({ includeCredentials: true }), roots: getRoots() });

    await push({ settings: settings({ includeCredentials: false }), roots: getRoots() });
    const tracked = execFileSync("git", ["ls-files"], { cwd: a.config, encoding: "utf8" });
    expect(tracked).not.toMatch(/auth\.json/);
  });

  it("reports changes without writing anything in dry-run mode", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");

    const dry = await push({ settings: settings(), roots: getRoots(), dryRun: true });
    expect(dry.changed).toBe(true);

    // A dry run must not create a commit; the branch still has no history.
    const head = git(["rev-parse", "--verify", "HEAD"], { cwd: a.config });
    expect(head.ok).toBe(false);
  });
});

describe("per-machine overrides", () => {
  it("keeps an overridden key local and preserves the shared value", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "model": "shared-model", "theme": "dark" }\n');
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    write(path.join(b.config, "opencode-sync.overrides.jsonc"), '{ "model": "local-model" }\n');
    await pull({ settings: settings(), roots: getRoots() });

    // The override wins locally.
    const effective = JSON.parse(read(path.join(b.config, "opencode.jsonc")));
    expect(effective.model).toBe("local-model");
    expect(effective.theme).toBe("dark");

    // Pushing from B must not leak the local model back to the shared repo.
    await push({ settings: settings(), roots: getRoots() });

    useMachine(a);
    await pull({ settings: settings(), roots: getRoots() });
    expect(JSON.parse(read(path.join(a.config, "opencode.jsonc"))).model).toBe("shared-model");
  });

  it("leaves the effective config on disk after a push", async () => {
    // Staging rewrites the config into its shareable form. If that were left
    // behind, pushing would silently strip the machine's own settings.
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "model": "shared" }\n');
    await push({ settings: settings(), roots: getRoots() });

    write(path.join(a.config, "opencode-sync.overrides.jsonc"), '{ "model": "mine" }\n');
    write(path.join(a.config, "opencode.jsonc"), '{ "model": "mine" }\n');
    await push({ settings: settings(), roots: getRoots() });

    expect(JSON.parse(read(path.join(a.config, "opencode.jsonc"))).model).toBe("mine");
    const committed = execFileSync("git", ["show", "HEAD:opencode.jsonc"], {
      cwd: a.config,
      encoding: "utf8",
    });
    expect(JSON.parse(committed).model).toBe("shared");
  });

  it("leaves the config untouched when no overrides exist", async () => {
    const a = makeMachine("a");
    useMachine(a);
    const original = '{\n  // a comment survives\n  "model": "shared",\n}\n';
    write(path.join(a.config, "opencode.jsonc"), original);
    await push({ settings: settings(), roots: getRoots() });

    expect(read(path.join(a.config, "opencode.jsonc"))).toBe(original);
  });

  it("never commits the overrides file itself", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.config, "opencode-sync.overrides.jsonc"), '{ "x": 1 }\n');
    write(path.join(a.config, "opencode-sync.jsonc"), '{ "repo": {} }\n');
    await push({ settings: settings(), roots: getRoots() });

    const tracked = execFileSync("git", ["ls-files"], { cwd: a.config, encoding: "utf8" });
    expect(tracked).not.toMatch(/opencode-sync\.overrides\.jsonc/);
    expect(tracked).not.toMatch(/opencode-sync\.jsonc/);
  });
});

describe("status", () => {
  it("reports an unconfigured machine", () => {
    const a = makeMachine("a");
    useMachine(a);
    delete process.env.SYNC_REMOTE_URL;
    const result = status({ settings: { ...DEFAULT_SETTINGS }, roots: getRoots() });
    expect(result.configured).toBe(false);
  });

  it("reports pending incoming commits", async () => {
    const a = makeMachine("a");
    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), "{}\n");
    await push({ settings: settings(), roots: getRoots() });

    const b = makeMachine("b");
    useMachine(b);
    await pull({ settings: settings(), roots: getRoots() });

    useMachine(a);
    write(path.join(a.config, "opencode.jsonc"), '{ "next": true }\n');
    await push({ settings: settings(), roots: getRoots() });

    useMachine(b);
    const result = status({ settings: settings(), roots: getRoots() });
    expect(result.behind).toBeGreaterThan(0);
    expect(result.ahead).toBe(0);
  });
});
