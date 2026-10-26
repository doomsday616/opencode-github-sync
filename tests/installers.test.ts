import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The installers are checked for syntax and argument handling only. `--dry-run`
 * prints the plan and exits before anything is installed; the real install
 * runs in the CI `installer` job on disposable runners.
 */

const root = path.resolve(__dirname, "..");
const installSh = path.join(root, "install.sh");
const installPs1 = path.join(root, "install.ps1");

function findSh(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"]
      : ["/bin/sh"];
  return candidates.find((c) => fs.existsSync(c));
}

function hasCommand(cmd: string): boolean {
  return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
}

const sh = findSh();
const pwsh = hasCommand("pwsh") ? "pwsh" : undefined;

describe("install.sh", () => {
  it.skipIf(!sh)("parses as POSIX sh", () => {
    expect(spawnSync(sh!, ["-n", installSh]).status).toBe(0);
  });

  it.skipIf(!hasCommand("dash"))("parses and plans under dash, the strictest common sh", () => {
    expect(spawnSync("dash", ["-n", installSh]).status).toBe(0);
    const out = execFileSync("dash", [installSh, "--dry-run", "--mode", "auto", "--repo", "o/r"], {
      encoding: "utf8",
    });
    expect(out).toContain("opencode-sync setup --mode auto --repo o/r");
  });

  it.skipIf(!hasCommand("shellcheck"))("passes shellcheck", () => {
    const result = spawnSync("shellcheck", ["-s", "sh", installSh], { encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
  });

  it("is plain ASCII with LF line endings", () => {
    const bytes = fs.readFileSync(installSh);
    expect(bytes.includes(13)).toBe(false);
    expect([...bytes].every((b) => b < 128)).toBe(true);
  });

  it.skipIf(!sh)("passes every option through to the CLI", () => {
    const out = execFileSync(
      sh!,
      [
        installSh,
        "--dry-run",
        "--mode",
        "auto",
        "--repo=o/r",
        "--interval",
        "15",
        "--lang",
        "zh-CN",
        "--proxy",
        "http://127.0.0.1:7890",
      ],
      { encoding: "utf8" },
    );
    expect(out.split("\n")).toEqual([
      "npm install -g opencode-github-sync@latest",
      "opencode-sync setup --mode auto --repo o/r --interval 15 --lang zh-CN --proxy http://127.0.0.1:7890",
      "proxy http://127.0.0.1:7890",
      "",
    ]);
  });

  it.skipIf(!sh)("opens the menu when no mode is given", () => {
    const out = execFileSync(sh!, [installSh, "--dry-run"], { encoding: "utf8" });
    expect(out).toBe("npm install -g opencode-github-sync@latest\nopencode-sync\n");
  });

  it.skipIf(!sh)("rejects invalid options", () => {
    for (const args of [
      ["--mode", "link"],
      ["--mode", "bogus"],
      ["--interval", "1"],
      ["--interval", "abc"],
      ["--lang", "fr"],
      ["--unknown"],
    ]) {
      const result = spawnSync(sh!, [installSh, "--dry-run", ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).toBe(2);
    }
  });
});

describe("install.ps1", () => {
  it("is plain ASCII", () => {
    const bytes = fs.readFileSync(installPs1);
    expect([...bytes].every((b) => b < 128)).toBe(true);
  });

  it.skipIf(!pwsh)("parses with the PowerShell parser", () => {
    const script = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${installPs1.replace(/'/g, "''")}',[ref]$null,[ref]$e); $e.Count`;
    const out = execFileSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0");
  });

  it.skipIf(!pwsh)("passes parameters through, quoting paths with spaces", () => {
    const out = execFileSync(
      pwsh!,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        installPs1,
        "-DryRun",
        "-Mode",
        "link",
        "-Repo",
        "C:\\my repos\\sync.git",
        "-Interval",
        "10",
        "-Lang",
        "en",
      ],
      { encoding: "utf8" },
    );
    expect(out.trim().split(/\r?\n/)).toEqual([
      "npm install -g opencode-github-sync@latest",
      'opencode-sync setup --mode link --repo "C:\\my repos\\sync.git" --interval 10 --lang en',
    ]);
  });

  it.skipIf(!pwsh)("works as a script block, the documented way to pass parameters", () => {
    const script = `$s=[IO.File]::ReadAllText('${installPs1.replace(/'/g, "''")}'); & ([scriptblock]::Create($s)) -Mode auto -Repo o/r -DryRun`;
    const out = execFileSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
    });
    expect(out).toContain("opencode-sync setup --mode auto --repo o/r");
  });

  it.skipIf(!pwsh)("refuses -Mode link without -Repo", () => {
    const result = spawnSync(
      pwsh!,
      ["-NoProfile", "-NonInteractive", "-File", installPs1, "-DryRun", "-Mode", "link"],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
  });
});
