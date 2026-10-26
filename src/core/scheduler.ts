import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Operating-system scheduler definitions.
 *
 * Every definition is produced by a pure function from a `ScheduleSpec`, so the
 * exact XML, plist and unit text can be snapshot-tested on any platform. The
 * installers below are thin wrappers that write those strings and call the
 * platform tool.
 *
 * Paths are resolved once, at install time, from the running Node binary and
 * this package's own location. They are never rebuilt from a user name: the
 * account name and the profile folder name differ on many machines.
 */

export const TASK_NAME = "opencode-github-sync";
export const LAUNCHD_LABEL = "com.opencode-github-sync.autosync";
export const SYSTEMD_UNIT = "opencode-github-sync";

export interface ScheduleSpec {
  /** Absolute path of the Node binary. */
  node: string;
  /** Absolute path of the CLI entry script. */
  cli: string;
  intervalMinutes: number;
  /** Extra environment for the job (root overrides used by tests and CI). */
  env?: Record<string, string>;
  /** Directory for scheduler-level stdout/stderr logs. */
  logDir: string;
}

export function runArgs(spec: ScheduleSpec): string[] {
  return [spec.cli, "autosync", "run"];
}

// ── Windows ─────────────────────────────────────────────────────────────────

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Quote one argument for the Windows command line (CommandLineToArgvW rules). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

export type WindowsLauncher =
  | { kind: "conhost"; conhost: string }
  | { kind: "wscript"; wscript: string; vbs: string };

export interface WindowsTaskOptions {
  /** `DOMAIN\user` or `MACHINE\user` of the account the task runs as. */
  userId: string;
  /** S4U runs while logged off; requires an elevated registration. */
  logonType: "InteractiveToken" | "S4U";
  launcher: WindowsLauncher;
  /** Start boundary for the time trigger, local ISO without offset is fine. */
  startBoundary: string;
}

/** The command and arguments the task's Exec action runs. */
export function windowsAction(
  spec: ScheduleSpec,
  launcher: WindowsLauncher,
): { command: string; args: string } {
  if (launcher.kind === "conhost") {
    return {
      command: launcher.conhost,
      args: ["--headless", spec.node, ...runArgs(spec)].map(quoteWindowsArg).join(" "),
    };
  }
  return { command: launcher.wscript, args: `//B //Nologo ${quoteWindowsArg(launcher.vbs)}` };
}

/**
 * Task Scheduler XML.
 *
 * - A time trigger repeating every N minutes carries the steady cadence. A
 *   logon trigger's repetition only starts counting after a real logon, so a
 *   task registered mid-session would otherwise never fire on schedule.
 * - Logon (+30 s), session unlock and remote connect (+15 s) cover returning
 *   to the machine.
 * - IgnoreNew, a 10-minute limit and no network gate: a roaming laptop is
 *   offline often, and the job handles an unreachable remote itself.
 */
export function windowsTaskXml(spec: ScheduleSpec, options: WindowsTaskOptions): string {
  const action = windowsAction(spec, options.launcher);
  const user = xmlEscape(options.userId);
  const interval = `PT${Math.max(2, Math.floor(spec.intervalMinutes))}M`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps OpenCode configuration in sync with its GitHub repository (opencode-github-sync).</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${xmlEscape(options.startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${interval}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT15S</Delay>
      <StateChange>SessionUnlock</StateChange>
    </SessionStateChangeTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT15S</Delay>
      <StateChange>RemoteConnect</StateChange>
    </SessionStateChangeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>${options.logonType}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(action.args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The VBScript fallback launcher, used where `conhost --headless` is not
 * available. `Run ..., 0, True` starts Node with no window and waits, so the
 * task's own run time and exit code are meaningful.
 */
export function windowsVbs(spec: ScheduleSpec): string {
  const vbQuote = (s: string) => `""${s.replace(/"/g, '""""')}""`;
  const command = [spec.node, ...runArgs(spec)].map(vbQuote).join(" ");
  const envLines = Object.entries(spec.env ?? {}).map(
    ([k, v]) => `env("${k.replace(/"/g, "")}") = "${v.replace(/"/g, '""')}"`,
  );
  return [
    "' Generated by opencode-github-sync. Starts the autosync job with no window.",
    "' Rewritten on every `opencode-sync autosync install`.",
    "Dim shell, env, code",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("PROCESS")',
    ...envLines,
    `code = shell.Run("${command}", 0, True)`,
    "WScript.Quit code",
    "",
  ].join("\r\n");
}

/** UTF-16LE with BOM: wscript reads anything else in the ANSI code page. */
export function encodeVbs(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** UTF-16LE with BOM, as schtasks expects for an XML that declares UTF-16. */
export function encodeTaskXml(text: string): Buffer {
  return encodeVbs(text);
}

// ── macOS ───────────────────────────────────────────────────────────────────

export function launchdPlist(spec: ScheduleSpec): string {
  const esc = xmlEscape;
  const args = [spec.node, ...runArgs(spec)].map((a) => `    <string>${esc(a)}</string>`);
  const envEntries = Object.entries(spec.env ?? {});
  const env =
    envEntries.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Math.max(2, Math.floor(spec.intervalMinutes)) * 60}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${esc(path.posix.join(toPosix(spec.logDir), "autosync-launchd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.posix.join(toPosix(spec.logDir), "autosync-launchd.log"))}</string>
</dict>
</plist>
`;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ── Linux ───────────────────────────────────────────────────────────────────

/** Quote one word for a systemd `ExecStart=` line. */
export function systemdQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function systemdService(spec: ScheduleSpec): string {
  const exec = [spec.node, ...runArgs(spec)].map(systemdQuote).join(" ");
  const env = Object.entries(spec.env ?? {}).map(
    ([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`,
  );
  return [
    "[Unit]",
    "Description=opencode-github-sync autosync",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${exec}`,
    ...env,
    "TimeoutStartSec=600",
    "",
  ].join("\n");
}

export function systemdTimer(spec: ScheduleSpec): string {
  const minutes = Math.max(2, Math.floor(spec.intervalMinutes));
  return [
    "[Unit]",
    "Description=Run opencode-github-sync autosync periodically",
    "",
    "[Timer]",
    "OnBootSec=1min",
    `OnUnitActiveSec=${minutes}min`,
    "Persistent=true",
    `Unit=${SYSTEMD_UNIT}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** Single-quote for POSIX sh. */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export const CRON_MARKER = "# opencode-github-sync autosync";

export function crontabLine(spec: ScheduleSpec): string {
  const minutes = Math.max(2, Math.floor(spec.intervalMinutes));
  const env = Object.entries(spec.env ?? {})
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(" ");
  const cmd = [spec.node, ...runArgs(spec)].map(shQuote).join(" ");
  const log = shQuote(path.posix.join(toPosix(spec.logDir), "autosync-cron.log"));
  return `*/${minutes} * * * * ${env ? `${env} ` : ""}${cmd} >> ${log} 2>&1 ${CRON_MARKER}`;
}

/** Replace (or remove, with `line` undefined) our entry in a crontab text. */
export function editCrontab(current: string, line: string | undefined): string {
  const kept = current.split("\n").filter((l) => l.trim() && !l.includes(CRON_MARKER));
  if (line) kept.push(line);
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

// ── Resolution of absolute paths ────────────────────────────────────────────

/** The Node binary to schedule: the one running this CLI, unless it is Bun or OpenCode. */
export function resolveNode(execPath = process.execPath): string {
  if (process.env.OPENCODE_SYNC_NODE) return process.env.OPENCODE_SYNC_NODE;
  const base = path.basename(execPath).toLowerCase();
  if (base === "node" || base === "node.exe") return execPath;
  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe")]
      : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  return candidates.find((c) => fs.existsSync(c)) ?? execPath;
}

/** The CLI entry script of this installation. */
export function resolveCli(moduleDir: string): string {
  return path.resolve(moduleDir, "..", "cli", "index.js");
}

// ── Installation (thin wrappers) ────────────────────────────────────────────

export type Platform = "win32" | "darwin" | "linux";

export interface Runner {
  run: (
    cmd: string,
    args: string[],
    input?: string,
  ) => { ok: boolean; stdout: string; stderr: string };
}

export const realRunner: Runner = {
  run(cmd, args, input) {
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input,
        windowsHide: true,
        timeout: 60_000,
      });
      return { ok: true, stdout: String(stdout), stderr: "" };
    } catch (e: any) {
      return {
        ok: false,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? ""),
      };
    }
  },
};

export interface InstallContext {
  platform: Platform;
  spec: ScheduleSpec;
  home: string;
  runner: Runner;
  /** Directory for generated launcher files (the config root). */
  configRoot: string;
  runWhenLoggedOff: boolean;
  elevated: boolean;
}

export interface InstallResult {
  ok: boolean;
  kind: "schtasks" | "launchd" | "systemd" | "cron";
  detail: string[];
  warnings: string[];
}

function windowsUser(runner: Runner): string {
  const who = runner.run("whoami", []);
  return who.ok && who.stdout.trim()
    ? who.stdout.trim()
    : `${os.hostname()}\\${os.userInfo().username}`;
}

function windowsLauncher(ctx: InstallContext): WindowsLauncher {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const conhost = path.join(systemRoot, "System32", "conhost.exe");
  // `--headless` exists from Windows 10 1809 (build 17763). It cannot carry
  // environment variables, so a job that needs any uses the VBScript launcher.
  const build = Number(os.release().split(".")[2] ?? 0);
  const needsEnv = Object.keys(ctx.spec.env ?? {}).length > 0;
  if (
    !needsEnv &&
    process.env.OPENCODE_SYNC_LAUNCHER !== "wscript" &&
    fs.existsSync(conhost) &&
    build >= 17763
  ) {
    return { kind: "conhost", conhost };
  }
  const vbs = path.join(ctx.configRoot, "opencode-sync-autosync.vbs");
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  fs.writeFileSync(vbs, encodeVbs(windowsVbs(ctx.spec)));
  return { kind: "wscript", wscript: path.join(systemRoot, "System32", "wscript.exe"), vbs };
}

function localIsoNow(): string {
  const d = new Date(Date.now() - 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

export function installScheduler(ctx: InstallContext): InstallResult {
  const warnings: string[] = [];
  fs.mkdirSync(ctx.spec.logDir, { recursive: true });

  if (ctx.platform === "win32") {
    let logonType: WindowsTaskOptions["logonType"] = "InteractiveToken";
    if (ctx.runWhenLoggedOff) {
      if (ctx.elevated) logonType = "S4U";
      else warnings.push("not elevated: registered to run only while you are signed in");
    }
    const launcher = windowsLauncher(ctx);
    const xml = windowsTaskXml(ctx.spec, {
      userId: windowsUser(ctx.runner),
      logonType,
      launcher,
      startBoundary: localIsoNow(),
    });
    const xmlFile = path.join(os.tmpdir(), `ogs-task-${process.pid}.xml`);
    fs.writeFileSync(xmlFile, encodeTaskXml(xml));
    try {
      const created = ctx.runner.run("schtasks", [
        "/Create",
        "/TN",
        TASK_NAME,
        "/XML",
        xmlFile,
        "/F",
      ]);
      if (!created.ok) {
        return { ok: false, kind: "schtasks", detail: [created.stderr.trim()], warnings };
      }
    } finally {
      fs.rmSync(xmlFile, { force: true });
    }
    const check = schedulerStatus(ctx);
    if (!check.installed) {
      return { ok: false, kind: "schtasks", detail: ["task missing after registration"], warnings };
    }
    if (!check.nextRun) {
      return { ok: false, kind: "schtasks", detail: ["task has no next run time"], warnings };
    }
    return {
      ok: true,
      kind: "schtasks",
      detail: [`launcher ${launcher.kind}`, `logon ${logonType}`, `next run ${check.nextRun}`],
      warnings,
    };
  }

  if (ctx.platform === "darwin") {
    const plistPath = path.join(ctx.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, launchdPlist(ctx.spec));
    const uid = String(process.getuid?.() ?? "");
    ctx.runner.run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    const boot = ctx.runner.run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    if (!boot.ok) {
      // A headless CI session has no GUI domain; the per-user domain still works.
      const alt = ctx.runner.run("launchctl", ["bootstrap", `user/${uid}`, plistPath]);
      if (!alt.ok) return { ok: false, kind: "launchd", detail: [boot.stderr.trim()], warnings };
      warnings.push("loaded into the user domain (no GUI session)");
    }
    return { ok: true, kind: "launchd", detail: [plistPath], warnings };
  }

  // Linux: systemd --user when it answers, otherwise cron.
  const probe = ctx.runner.run("systemctl", ["--user", "show-environment"]);
  if (probe.ok) {
    const dir = path.join(
      process.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"),
      "systemd",
      "user",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SYSTEMD_UNIT}.service`), systemdService(ctx.spec));
    fs.writeFileSync(path.join(dir, `${SYSTEMD_UNIT}.timer`), systemdTimer(ctx.spec));
    ctx.runner.run("systemctl", ["--user", "daemon-reload"]);
    const enabled = ctx.runner.run("systemctl", [
      "--user",
      "enable",
      "--now",
      `${SYSTEMD_UNIT}.timer`,
    ]);
    if (!enabled.ok)
      return { ok: false, kind: "systemd", detail: [enabled.stderr.trim()], warnings };
    warnings.push("headless host: run `loginctl enable-linger` so the timer runs while logged out");
    return { ok: true, kind: "systemd", detail: [dir], warnings };
  }

  const current = ctx.runner.run("crontab", ["-l"]);
  const next = editCrontab(current.ok ? current.stdout : "", crontabLine(ctx.spec));
  const written = ctx.runner.run("crontab", ["-"], next);
  if (!written.ok) return { ok: false, kind: "cron", detail: [written.stderr.trim()], warnings };
  return { ok: true, kind: "cron", detail: ["crontab entry added"], warnings };
}

export interface SchedulerStatus {
  installed: boolean;
  kind: InstallResult["kind"] | "none";
  nextRun?: string;
  detail?: string;
}

export function schedulerStatus(
  ctx: Pick<InstallContext, "platform" | "runner" | "home">,
): SchedulerStatus {
  if (ctx.platform === "win32") {
    const q = ctx.runner.run("schtasks", ["/Query", "/TN", TASK_NAME]);
    if (!q.ok) return { installed: false, kind: "none" };
    // schtasks' own output is localized; the cmdlet returns a real DateTime.
    const info = ctx.runner.run(windowsPowerShell(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$i = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}'; if ($i.NextRunTime) { $i.NextRunTime.ToString('s') }`,
    ]);
    const next = info.ok ? info.stdout.trim() : "";
    return { installed: true, kind: "schtasks", nextRun: next || undefined };
  }
  if (ctx.platform === "darwin") {
    const plistPath = path.join(ctx.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    if (!fs.existsSync(plistPath)) return { installed: false, kind: "none" };
    const listed = ctx.runner.run("launchctl", ["list", LAUNCHD_LABEL]);
    return { installed: true, kind: "launchd", detail: listed.ok ? "loaded" : "not loaded" };
  }
  const timer = ctx.runner.run("systemctl", ["--user", "is-enabled", `${SYSTEMD_UNIT}.timer`]);
  if (timer.ok && /enabled/.test(timer.stdout)) {
    return { installed: true, kind: "systemd" };
  }
  const cron = ctx.runner.run("crontab", ["-l"]);
  if (cron.ok && cron.stdout.includes(CRON_MARKER)) return { installed: true, kind: "cron" };
  return { installed: false, kind: "none" };
}

export function uninstallScheduler(ctx: InstallContext): { removed: boolean; detail: string[] } {
  const detail: string[] = [];
  let removed = false;
  if (ctx.platform === "win32") {
    const del = ctx.runner.run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    removed = del.ok;
    const vbs = path.join(ctx.configRoot, "opencode-sync-autosync.vbs");
    if (fs.existsSync(vbs)) fs.rmSync(vbs, { force: true });
    return { removed, detail };
  }
  if (ctx.platform === "darwin") {
    const uid = String(process.getuid?.() ?? "");
    ctx.runner.run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    ctx.runner.run("launchctl", ["bootout", `user/${uid}/${LAUNCHD_LABEL}`]);
    const plistPath = path.join(ctx.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    removed = fs.existsSync(plistPath);
    fs.rmSync(plistPath, { force: true });
    return { removed, detail };
  }
  const dir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"),
    "systemd",
    "user",
  );
  const timer = path.join(dir, `${SYSTEMD_UNIT}.timer`);
  if (fs.existsSync(timer)) {
    ctx.runner.run("systemctl", ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
    fs.rmSync(timer, { force: true });
    fs.rmSync(path.join(dir, `${SYSTEMD_UNIT}.service`), { force: true });
    ctx.runner.run("systemctl", ["--user", "daemon-reload"]);
    removed = true;
  }
  const cron = ctx.runner.run("crontab", ["-l"]);
  if (cron.ok && cron.stdout.includes(CRON_MARKER)) {
    ctx.runner.run("crontab", ["-"], editCrontab(cron.stdout, undefined));
    removed = true;
  }
  return { removed, detail };
}

/** True when this process runs with administrator rights (Windows only). */
export function isElevated(runner: Runner = realRunner): boolean {
  if (process.platform !== "win32") return process.getuid?.() === 0;
  return runner.run("net", ["session"]).ok;
}

export function windowsPowerShell(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
