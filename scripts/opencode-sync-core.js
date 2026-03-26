#!/usr/bin/env node
// opencode-sync-core — Unified sync entry point for OpenCode config & sessions.
// Cross-platform (macOS / Windows / Linux).
//
// Usage (called via opencode-launcher.js from wrapper scripts):
//   node opencode-sync-core.js pull              # Interactive: choose config/sessions/both
//   node opencode-sync-core.js push              # Interactive: choose config/sessions/both
//   node opencode-sync-core.js pull --force       # Force pull (discard local changes)
//   node opencode-sync-core.js push --force       # Force push on conflict
//   node opencode-sync-core.js status             # Show status for both
//
// Wrapper commands:
//   opencode-pull        → pull (interactive)
//   opencode-push        → push (interactive)
//   opencode-pull-force  → pull --force
//   opencode-push-force  → push --force

const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");

// ── UI imports ───────────────────────────────────────────────────────

const { c, logo, title, info, warn, error, success, done, step, note, section } = require("./ui");

// ── Paths ────────────────────────────────────────────────────────────

function getScriptsDir() {
  if (process.env.SYNC_CONFIG_ROOT) {
    return path.join(process.env.SYNC_CONFIG_ROOT, "scripts");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "opencode", "scripts");
}

const SCRIPTS_DIR = getScriptsDir();
const SYNC_CONFIG_SCRIPT = path.join(SCRIPTS_DIR, "sync-config.js");
const SYNC_SESSIONS_SCRIPT = path.join(SCRIPTS_DIR, "sync-sessions.js");

function ensureSelectDependency() {
  const pkgPath = path.join(SCRIPTS_DIR, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  const selectDir = path.join(SCRIPTS_DIR, "node_modules", "@inquirer", "select");
  if (fs.existsSync(selectDir)) return; // already installed

  console.log();
    info("正在安装依赖...");
  try {
    execSync("npm install", {
      cwd: SCRIPTS_DIR,
      stdio: "inherit",
      env: process.env,
    });
    // no output, silent transition
  } catch (error) {
    console.error(`${c.tn.red}❌ 安装 @inquirer/select 失败：${error.message}${c.reset}`);
    process.exit(1);
  }
}

// ── Interactive prompt ───────────────────────────────────────────────

async function chooseTarget(action, force) {
  ensureSelectDependency();
  logo(action, force);

  // @inquirer/select is ESM-only, use dynamic import
  const { default: select } = await import("@inquirer/select");

  // Tokyo Night theme colors
  const R = c.reset;
  const HI = `${c.tn.cyan}${c.bold}`;
  const DIM = `${c.tn.gray}`;

  // Strip ANSI escape codes from a string
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const menuItems = [
    { name: `○ 仅配置`, value: "config", label: "仅配置" },
    { name: `○ 仅会话`, value: "sessions", label: "仅会话" },
    { name: `○ 全部`, value: "both", label: "全部" },
    { name: `○ 退出`, value: "quit", label: "退出" },
  ];

  const target = await select({
    message: `${c.tn.cyan}?${R} 你想同步什么？`,
    choices: menuItems.map(item => ({ name: item.name, value: item.value })),
    theme: {
      prefix: "",
      icon: { cursor: " " },
      style: {
        highlight: (text) => {
          const plain = stripAnsi(text);
          // Replace ○ with ● for the currently focused item
          const selected = plain.replace(/^○/, "●");
          return `${HI}❯ ${selected}${R}`;
        },
      },
      helpMode: "never",
    },
  });

  if (target === "quit") {
    // Redraw menu with quit selected
    for (const item of menuItems) {
      if (item.value === "quit") {
        console.log(`  ${HI}❯ ● ${item.label}${R}`);
      } else {
        console.log(`    ${DIM}○ ${item.label}${R}`);
      }
    }
    console.log(`  ${c.tn.gray}已取消${c.reset}`);
    process.exit(0);
  }

  // Redraw the full menu with selection state
  for (const item of menuItems) {
    if (item.value === target) {
      console.log(`  ${HI}❯ ● ${item.label}${R}`);
    } else {
      console.log(`    ${DIM}○ ${item.label}${R}`);
    }
  }
  console.log();

  return target;
}

// ── Runner ───────────────────────────────────────────────────────────

function runScript(scriptPath, args, label) {
  if (!fs.existsSync(scriptPath)) {
    console.error(`${c.tn.red}❌ 脚本不存在：${scriptPath}${c.reset}`);
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    let stderr = "";
    let gotOutput = false;

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: SCRIPTS_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setInterval(() => {
      if (!gotOutput) {
        const glyph = spinnerFrames[frame % spinnerFrames.length];
        frame++;
        process.stdout.write(`\r  ${c.tn.gray}${glyph}${c.reset}  ${label}`);
      }
    }, 80);

    child.stdout.on("data", (chunk) => {
      if (!gotOutput) {
        // Clear spinner line before first real output
        process.stdout.write(`\r\x1b[2K`);
        gotOutput = true;
      }
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearInterval(timer);
      if (!gotOutput) {
        process.stdout.write(`\r\x1b[2K`);
      }

      if (code === 0) {
        resolve();
        return;
      }

      error(`${label}失败`);
      if (stderr.trim()) console.log(stderr.trim());
      reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

function runConfigSync(action, force, target) {
  const args = [action];
  if (force) args.push("--force");
  if (target) args.push(`--target=${target}`, `--action=${action}`);
  return runScript(SYNC_CONFIG_SCRIPT, args, action === "status" ? "正在检查配置状态..." : `正在 ${action === "push" ? "Push" : "Pull"} 配置...`);
}

function runSessionSync(action, force, target) {
  const args = [action];
  if (force) args.push("--force");
  if (target) args.push(`--target=${target}`, `--action=${action}`);
  return runScript(SYNC_SESSIONS_SCRIPT, args, action === "status" ? "正在检查会话状态..." : `正在 ${action === "push" ? "Push" : "Pull"} 会话...`);
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function dispatch(action, target, force) {
  // For "both", order matters:
  //   pull: config first (ensures scripts are valid), then sessions
  //   push: config first, then sessions
  // If any step fails (execSync throws on non-zero exit), we abort immediately.

  switch (target) {
    case "config":
      await runConfigSync(action, force, target);
      break;

    case "sessions":
      await runSessionSync(action, force, target);
      break;

    case "both":
      await runConfigSync(action, force, "config");
      console.log();
      await runSessionSync(action, force, "sessions");
      break;
  }
}

// ── Status ───────────────────────────────────────────────────────────

function showStatus() {
  title("📊 OpenCode Sync 状态");
  section("⚙️  配置");
  return runConfigSync("status", false).then(() => {
  section("💾 会话");
  return runSessionSync("status", false);
  }).then(() => {
    console.log();
  });
}

// ── Help ─────────────────────────────────────────────────────────────

function showHelp() {
  title("❓ OpenCode Sync 帮助");
  section("常用命令");
  console.log(`    ${c.tn.cyan}opencode-push${c.reset}          交互式 Push`);
  console.log(`    ${c.tn.cyan}opencode-pull${c.reset}          交互式 Pull`);
  console.log(`    ${c.tn.cyan}opencode-push-force${c.reset}    强制 Push（覆盖远端）`);
  console.log(`    ${c.tn.cyan}opencode-pull-force${c.reset}    强制 Pull（覆盖本地）`);
  console.log(`    ${c.tn.cyan}opencode-push status${c.reset}   查看同步状态`);
  console.log();
  section("说明");
  note("会话数据需要在 OpenCode 外部同步，脚本会自动处理进程检查");
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter((a) => !a.startsWith("-"));

  const action = positional[0];

  if (!action || action === "help") {
    showHelp();
    return;
  }

  if (action === "status") {
    await showStatus();
    return;
  }

  if (action !== "push" && action !== "pull") {
    console.error(`${c.tn.red}❌ Unknown action: ${action}${c.reset}`);
    showHelp();
    process.exit(1);
  }

  const target = await chooseTarget(action, force);
  await dispatch(action, target, force);
}

main().catch((e) => {
  if (e.name === "ExitPromptError") {
    // User pressed Ctrl+C during the select prompt
    console.log(`\n${c.tn.gray}已取消${c.reset}`);
    process.exit(0);
  }
  console.error(`${c.tn.red}发生意外错误：${e.message}${c.reset}`);
  process.exit(1);
});
