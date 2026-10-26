import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { childEnv } from "./env.js";
import { ensureFile } from "./fsx.js";
import { type Roots, getRoots } from "./paths.js";
import type { Reporter } from "./reporter.js";
import {
  OVERRIDES_TEMPLATE,
  SETTINGS_TEMPLATE,
  type Settings,
  defaultSettings,
  loadSettings,
  overridesPath,
  saveSettings,
  settingsPath,
} from "./settings.js";

/**
 * First-run setup.
 *
 * The single biggest barrier to a sync tool is the setup: create a repository,
 * find its URL, put it somewhere the tool can read, authenticate. All of that
 * is automated through the GitHub CLI, which most OpenCode users already have
 * authenticated. Every step is idempotent, so re-running after a failure is
 * always safe.
 */

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

function gh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      env: childEnv(),
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
    };
  }
}

export function ghAvailable(): boolean {
  // Lets tests and CI run without touching whatever account `gh` is signed in to.
  if (process.env.OPENCODE_SYNC_NO_GH === "1") return false;
  return gh(["--version"]).ok;
}

export function assertGhReady(): void {
  if (!ghAvailable()) {
    throw new SetupError(
      "The GitHub CLI (`gh`) is required for automatic setup.\n" +
        "Install it from https://cli.github.com, or configure the repository by hand in opencode-sync.jsonc.",
    );
  }
  if (!gh(["auth", "status"]).ok) {
    throw new SetupError("You are not signed in to GitHub. Run: gh auth login");
  }
}

export function currentGitHubUser(): string {
  const result = gh(["api", "user", "--jq", ".login"]);
  if (!result.ok || !result.stdout) {
    throw new SetupError("Could not determine your GitHub username. Run: gh auth login");
  }
  return result.stdout;
}

export interface RepoTarget {
  owner: string;
  name: string;
}

/** Accept `name`, `owner/name`, or nothing (defaults applied by the caller). */
export function parseRepoTarget(input: string | undefined, defaultOwner: string): RepoTarget {
  const value = (input ?? "").trim();
  if (!value) return { owner: defaultOwner, name: "my-opencode-config" };
  if (value.includes("/")) {
    const [owner, name] = value.split("/", 2);
    if (!owner || !name) throw new SetupError(`Not a valid repository: ${value}`);
    return { owner, name };
  }
  return { owner: defaultOwner, name: value };
}

export function repoExists(target: RepoTarget): boolean {
  return gh(["repo", "view", `${target.owner}/${target.name}`, "--json", "name"]).ok;
}

export function repoIsPrivate(target: RepoTarget): boolean {
  const result = gh([
    "repo",
    "view",
    `${target.owner}/${target.name}`,
    "--json",
    "visibility",
    "--jq",
    ".visibility",
  ]);
  return result.ok && result.stdout.toUpperCase() === "PRIVATE";
}

export function createRepo(target: RepoTarget, reporter: Reporter): void {
  reporter.step(`Creating private repository ${target.owner}/${target.name}`);
  const result = gh([
    "repo",
    "create",
    `${target.owner}/${target.name}`,
    "--private",
    "--description",
    "OpenCode configuration synced by opencode-github-sync",
  ]);
  if (!result.ok) {
    throw new SetupError(`Could not create the repository: ${result.stderr || result.stdout}`);
  }
}

export interface SetupOptions {
  repo?: string;
  reporter: Reporter;
  roots?: Roots;
  /** Enable credential syncing. Only allowed for private repositories. */
  includeCredentials?: boolean;
  /** Enable selective session syncing. */
  includeSessions?: boolean;
}

export interface SetupResult {
  target: RepoTarget;
  created: boolean;
  settingsFile: string;
  overridesFile: string;
}

/** Create (or adopt) a repository and write the local settings files. */
export function initSync(options: SetupOptions): SetupResult {
  assertGhReady();
  const roots = options.roots ?? getRoots();
  const owner = currentGitHubUser();
  const target = parseRepoTarget(options.repo, owner);

  let created = false;
  if (!repoExists(target)) {
    createRepo(target, options.reporter);
    created = true;
  } else {
    options.reporter.info(`Using the existing repository ${target.owner}/${target.name}`);
  }

  return writeSetupFiles(target, options, roots, created);
}

/** Point this machine at an existing sync repository. */
export function linkSync(options: SetupOptions): SetupResult {
  assertGhReady();
  const roots = options.roots ?? getRoots();
  const owner = currentGitHubUser();
  const target = parseRepoTarget(options.repo, owner);

  if (!repoExists(target)) {
    throw new SetupError(
      `Repository ${target.owner}/${target.name} was not found, or your account cannot see it.`,
    );
  }
  return writeSetupFiles(target, options, roots, false);
}

function writeSetupFiles(
  target: RepoTarget,
  options: SetupOptions,
  roots: Roots,
  created: boolean,
): SetupResult {
  const isPrivate = repoIsPrivate(target);

  if (options.includeCredentials && !isPrivate) {
    throw new SetupError(
      "Credential syncing was requested but the repository is public.\n" +
        "Make it private first, or leave `includeCredentials` off.",
    );
  }
  if (options.includeSessions && !isPrivate) {
    throw new SetupError(
      "Session syncing was requested but the repository is public.\n" +
        "Conversations are private data; make the repository private first.",
    );
  }

  fs.mkdirSync(roots.config, { recursive: true });

  const existing = fs.existsSync(settingsPath(roots.config))
    ? loadSettings(roots.config)
    : defaultSettings();

  const settings: Settings = {
    ...existing,
    repo: {
      // owner/name replaces any URL from an earlier link; the URL would win.
      owner: target.owner,
      name: target.name,
      branch: existing.repo.branch || "main",
    },
    includeCredentials: options.includeCredentials ?? existing.includeCredentials,
    sessions: {
      ...existing.sessions,
      enabled: options.includeSessions ?? existing.sessions.enabled,
    },
  };

  if (fs.existsSync(settingsPath(roots.config))) {
    saveSettings(settings, roots.config);
  } else {
    // A first-time file keeps the annotated template so the user can see every
    // available option instead of a bare JSON dump.
    fs.writeFileSync(
      settingsPath(roots.config),
      SETTINGS_TEMPLATE.replace("YOUR_GITHUB_USERNAME", target.owner).replace(
        '"name": "my-opencode-config"',
        `"name": "${target.name}"`,
      ),
    );
    if (options.includeCredentials || options.includeSessions) saveSettings(settings, roots.config);
  }

  ensureFile(overridesPath(roots.config), OVERRIDES_TEMPLATE);

  return {
    target,
    created,
    settingsFile: settingsPath(roots.config),
    overridesFile: overridesPath(roots.config),
  };
}

/**
 * True when the input is a git URL or a local path rather than `owner/name`.
 * Such a repository is linked as given, without the GitHub CLI.
 */
export function isRepoUrl(input: string | undefined): boolean {
  const value = (input ?? "").trim();
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("..") ||
    value.endsWith(".git")
  );
}

/** Extract `owner/name` from a GitHub URL, if it is one. */
export function githubTargetFromUrl(url: string): RepoTarget | undefined {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * Link by URL. Visibility cannot be checked without the GitHub API, so
 * credential and session syncing are refused unless the URL is a GitHub
 * repository that `gh` confirms is private.
 */
export function linkByUrl(options: SetupOptions & { url: string }): SetupResult {
  const roots = options.roots ?? getRoots();
  const url = options.url.trim();
  const github = githubTargetFromUrl(url);
  const isPrivate = github && ghAvailable() ? repoIsPrivate(github) : false;
  if ((options.includeCredentials || options.includeSessions) && !isPrivate) {
    throw new SetupError(
      "Credential and session syncing need a repository confirmed to be private.\n" +
        "Link it as owner/name with the GitHub CLI signed in, or leave those options off.",
    );
  }
  fs.mkdirSync(roots.config, { recursive: true });
  const existing = fs.existsSync(settingsPath(roots.config))
    ? loadSettings(roots.config)
    : defaultSettings();
  const settings: Settings = {
    ...existing,
    repo: { url, branch: existing.repo.branch || "main" },
    includeCredentials: options.includeCredentials ?? existing.includeCredentials,
    sessions: {
      ...existing.sessions,
      enabled: options.includeSessions ?? existing.sessions.enabled,
    },
  };
  saveSettings(settings, roots.config);
  ensureFile(overridesPath(roots.config), OVERRIDES_TEMPLATE);
  return {
    target: github ?? { owner: "", name: url },
    created: false,
    settingsFile: settingsPath(roots.config),
    overridesFile: overridesPath(roots.config),
  };
}

/** Human-readable name of the configured repository. */
export function repoLabel(settings: Settings): string | undefined {
  if (settings.repo.owner && settings.repo.name)
    return `${settings.repo.owner}/${settings.repo.name}`;
  if (settings.repo.url) {
    const gh = githubTargetFromUrl(settings.repo.url);
    return gh ? `${gh.owner}/${gh.name}` : settings.repo.url.replace(/\/\/[^@/]+@/, "//");
  }
  return undefined;
}

/** Remove the repository from the local settings. No file is deleted. */
export function unlinkSync(roots: Roots = getRoots()): void {
  if (!fs.existsSync(settingsPath(roots.config))) return;
  const settings = loadSettings(roots.config);
  settings.repo = { branch: settings.repo.branch || "main" };
  settings.autosync.enabled = false;
  saveSettings(settings, roots.config);
}

/** Guess which of the user's repositories is a sync repository. */
export function discoverSyncRepos(): string[] {
  const result = gh([
    "repo",
    "list",
    "--limit",
    "200",
    "--json",
    "name,owner,visibility",
    "--jq",
    '.[] | select(.visibility == "PRIVATE") | "\\(.owner.login)/\\(.name)"',
  ]);
  if (!result.ok) return [];
  const candidates = result.stdout.split("\n").filter(Boolean);
  const preferred = /opencode|my-opencode-config|dotfiles|config/i;
  return candidates.filter((name) => preferred.test(name));
}
