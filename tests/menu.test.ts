import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SchedulerApi, UpdateApi } from "../src/cli/app.js";
import { type Lang, setLang } from "../src/cli/i18n.js";
import { runMenu, runSetup } from "../src/cli/menu.js";
import { setOutput } from "../src/cli/render.js";
import { Ui } from "../src/cli/ui.js";
import { git } from "../src/core/git.js";
import type { Roots } from "../src/core/paths.js";
import { CollectingReporter } from "../src/core/reporter.js";
import { defaultSettings, loadSettings, saveSettings } from "../src/core/settings.js";
import { push } from "../src/core/sync.js";

/**
 * The menu, driven end to end with an injected input stream. Line mode is what
 * runs whenever stdin is not a TTY, so every prompt is answerable from a pipe.
 */

let sandbox: string;
let remote: string;
let roots: Roots;
let output: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-menu-"));
  remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  roots = makeRoots("me");
  output = "";
  setOutput({
    write: (text: string) => {
      output += text;
      return true;
    },
  });
  process.env.OPENCODE_SYNC_NO_GH = "1";
});

afterEach(() => {
  setOutput(process.stdout);
  setLang("en");
  delete process.env.OPENCODE_SYNC_NO_GH;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function makeRoots(name: string): Roots {
  const base = path.join(sandbox, name);
  const r: Roots = {
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    agents: path.join(base, "agents", "skills"),
    cache: path.join(base, "cache"),
  };
  for (const dir of Object.values(r)) fs.mkdirSync(dir, { recursive: true });
  return r;
}

function fakeScheduler(): SchedulerApi & { installed: number; removed: number } {
  const api = {
    installed: 0,
    removed: 0,
    install: () => {
      api.installed++;
      return { ok: true, kind: "schtasks" as const, detail: [], warnings: [] };
    },
    uninstall: () => {
      api.removed++;
      return { removed: true };
    },
    status: () => ({ installed: api.installed > api.removed, kind: "schtasks" as const }),
    elevated: () => false,
  };
  return api;
}

const fakeUpdater = (): UpdateApi & { installs: number } => {
  const api = {
    installs: 0,
    check: () => ({ current: "3.2.0", latest: "3.3.0", newer: true }),
    install: () => {
      api.installs++;
    },
    uninstall: () => {},
  };
  return api;
};

async function drive(
  lines: string[],
  lang: Lang,
  extra: { scheduler?: SchedulerApi; updater?: UpdateApi } = {},
) {
  setLang(lang);
  let echo = "";
  const ui = new Ui({
    input: Readable.from([`${lines.join("\n")}\n`]),
    output: new Writable({
      write(chunk, _enc, cb) {
        echo += chunk.toString();
        cb();
      },
    }),
    interactive: false,
  });
  const scheduler = extra.scheduler ?? fakeScheduler();
  await runMenu({
    ui,
    roots,
    scheduler,
    updater: extra.updater ?? fakeUpdater(),
    openEditor: () => true,
    discover: () => [],
    cwd: sandbox,
    now: () => Date.UTC(2026, 9, 26, 8, 0, 0),
  });
  return `${output}\n${echo}`;
}

function linkSettings(): void {
  const s = defaultSettings();
  s.repo = { url: remote, branch: "main" };
  s.machineAlias = "me";
  saveSettings(s, roots.config);
}

describe("first run", () => {
  it("install-only exits without writing settings (English)", async () => {
    const text = await drive(["1"], "en");
    expect(text).toContain("This machine is not linked to a sync repository yet.");
    expect(text).toContain("Just install the command");
    expect(fs.existsSync(path.join(roots.config, "opencode-sync.jsonc"))).toBe(false);
  });

  it("links an empty repository, pushes, and turns on autosync (Chinese)", async () => {
    fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), '{ "model": "x" }\n');
    const scheduler = fakeScheduler();
    const text = await drive(["3", "2", remote, "q"], "zh-CN", { scheduler });
    expect(text).toContain("这台电脑还没有关联同步仓库。");
    expect(text).toContain("仓库是空的");
    expect(text).toContain("自动同步已开启");
    expect(scheduler.installed).toBe(1);
    const settings = loadSettings(roots.config);
    expect(settings.autosync.enabled).toBe(true);
    expect(git(["ls-remote", remote], { cwd: sandbox }).stdout).toContain("refs/heads/main");
  });

  it("shows the differences, then lets the repository win", async () => {
    const other = makeRoots("other");
    fs.writeFileSync(path.join(other.config, "opencode.jsonc"), '{ "model": "shared" }\n');
    const s = defaultSettings();
    s.repo = { url: remote, branch: "main" };
    await push({ settings: s, roots: other, reporter: new CollectingReporter() });

    fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), '{ "model": "mine" }\n');
    const text = await drive(["2", "2", remote, "3", "1", "q"], "en");
    expect(text).toContain("differ from the repository in 1 place");
    expect(text).toContain("different");
    expect(fs.readFileSync(path.join(roots.config, "opencode.jsonc"), "utf8")).toContain("shared");
    expect(text).toContain("Replaced files were saved to");
  });
});

describe("main menu", () => {
  it("shows the header and every item in both languages", async () => {
    linkSettings();
    const en = await drive(["q"], "en");
    for (const label of [
      "repository",
      "this machine",
      "autosync",
      "Sync now",
      "What to sync",
      "Autosync",
      "Update",
      "This machine's overrides",
      "Diagnostics",
      "Danger zone",
      "Uninstall",
      "Network proxy",
      "Restore a file from history",
      "Devices",
      "Large-change guard",
      "Language",
    ]) {
      expect(en).toContain(label);
    }
    output = "";
    const zh = await drive(["q"], "zh-CN");
    for (const label of [
      "立即同步",
      "同步哪些内容",
      "自动同步",
      "危险操作",
      "从历史版本恢复文件",
      "大改动保护",
    ]) {
      expect(zh).toContain(label);
    }
  });

  it("toggles categories with the checkbox and persists them", async () => {
    linkSettings();
    // 2 What to sync -> 1 categories -> toggle 2 (instructions) and 6 (skills) -> save
    await drive(["2", "1", "2 6", "", "b", "q"], "en");
    const s = loadSettings(roots.config);
    expect(s.categories.instructions).toBe(false);
    expect(s.includeSkills).toBe(false);
    expect(s.categories.config).toBe(true);
  });

  it("asks before syncing credentials when visibility cannot be checked", async () => {
    linkSettings();
    await drive(["2", "1", "7", "", "n", "b", "q"], "en");
    expect(loadSettings(roots.config).includeCredentials).toBe(false);
  });

  it("changes the interval, pauses and resumes autosync", async () => {
    linkSettings();
    const scheduler = fakeScheduler();
    await drive(["3", "1", "2", "2", "4", "2", "b", "q"], "en", { scheduler });
    let s = loadSettings(roots.config);
    expect(s.autosync.enabled).toBe(true);
    expect(s.autosync.intervalMinutes).toBe(10);
    expect(s.autosync.pausedUntil).toBe(Date.UTC(2026, 9, 26, 12, 0, 0));
    expect(scheduler.installed).toBe(2);

    await drive(["3", "4", "4", "1", "b", "q"], "en", { scheduler });
    s = loadSettings(roots.config);
    expect(s.autosync.pausedUntil).toBe(0);
    expect(s.autosync.enabled).toBe(false);
    expect(scheduler.removed).toBe(1);
  });

  it("rejects an interval below two minutes", async () => {
    linkSettings();
    await drive(["3", "2", "c", "1", "b", "q"], "en");
    expect(loadSettings(roots.config).autosync.intervalMinutes).toBe(5);
  });

  it("saves a proxy and refuses a malformed one", async () => {
    linkSettings();
    await drive(["p", "not a url", "q"], "en");
    expect(loadSettings(roots.config).proxy).toBe("");
    await drive(["p", "http://127.0.0.1:7890", "q"], "en");
    expect(loadSettings(roots.config).proxy).toBe("http://127.0.0.1:7890");
  });

  it("switches the language and persists it", async () => {
    linkSettings();
    const text = await drive(["l", "3", "q"], "en");
    expect(loadSettings(roots.config).language).toBe("zh-CN");
    expect(text).toContain("语言已保存。");
  });

  it("requires the confirmation word in the danger zone", async () => {
    linkSettings();
    fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), "{}\n");
    const text = await drive(["7", "2", "nope", "q"], "en");
    expect(text).toContain("Cancelled.");
    expect(git(["ls-remote", remote], { cwd: sandbox }).stdout).toBe("");
  });

  it("renames this machine from the device list", async () => {
    linkSettings();
    await drive(["d", "1", "Work Laptop", "q"], "en");
    expect(loadSettings(roots.config).machineAlias).toBe("Work-Laptop");
  });

  it("checks for updates and upgrades on request", async () => {
    linkSettings();
    const updater = fakeUpdater();
    const text = await drive(["4", "1", "2"], "en", { updater });
    expect(text).toContain("Installed 3.2.0 · latest 3.3.0");
    expect(updater.installs).toBe(1);
  });

  it("writes a redacted support bundle", async () => {
    linkSettings();
    const s = loadSettings(roots.config);
    s.proxy = "http://user:secret@proxy:8080";
    saveSettings(s, roots.config);
    await drive(["6", "1", "q"], "en");
    const bundle = fs.readdirSync(sandbox).find((f) => f.startsWith("opencode-sync-support-"));
    expect(bundle).toBeDefined();
    const tar = execFileSync("tar", ["-xzOf", path.join(sandbox, bundle!), "settings.json"], {
      encoding: "utf8",
    });
    expect(tar).not.toContain("secret");
  });

  it("uninstall removes the job and keeps configuration files", async () => {
    linkSettings();
    fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), "{}\n");
    const scheduler = fakeScheduler();
    await drive(["8", "y", "n"], "en", { scheduler });
    expect(scheduler.removed).toBe(1);
    expect(loadSettings(roots.config).repo.url).toBeUndefined();
    expect(fs.existsSync(path.join(roots.config, "opencode.jsonc"))).toBe(true);
  });
});

describe("non-interactive setup", () => {
  const ui = () =>
    new Ui({
      input: Readable.from([""]),
      output: new Writable({ write: (_c, _e, cb) => cb() }),
      interactive: false,
    });

  it("--mode auto links, pushes and enables autosync", async () => {
    fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), "{}\n");
    const scheduler = fakeScheduler();
    await runSetup(
      { mode: "auto", repo: remote, interval: 15, lang: "zh-CN", proxy: "http://127.0.0.1:1" },
      { ui: ui(), roots, scheduler },
    );
    const s = loadSettings(roots.config);
    expect(s.autosync.enabled).toBe(true);
    expect(s.autosync.intervalMinutes).toBe(15);
    expect(s.language).toBe("zh-CN");
    expect(s.proxy).toBe("http://127.0.0.1:1");
    expect(scheduler.installed).toBe(1);
  });

  it("--mode link without --repo fails clearly", async () => {
    await expect(runSetup({ mode: "link" }, { ui: ui(), roots })).rejects.toThrow(/--repo/);
  });
});
