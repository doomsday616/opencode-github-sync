import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRoots } from "../src/core/paths.js";
import { DEFAULT_SETTINGS, type Settings, saveSettings } from "../src/core/settings.js";
import { prunePluginCache } from "../src/core/stage.js";
import plugin, { OpencodeGithubSync } from "../src/plugin/index.js";

/**
 * Plugin entrypoint coverage (V1 + V2 halves).
 *
 * The core sync logic already has end-to-end coverage in sync.test.ts; these
 * tests pin the plugin wiring: the dual default export shape both OpenCode
 * loaders accept, tool registration through the V2 transform API, the idle
 * subscription, and cache pruning for both config keys.
 */

let sandbox: string;
let remote: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "SYNC_CONFIG_ROOT",
  "SYNC_DATA_ROOT",
  "SYNC_STATE_ROOT",
  "SYNC_AGENTS_ROOT",
  "SYNC_CACHE_ROOT",
  "SYNC_REMOTE_URL",
  "SYNC_HOME",
  "OPENCODE_SYNC_HOST_ALIAS",
];

interface Machine {
  config: string;
  data: string;
  state: string;
  agents: string;
  cache: string;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-plugin-"));
  remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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
}

function writeSettings(
  configDir: string,
  patch: Partial<Settings> = {},
  repoUrl: string = remote,
): void {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...patch,
    repo: { ...DEFAULT_SETTINGS.repo, url: repoUrl, ...(patch.repo ?? {}) },
    sessions: { ...DEFAULT_SETTINGS.sessions, ...(patch.sessions ?? {}) },
  };
  saveSettings(settings, configDir);
}

function writeConfig(configDir: string, value: unknown): void {
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), `${JSON.stringify(value, null, 2)}\n`);
}

interface FakeCtx {
  ctx: any;
  tools: any[];
  subscribed: () => boolean;
}

function makeFakeCtx(events: { type: string }[] = []): FakeCtx {
  const tools: any[] = [];
  let subscribed = false;
  const ctx = {
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => tools.push(tool) });
      },
    },
    event: {
      subscribe: (_options?: { signal?: AbortSignal }) => {
        subscribed = true;
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
  return { ctx, tools, subscribed: () => subscribed };
}

function remoteHead(): string | undefined {
  try {
    const out = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

async function waitForRemoteHead(timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const head = remoteHead();
    if (head) return head;
    if (Date.now() > deadline) throw new Error("timed out waiting for the idle push to land");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("dual entrypoint shape", () => {
  it("exposes one default export both loaders accept", () => {
    expect(plugin.id).toBe("opencode-github-sync");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("keeps the V1 server function as a named export", () => {
    expect(typeof OpencodeGithubSync).toBe("function");
    expect(plugin.server).toBe(OpencodeGithubSync);
  });
});

describe("V1 server half", () => {
  it("returns no hooks when no repository is configured", async () => {
    const machine = makeMachine("v1-empty");
    useMachine(machine);
    await expect(OpencodeGithubSync({})).resolves.toEqual({});
  });

  it("returns event and tool hooks when configured", async () => {
    const machine = makeMachine("v1");
    useMachine(machine);
    writeConfig(machine.config, {});
    writeSettings(machine.config, { autoPullOnStartup: false });

    const hooks = await OpencodeGithubSync({});
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.tool?.opencode_sync?.execute).toBe("function");

    const output = await hooks.tool!.opencode_sync.execute({ action: "status" });
    expect(JSON.parse(output).configured).toBe(true);
  });
});

describe("V2 setup half", () => {
  it("registers the opencode_sync tool through the transform API", async () => {
    const machine = makeMachine("v2");
    useMachine(machine);
    writeConfig(machine.config, {});
    writeSettings(machine.config, { autoPullOnStartup: false });

    const fake = makeFakeCtx();
    const cleanup = await plugin.setup(fake.ctx);
    expect(typeof cleanup).toBe("function");

    expect(fake.tools).toHaveLength(1);
    expect(fake.tools[0].name).toBe("opencode_sync");
    const output = await fake.tools[0].execute({ action: "status" });
    expect(JSON.parse(output.content).configured).toBe(true);
    expect(fake.subscribed()).toBe(false);
    await cleanup!();
  });

  it("registers nothing when no repository is configured", async () => {
    const machine = makeMachine("v2-empty");
    useMachine(machine);
    const fake = makeFakeCtx();
    const cleanup = await plugin.setup(fake.ctx);
    expect(fake.tools).toHaveLength(0);
    await cleanup!();
  });

  it("pushes when a session goes idle and autoPushOnIdle is on", async () => {
    const machine = makeMachine("v2-idle");
    useMachine(machine);
    writeConfig(machine.config, { model: "shared" });
    writeSettings(machine.config, { autoPullOnStartup: false, autoPushOnIdle: true });

    const fake = makeFakeCtx([{ type: "session.idle" }]);
    const cleanup = await plugin.setup(fake.ctx);
    expect(fake.subscribed()).toBe(true);

    await waitForRemoteHead();
    await cleanup!();
    expect(remoteHead()).toBeDefined();
  });

  it("leaves the event stream alone when autoPushOnIdle is off", async () => {
    const machine = makeMachine("v2-quiet");
    useMachine(machine);
    writeConfig(machine.config, {});
    writeSettings(machine.config, { autoPullOnStartup: false, autoPushOnIdle: false });

    const fake = makeFakeCtx([{ type: "session.idle" }]);
    const cleanup = await plugin.setup(fake.ctx);
    expect(fake.subscribed()).toBe(false);
    await cleanup!();
    expect(remoteHead()).toBeUndefined();
  });
});

describe("prunePluginCache plugin keys", () => {
  function makeCache(machine: Machine, dependencies: Record<string, string>): void {
    fs.writeFileSync(
      path.join(machine.cache, "package.json"),
      `${JSON.stringify({ dependencies }, null, 2)}\n`,
    );
    for (const name of Object.keys(dependencies)) {
      fs.mkdirSync(path.join(machine.cache, "node_modules", name), { recursive: true });
    }
  }

  function cacheDeps(machine: Machine): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(machine.cache, "package.json"), "utf8"))
      .dependencies;
  }

  it("reads the V2 plugins key with string specs", () => {
    const machine = makeMachine("prune-v2");
    writeConfig(machine.config, { plugins: ["opencode-github-sync", "other@1.0.0"] });
    makeCache(machine, { "opencode-github-sync": "1.0.0", "stale-pkg": "2.0.0" });

    expect(prunePluginCache(machine.config, machine.cache)).toBe(1);
    expect(cacheDeps(machine)).toEqual({ "opencode-github-sync": "1.0.0" });
    expect(fs.existsSync(path.join(machine.cache, "node_modules", "stale-pkg"))).toBe(false);
    expect(fs.existsSync(path.join(machine.cache, "node_modules", "opencode-github-sync"))).toBe(
      true,
    );
  });

  it("reads the V2 plugins key with object specs", () => {
    const machine = makeMachine("prune-v2-obj");
    writeConfig(machine.config, {
      plugins: [{ package: "opencode-github-sync", options: {} }],
    });
    makeCache(machine, { "opencode-github-sync": "1.0.0", "stale-pkg": "2.0.0" });

    expect(prunePluginCache(machine.config, machine.cache)).toBe(1);
    expect(cacheDeps(machine)).toEqual({ "opencode-github-sync": "1.0.0" });
  });

  it("keeps reading the legacy plugin key", () => {
    const machine = makeMachine("prune-v1");
    writeConfig(machine.config, { plugin: ["opencode-github-sync"] });
    makeCache(machine, { "opencode-github-sync": "1.0.0", "stale-pkg": "2.0.0" });

    expect(prunePluginCache(machine.config, machine.cache)).toBe(1);
    expect(cacheDeps(machine)).toEqual({ "opencode-github-sync": "1.0.0" });
  });

  it("uses the real roots by default", () => {
    expect(getRoots().config.length).toBeGreaterThan(0);
  });
});
