import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "./env.js";

/**
 * Self-update through npm.
 *
 * Only ever invoked by an explicit menu choice, or by the scheduled job when
 * the user switched auto-update on. Never runs on its own otherwise.
 */

export const PACKAGE_NAME = "opencode-github-sync";

export function currentVersion(moduleDir: string): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(moduleDir, "..", "..", "package.json"), "utf8"),
    );
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Compare dotted numeric versions; pre-release suffixes sort before release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function npm(args: string[], timeout = 120_000): string {
  // npm is a batch file on Windows and Node refuses to spawn .cmd directly;
  // going through cmd.exe with fixed arguments avoids a shell-string build.
  const [command, prefix] =
    process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm"]]
      : ["npm", []];
  return execFileSync(command, [...prefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(),
    timeout,
    windowsHide: true,
  }).trim();
}

export function latestVersion(): string {
  return npm(["view", PACKAGE_NAME, "version"], 60_000);
}

export interface UpdateCheck {
  current: string;
  latest?: string;
  newer: boolean;
  error?: string;
}

export function checkForUpdate(moduleDir: string): UpdateCheck {
  const current = currentVersion(moduleDir);
  try {
    const latest = latestVersion();
    return { current, latest, newer: compareVersions(latest, current) > 0 };
  } catch (error) {
    return { current, newer: false, error: (error as Error).message.split("\n")[0] };
  }
}

export function installLatest(): void {
  npm(["install", "-g", `${PACKAGE_NAME}@latest`], 300_000);
}

export function uninstallGlobal(): void {
  npm(["uninstall", "-g", PACKAGE_NAME], 300_000);
}
