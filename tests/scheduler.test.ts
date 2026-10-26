import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRON_MARKER,
  type InstallContext,
  type Runner,
  type ScheduleSpec,
  crontabLine,
  editCrontab,
  encodeVbs,
  installScheduler,
  launchdPlist,
  quoteWindowsArg,
  systemdService,
  systemdTimer,
  uninstallScheduler,
  windowsTaskXml,
  windowsVbs,
} from "../src/core/scheduler.js";

const windowsSpec: ScheduleSpec = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  cli: "C:\\Users\\王小明 Wang\\AppData\\Roaming\\npm\\node_modules\\opencode-github-sync\\dist\\cli\\index.js",
  intervalMinutes: 5,
  env: {},
  logDir: "C:\\Users\\王小明 Wang\\.config\\opencode\\logs",
};

const posixSpec: ScheduleSpec = {
  node: "/Users/李 雷/.nvm/versions/node/v22.11.0/bin/node",
  cli: "/Users/李 雷/.nvm/versions/node/v22.11.0/lib/node_modules/opencode-github-sync/dist/cli/index.js",
  intervalMinutes: 10,
  env: { PATH: "/Users/李 雷/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin" },
  logDir: "/Users/李 雷/.config/opencode/logs",
};

describe("Windows Task Scheduler", () => {
  it("renders the task XML with conhost --headless", () => {
    const xml = windowsTaskXml(windowsSpec, {
      userId: "DESKTOP-1\\王小明",
      logonType: "InteractiveToken",
      launcher: { kind: "conhost", conhost: "C:\\Windows\\System32\\conhost.exe" },
      startBoundary: "2026-10-26T08:00:00",
    });
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>");
    expect(xml).toContain("<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<StateChange>SessionUnlock</StateChange>");
    expect(xml).toContain("<StateChange>RemoteConnect</StateChange>");
    expect(xml).toContain("<Delay>PT30S</Delay>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("renders S4U with the wscript launcher", () => {
    const xml = windowsTaskXml(windowsSpec, {
      userId: "CORP\\user",
      logonType: "S4U",
      launcher: {
        kind: "wscript",
        wscript: "C:\\Windows\\System32\\wscript.exe",
        vbs: "C:\\Users\\王小明 Wang\\.config\\opencode\\opencode-sync-autosync.vbs",
      },
      startBoundary: "2026-10-26T08:00:00",
    });
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<LogonType>S4U</LogonType>");
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = windowsTaskXml(
      { ...windowsSpec, cli: "C:\\A&B <x>\\index.js" },
      {
        userId: "PC\\a&b",
        logonType: "InteractiveToken",
        launcher: { kind: "conhost", conhost: "C:\\Windows\\System32\\conhost.exe" },
        startBoundary: "2026-10-26T08:00:00",
      },
    );
    expect(xml).toContain("A&amp;B &lt;x&gt;");
    expect(xml).toContain("PC\\a&amp;b");
  });

  it("quotes Windows command-line arguments", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg("")).toBe('""');
  });

  it("writes the VBScript launcher as UTF-16LE with a BOM", () => {
    const text = windowsVbs({ ...windowsSpec, env: { SYNC_HOME: "C:\\Users\\王小明 Wang" } });
    expect(text).toMatchSnapshot();
    const bytes = encodeVbs(text);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(bytes.subarray(2).toString("utf16le")).toBe(text);
    expect(text).toContain("王小明 Wang");
    expect(text).toContain(", 0, True)");
  });
});

describe("macOS launchd", () => {
  it("renders the agent plist", () => {
    const plist = launchdPlist(posixSpec);
    expect(plist).toMatchSnapshot();
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<integer>600</integer>");
    expect(plist).toContain("<string>/Users/李 雷/.nvm/versions/node/v22.11.0/bin/node</string>");
  });
});

describe("Linux systemd and cron", () => {
  it("renders the user service and timer", () => {
    expect(systemdService(posixSpec)).toMatchSnapshot();
    const timer = systemdTimer(posixSpec);
    expect(timer).toMatchSnapshot();
    expect(timer).toContain("OnBootSec=1min");
    expect(timer).toContain("OnUnitActiveSec=10min");
    expect(timer).toContain("Persistent=true");
    expect(systemdService(posixSpec)).toContain('ExecStart="/Users/李 雷/');
  });

  it("renders a crontab line and edits only its own entry", () => {
    const line = crontabLine(posixSpec);
    expect(line).toMatchSnapshot();
    expect(line.startsWith("*/10 * * * * ")).toBe(true);
    const existing = "0 3 * * * /usr/bin/backup\n";
    const added = editCrontab(existing, line);
    expect(added).toBe(`0 3 * * * /usr/bin/backup\n${line}\n`);
    expect(editCrontab(added, line)).toBe(added);
    expect(editCrontab(added, undefined)).toBe(existing);
    expect(line).toContain(CRON_MARKER);
  });
});

/** A fake platform tool runner, so installation logic runs without registering anything. */
function fakeRunner(responses: Record<string, { ok: boolean; stdout?: string }>): Runner & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run(cmd, args, input) {
      const key = `${path.basename(cmd).toLowerCase()} ${args.join(" ")}`;
      calls.push(input ? `${key} <<${input.trim()}` : key);
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      const r = match?.[1] ?? { ok: true };
      return { ok: r.ok, stdout: r.stdout ?? "", stderr: r.ok ? "" : "failed" };
    },
  };
}

describe("installation wrappers (no real registration)", () => {
  const base = (platform: InstallContext["platform"], runner: Runner): InstallContext => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-sched-"));
    return {
      platform,
      spec: { ...posixSpec, logDir: path.join(home, "logs") },
      home,
      runner,
      configRoot: path.join(home, "config"),
      runWhenLoggedOff: false,
      elevated: false,
    };
  };

  it("falls back to cron when systemd --user is unavailable", () => {
    const runner = fakeRunner({
      "systemctl --user show-environment": { ok: false },
      "crontab -l": { ok: false },
    });
    const ctx = base("linux", runner);
    const result = installScheduler(ctx);
    expect(result).toMatchObject({ ok: true, kind: "cron" });
    expect(runner.calls.some((c) => c.startsWith("crontab - <<") && c.includes(CRON_MARKER))).toBe(
      true,
    );
    fs.rmSync(ctx.home, { recursive: true, force: true });
  });

  it("writes and enables the systemd timer when available", () => {
    const runner = fakeRunner({ "systemctl --user is-enabled": { ok: true, stdout: "enabled" } });
    const ctx = base("linux", runner);
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(ctx.home, ".config");
    try {
      const result = installScheduler(ctx);
      expect(result).toMatchObject({ ok: true, kind: "systemd" });
      const unitDir = path.join(ctx.home, ".config", "systemd", "user");
      expect(fs.existsSync(path.join(unitDir, "opencode-github-sync.timer"))).toBe(true);
      expect(runner.calls).toContain("systemctl --user enable --now opencode-github-sync.timer");
      expect(uninstallScheduler(ctx).removed).toBe(true);
      expect(fs.existsSync(path.join(unitDir, "opencode-github-sync.timer"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      fs.rmSync(ctx.home, { recursive: true, force: true });
    }
  });

  it("writes the plist and bootstraps it on macOS", () => {
    const runner = fakeRunner({});
    const ctx = base("darwin", runner);
    expect(installScheduler(ctx)).toMatchObject({ ok: true, kind: "launchd" });
    const plist = path.join(
      ctx.home,
      "Library",
      "LaunchAgents",
      "com.opencode-github-sync.autosync.plist",
    );
    expect(fs.existsSync(plist)).toBe(true);
    expect(runner.calls.some((c) => c.startsWith("launchctl bootstrap gui/"))).toBe(true);
    uninstallScheduler(ctx);
    expect(fs.existsSync(plist)).toBe(false);
    fs.rmSync(ctx.home, { recursive: true, force: true });
  });

  it("registers through schtasks and verifies the next run time on Windows", () => {
    const runner = fakeRunner({
      "whoami ": { ok: true, stdout: "pc\\user\r\n" },
      "powershell.exe": { ok: true, stdout: "2026-10-26T08:05:00\r\n" },
    });
    const ctx = base("win32", runner);
    ctx.runWhenLoggedOff = true;
    ctx.elevated = false;
    const result = installScheduler(ctx);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/not elevated/);
    expect(result.detail.join(" ")).toContain("logon InteractiveToken");
    expect(
      runner.calls.some((c) => c.startsWith("schtasks /Create /TN opencode-github-sync /XML")),
    ).toBe(true);
    fs.rmSync(ctx.home, { recursive: true, force: true });
  });

  it("fails the Windows install when no next run is scheduled", () => {
    const runner = fakeRunner({ "powershell.exe": { ok: true, stdout: "" } });
    const ctx = base("win32", runner);
    expect(installScheduler(ctx)).toMatchObject({ ok: false });
    fs.rmSync(ctx.home, { recursive: true, force: true });
  });
});
