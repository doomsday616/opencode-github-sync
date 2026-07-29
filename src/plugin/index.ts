import fs from "node:fs";
import { withSyncLock } from "../core/lock.js";
import { getRoots } from "../core/paths.js";
import { CollectingReporter } from "../core/reporter.js";
import { loadSettings, repoUrl, settingsPath } from "../core/settings.js";
import { pull, push, status } from "../core/sync.js";

/**
 * OpenCode plugin entry point.
 *
 * The plugin is a convenience layer, never the only way in. It runs inside the
 * OpenCode process, which means it cannot help when the configuration it just
 * synced is what stops OpenCode from starting. The CLI stays the rescue path,
 * and both call the exact same core.
 *
 * What the plugin adds:
 *   - a pull on startup, so a machine you have not touched in a week is current
 *   - an optional push when a session goes idle
 *   - an `opencode_sync` tool, so syncing can be asked for in plain language
 *
 * Everything is off unless the user configured a repository, and every failure
 * is reported as a toast instead of taking OpenCode down with it.
 */

type ToastVariant = "info" | "success" | "warning" | "error";

interface PluginContext {
  client?: any;
  directory?: string;
}

async function toast(client: any, message: string, variant: ToastVariant): Promise<void> {
  try {
    await client?.tui?.showToast?.({ body: { message, variant } });
  } catch {
    // The TUI is not attached (headless run) — nothing to show.
  }
}

async function log(client: any, level: string, message: string, extra?: unknown): Promise<void> {
  try {
    await client?.app?.log?.({
      body: { service: "opencode-github-sync", level, message, extra },
    });
  } catch {
    // Logging must never break a sync.
  }
}

function isConfigured(): boolean {
  const roots = getRoots();
  if (!fs.existsSync(settingsPath(roots.config))) return false;
  try {
    return Boolean(repoUrl(loadSettings(roots.config)));
  } catch {
    return false;
  }
}

async function runPull(client: any, announce: boolean): Promise<void> {
  const roots = getRoots();
  const reporter = new CollectingReporter();
  try {
    const result = await withSyncLock(roots.config, { waitMs: 30_000 }, () =>
      pull({ reporter, roots }),
    );
    await log(client, "info", `pull: ${result.message}`, { summary: result.summary });
    if (result.changed) {
      await toast(
        client,
        `Config updated from GitHub (${result.files.length} file(s)). Restart OpenCode to apply.`,
        "success",
      );
    } else if (announce) {
      await toast(client, "Config already up to date.", "info");
    }
  } catch (error) {
    const message = (error as Error).message;
    await log(client, "warn", `pull failed: ${message}`);
    if (announce) await toast(client, `Sync pull failed: ${message}`, "error");
  }
}

async function runPush(client: any, announce: boolean): Promise<void> {
  const roots = getRoots();
  const reporter = new CollectingReporter();
  try {
    const result = await withSyncLock(roots.config, { waitMs: 30_000 }, () =>
      push({ reporter, roots }),
    );
    await log(client, "info", `push: ${result.message}`);
    if (announce) {
      await toast(client, result.message, result.changed ? "success" : "info");
    }
  } catch (error) {
    const message = (error as Error).message;
    await log(client, "warn", `push failed: ${message}`);
    if (announce) await toast(client, `Sync push failed: ${message}`, "error");
  }
}

export const OpencodeGithubSync = async (ctx: PluginContext) => {
  const client = ctx?.client;
  const roots = getRoots();

  if (!isConfigured()) {
    await log(
      client,
      "info",
      "opencode-github-sync is installed but no repository is configured. Run `opencode-sync init`.",
    );
    return {};
  }

  const settings = loadSettings(roots.config);

  if (settings.autoPullOnStartup) {
    // Deliberately not awaited: OpenCode should finish starting even when the
    // network is slow or GitHub is unreachable.
    void runPull(client, false);
  }

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle" && settings.autoPushOnIdle) {
        void runPush(client, false);
      }
    },

    tool: {
      opencode_sync: {
        description:
          "Sync OpenCode configuration with the GitHub sync repository. " +
          "Use action 'push' to upload this machine's configuration, 'pull' to apply the shared " +
          "configuration, or 'status' to report what is out of sync.",
        args: {
          action: {
            type: "string",
            enum: ["push", "pull", "status"],
            description: "Which sync operation to run.",
          },
        },
        async execute(args: { action?: string }) {
          const action = args?.action ?? "status";
          const reporter = new CollectingReporter();

          if (action === "status") {
            const state = status({ roots });
            return JSON.stringify(state, null, 2);
          }

          const result = await withSyncLock(roots.config, { waitMs: 60_000 }, () =>
            action === "push" ? push({ reporter, roots }) : pull({ reporter, roots }),
          );

          const lines = [result.message];
          if (result.files.length > 0) {
            lines.push(
              `Files: ${result.files
                .slice(0, 20)
                .map((f) => `${f.kind[0]} ${f.path}`)
                .join(", ")}`,
            );
          }
          if (result.restartRequired && result.changed) {
            lines.push("Restart OpenCode for the new configuration to take effect.");
          }
          if (reporter.lines.length > 0) {
            lines.push(
              ...reporter.lines.filter((l) => l.level === "warn").map((l) => `! ${l.message}`),
            );
          }
          return lines.join("\n");
        },
      },
    },
  };
};

export default OpencodeGithubSync;
