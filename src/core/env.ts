/**
 * Environment handed to child processes (git, gh, npm).
 *
 * A proxy configured in the local settings must reach every network-touching
 * child, but must never leak into the parent process or into OpenCode itself,
 * so it is kept here and merged in only when a child is spawned.
 */

let extra: Record<string, string> = {};

/** Environment variables that express a proxy to git, gh, curl and npm alike. */
export function proxyEnv(proxy: string | undefined): Record<string, string> {
  const value = (proxy ?? "").trim();
  if (!value) return {};
  return {
    HTTP_PROXY: value,
    HTTPS_PROXY: value,
    http_proxy: value,
    https_proxy: value,
    npm_config_proxy: value,
    npm_config_https_proxy: value,
  };
}

/** Set (or clear, with `undefined`) the proxy used by every child process. */
export function setChildProxy(proxy: string | undefined): void {
  extra = proxyEnv(proxy);
}

/** Additional variables currently applied to children. */
export function childEnvExtras(): Record<string, string> {
  return { ...extra };
}

/** `process.env` plus the child-only additions plus caller-specific overrides. */
export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, ...overrides };
}

/** Prepend directories to PATH (whatever its casing is on this platform). */
export function prependPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const current = String(env[key] ?? "");
  const present = new Set(
    current
      .split(sep)
      .filter(Boolean)
      .map((p) => (process.platform === "win32" ? p.toLowerCase() : p)),
  );
  const missing = dirs.filter(
    (d) => d && !present.has(process.platform === "win32" ? d.toLowerCase() : d),
  );
  if (missing.length === 0) return env;
  return { ...env, [key]: [...missing, current].filter(Boolean).join(sep) };
}
