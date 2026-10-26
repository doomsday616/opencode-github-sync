import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { CATALOGS, detectLang, normalizeLang, t } from "../src/cli/i18n.js";
import { Ui } from "../src/cli/ui.js";
import { redactText, redactValue, tarGz } from "../src/core/bundle.js";
import { disabledCategories, disabledPathspecs, isDisabledPath } from "../src/core/categories.js";
import { gitBlobId } from "../src/core/compare.js";
import { proxyEnv } from "../src/core/env.js";
import { excludeFileContent } from "../src/core/guard.js";
import { appleScriptNotification, windowsToastScript } from "../src/core/notify.js";
import { defaultSettings, idlePushEnabled } from "../src/core/settings.js";
import { githubTargetFromUrl, isRepoUrl } from "../src/core/setup.js";
import { compareVersions } from "../src/core/update.js";

describe("i18n", () => {
  it("has identical keys in every catalogue", () => {
    const en = Object.keys(CATALOGS.en).sort();
    const zh = Object.keys(CATALOGS["zh-CN"]).sort();
    expect(zh).toEqual(en);
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(CATALOGS.en) as (keyof typeof CATALOGS.en)[]) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(CATALOGS["zh-CN"][key]), key).toEqual(names(CATALOGS.en[key]));
    }
  });

  it("has no empty strings", () => {
    for (const catalog of Object.values(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) expect(value.trim(), key).not.toBe("");
    }
  });

  it("detects the language in the documented order", () => {
    const intl = () => "fr-FR";
    expect(detectLang("zh-CN", "en", {}, intl)).toBe("zh-CN");
    expect(detectLang(undefined, "en", { OPENCODE_SYNC_LANG: "zh" }, intl)).toBe("zh-CN");
    expect(detectLang(undefined, "zh-CN", { LANG: "en_US.UTF-8" }, intl)).toBe("zh-CN");
    expect(detectLang(undefined, "", { LC_ALL: "zh_CN.UTF-8", LANG: "en_US" }, intl)).toBe("zh-CN");
    expect(detectLang(undefined, "", { LANG: "C" }, () => "zh-Hans-CN")).toBe("zh-CN");
    expect(detectLang(undefined, "", {}, intl)).toBe("en");
    expect(normalizeLang("POSIX")).toBeUndefined();
  });

  it("fills placeholders", () => {
    expect(t("autoOn", { n: 5 }, "en")).toBe("Autosync is on: every 5 min.");
    expect(t("autoOn", { n: 5 }, "zh-CN")).toBe("自动同步已开启：每 5 分钟一次。");
  });
});

describe("argument parsing", () => {
  it("defaults to the menu", () => {
    expect(parseArgs([]).command).toBe("menu");
    expect(parseArgs(["--help"]).command).toBe("help");
  });

  it("accepts both --key value and --key=value", () => {
    const args = parseArgs(["setup", "--mode", "auto", "--repo=o/r", "--interval", "10", "--yes"]);
    expect(args.command).toBe("setup");
    expect(args.values.get("mode")).toBe("auto");
    expect(args.values.get("repo")).toBe("o/r");
    expect(args.values.get("interval")).toBe("10");
    expect(args.flags.has("yes")).toBe(true);
  });

  it("keeps boolean flags boolean", () => {
    const args = parseArgs(["push", "--force", "--dry-run"]);
    expect(args.flags.has("force")).toBe(true);
    expect(args.flags.has("dry-run")).toBe(true);
    expect(args.positional).toEqual([]);
  });
});

describe("categories", () => {
  it("maps disabled categories to repository paths", () => {
    const s = defaultSettings();
    s.categories.instructions = false;
    s.categories.plugins = false;
    const disabled = disabledCategories(s.categories);
    expect(disabled).toEqual(["instructions", "plugins"]);
    expect(isDisabledPath("AGENTS.md", disabled)).toBe(true);
    expect(isDisabledPath("skills/x/SKILL.md", disabled)).toBe(false);
    expect(isDisabledPath("plugin/x.ts", disabled)).toBe(true);
    expect(isDisabledPath("opencode.jsonc", disabled)).toBe(false);
    expect(disabledPathspecs(disabled)).toContain(":(top,glob)*.md");
  });
});

describe("support bundle redaction", () => {
  it("removes tokens, passwords and credentials in URLs", () => {
    const text = [
      "remote https://user:hunter2@github.com/o/r.git",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      '"apiKey": "sk-1234567890abcdefghij"',
      "password=letmein",
      "Authorization: Bearer abc.def.ghi",
    ].join("\n");
    const out = redactText(text);
    for (const secret of ["hunter2", "ghp_abcdef", "sk-1234567890", "letmein", "abc.def.ghi"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("github.com/o/r.git");
  });

  it("blanks secret-looking keys in structured settings", () => {
    const value = redactValue({
      proxy: "http://u:p@proxy:8080",
      repo: { url: "x" },
      token: "abc",
    }) as any;
    expect(value.token).toBe("[REDACTED]");
    expect(value.proxy).not.toContain("u:p@");
  });

  it("writes a tar archive that tar can read", () => {
    const archive = tarGz([{ name: "a.txt", content: "hello" }]);
    const tar = gunzipSync(archive);
    expect(tar.subarray(0, 5).toString()).toBe("a.txt");
    expect(tar.subarray(512, 517).toString()).toBe("hello");
    expect(tar.length % 512).toBe(0);
  });
});

describe("helpers", () => {
  it("builds proxy variables for git, gh and npm", () => {
    expect(proxyEnv("")).toEqual({});
    const env = proxyEnv("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.npm_config_https_proxy).toBe("http://127.0.0.1:7890");
  });

  it("recognises URLs and local paths as repositories", () => {
    expect(isRepoUrl("https://github.com/o/r.git")).toBe(true);
    expect(isRepoUrl("git@github.com:o/r.git")).toBe(true);
    expect(isRepoUrl("C:\\repos\\sync.git")).toBe(true);
    expect(isRepoUrl("/srv/sync.git")).toBe(true);
    expect(isRepoUrl("o/r")).toBe(false);
    expect(githubTargetFromUrl("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
    expect(githubTargetFromUrl("/srv/sync.git")).toBeUndefined();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("3.10.0", "3.9.9")).toBe(1);
    expect(compareVersions("3.2.0", "3.2.0")).toBe(0);
    expect(compareVersions("3.2.0-beta.1", "3.2.0")).toBe(-1);
  });

  it("hashes files the way git does", () => {
    const content = Buffer.from("hello\r\nworld\n");
    const expected = execFileSync("git", ["hash-object", "--stdin"], {
      input: "hello\nworld\n",
      encoding: "utf8",
    }).trim();
    expect(gitBlobId(content)).toBe(expected);
  });

  it("keeps the plugin's idle push off while autosync owns the machine", () => {
    const s = defaultSettings();
    s.autoPushOnIdle = true;
    expect(idlePushEnabled(s)).toBe(true);
    s.autosync.enabled = true;
    expect(idlePushEnabled(s)).toBe(false);
  });

  it("writes generated-directory excludes", () => {
    expect(excludeFileContent(["node_modules", ".venv", "bad/*"])).toBe(
      "# Managed by opencode-github-sync: generated directories never synced.\nnode_modules/\n.venv/\n",
    );
  });

  it("escapes notification text for XML and AppleScript", () => {
    expect(windowsToastScript("a<b", "it's")).toContain("a&lt;b");
    expect(windowsToastScript("a", "it's")).toContain("it&apos;s");
    expect(appleScriptNotification('say "hi"', "line1\nline2")).toBe(
      'display notification "line1 · line2" with title "say \\"hi\\""',
    );
  });
});

describe("terminal prompts in line mode", () => {
  function ui(lines: string) {
    let out = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    return {
      ui: new Ui({ input: Readable.from([lines]), output, interactive: false }),
      out: () => out,
    };
  }

  it("selects by key and returns undefined at end of input", async () => {
    const { ui: u } = ui("x\n2\n");
    const choices = [
      { value: "a", label: "A", key: "1" },
      { value: "b", label: "B", key: "2" },
    ];
    expect(await u.select("pick", choices)).toBe("b");
    expect(await u.select("pick", choices)).toBeUndefined();
  });

  it("toggles checkboxes by number and saves on an empty line", async () => {
    const { ui: u } = ui("1 3\n\n");
    const result = await u.checkbox(
      "t",
      [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      new Set(["a", "b"]),
    );
    expect([...(result ?? [])].sort()).toEqual(["b", "c"]);
  });

  it("requires the exact confirmation word", async () => {
    const { ui: u } = ui("Overwrite\noverwrite\n");
    expect(await u.confirmWord("type", "overwrite")).toBe(false);
    expect(await u.confirmWord("type", "overwrite")).toBe(true);
  });
});
