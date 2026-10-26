import fs from "node:fs";
import { withSyncLock } from "../core/lock.js";
import { getRoots } from "../core/paths.js";
import { CollectingReporter } from "../core/reporter.js";
import { idlePushEnabled, loadSettings, repoUrl, settingsPath } from "../core/settings.js";
import { pull, push, status } from "../core/sync.js";

/**
 * OpenCode plugin entry point (dual V1 + V2).
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
 * is reported as a toast (V1) or a console line (V2) instead of taking
 * OpenCode down with it.
 *
 * V1 (OpenCode 1.x) calls the default export as a function and consumes the
 * returned `{ event, tool }` hook map. V2 (OpenCode 2.x) decodes the default
 * export for an `{ id, setup }` definition and calls `setup(ctx)`, which
 * registers the same capabilities through `ctx.tool.transform` and
 * `ctx.event.subscribe`. One default export carries both halves; the two
 * implementations are independent and share only the core helpers below.
 */

type ToastVariant = "info" | "success" | "warning" | "error";

interface PluginContext {
  client?: any;
  directory?: string;
}

/** Minimal structural slice of the V2 plugin context this file touches. */
interface V2ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (input: any) => Promise<{ content: string }>;
  }): void;
}

interface V2Context {
  tool: {
    transform: (callback: (editor: V2ToolEditor) => void) => Promise<unknown>;
  };
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<{ type: string }>;
  };
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

/** V2 equivalent of log/toast: the promise context has no app.log or TUI client. */
function notice(level: "info" | "warn", message: string, extra?: unknown): void {
  if (level === "warn") {
    if (extra !== undefined) console.warn(`[opencode-github-sync] ${message}`, extra);
    else console.warn(`[opencode-github-sync] ${message}`);
  } else {
    if (extra !== undefined) console.log(`[opencode-github-sync] ${message}`, extra);
    else console.log(`[opencode-github-sync] ${message}`);
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

async function runPullV2(announce: boolean): Promise<void> {
  const roots = getRoots();
  const reporter = new CollectingReporter();
  try {
    const result = await withSyncLock(roots.config, { waitMs: 30_000 }, () =>
      pull({ reporter, roots }),
    );
    notice("info", `pull: ${result.message}`, { summary: result.summary });
    if (result.changed) {
      notice(
        "info",
        `Config updated from GitHub (${result.files.length} file(s)). Restart OpenCode to apply.`,
      );
    } else if (announce) {
      notice("info", "Config already up to date.");
    }
  } catch (error) {
    const message = (error as Error).message;
    notice("warn", `pull failed: ${message}`);
    if (announce) notice("warn", `Sync pull failed: ${message}`);
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

async function runPushV2(announce: boolean): Promise<void> {
  const roots = getRoots();
  const reporter = new CollectingReporter();
  try {
    const result = await withSyncLock(roots.config, { waitMs: 30_000 }, () =>
      push({ reporter, roots }),
    );
    notice("info", `push: ${result.message}`);
    if (announce) notice("info", result.message);
  } catch (error) {
    const message = (error as Error).message;
    notice("warn", `push failed: ${message}`);
    if (announce) notice("warn", `Sync push failed: ${message}`);
  }
}

const SYNC_TOOL_DESCRIPTION =
  "Sync OpenCode configuration with the GitHub sync repository. " +
  "Use action 'push' to upload this machine's configuration, 'pull' to apply the shared " +
  "configuration, or 'status' to report what is out of sync.";

const SYNC_TOOL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["push", "pull", "status"],
      description: "Which sync operation to run.",
    },
  },
  additionalProperties: false,
} as const;

async function executeSyncAction(args: { action?: string }): Promise<string> {
  const roots = getRoots();
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
    lines.push(...reporter.lines.filter((l) => l.level === "warn").map((l) => `! ${l.message}`));
  }
  return lines.join("\n");
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
  const idlePush = idlePushEnabled(settings);

  if (settings.autoPullOnStartup) {
    // Deliberately not awaited: OpenCode should finish starting even when the
    // network is slow or GitHub is unreachable.
    void runPull(client, false);
  }

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle" && idlePush) {
        void runPush(client, false);
      }
    },

    tool: {
      opencode_sync: {
        description: SYNC_TOOL_DESCRIPTION,
        args: {
          action: {
            type: "string",
            enum: ["push", "pull", "status"],
            description: "Which sync operation to run.",
          },
        },
        async execute(args: { action?: string }) {
          return executeSyncAction(args);
        },
      },
    },
  };
};

async function setup(ctx: V2Context): Promise<() => void> {
  const controller = new AbortController();
  const roots = getRoots();

  if (!isConfigured()) {
    notice(
      "info",
      "opencode-github-sync is installed but no repository is configured. Run `opencode-sync init`.",
    );
    return () => controller.abort();
  }

  const settings = loadSettings(roots.config);

  if (settings.autoPullOnStartup) {
    // Deliberately not awaited: OpenCode should finish starting even when the
    // network is slow or GitHub is unreachable.
    void runPullV2(false);
  }

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "opencode_sync",
      description: SYNC_TOOL_DESCRIPTION,
      input: SYNC_TOOL_INPUT,
      async execute(input) {
        return { content: await executeSyncAction(input as { action?: string }) };
      },
    });
  });

  if (idlePushEnabled(settings)) {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.idle") {
            void runPushV2(false);
          }
        }
      } catch {
        // Aborted on unload — nothing to report.
      }
    })();
  }

  return () => controller.abort();
}

const V2Plugin = {
  id: "opencode-github-sync",
  setup,
};

export default {
  ...V2Plugin,
  server: OpencodeGithubSync,
};
