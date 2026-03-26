#!/usr/bin/env node
// ─────────────────────────────────────────────────────
// ui.js — Shared UI utilities for OpenCode sync scripts
// Tokyo Night Aesthetic
// ─────────────────────────────────────────────────────
"use strict";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",

  // Basic colors (fallback)
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Tokyo Night palette (true color RGB)
  tn: {
    cyan: "\x1b[38;2;92;156;245m",   // rgb(92,156,245) — titles, accents, selected item, separator
    yellow: "\x1b[38;5;179m",       // #e0af68 — warnings
    red: "\x1b[38;5;204m",          // #f7768e — errors, force
    green: "\x1b[38;5;79m",         // #34d399 — success checkmarks
    purple: "\x1b[38;5;140m",       // #9d7cd8 — icons, decorative
    gray: "\x1b[38;5;60m",          // #565f89 — borders, dim text, unselected
    text: "\x1b[38;5;146m",         // #a9b1d6 — body text
    slate: "\x1b[38;5;103m",        // #94a3b8 — secondary text
  },

  // Semantic aliases
  muted: "\x1b[38;5;60m",
  success: "\x1b[38;5;79m",
  highlight: "\x1b[38;2;92;156;245m",
};

function paint(text, ...styles) {
  return `${styles.join("")}${text}${c.reset}`;
}

// ── Status output helpers ───────────────────────────

function printLine(symbol, msg, color = c.gray) {
  console.log(`  ${color}${symbol}${c.reset}  ${msg}`);
}

function title(msg) {
  console.log(`\n  ${c.bold}${msg}${c.reset}\n`);
}

function logo(action = "push", force = false) {
  const brandText = "OpenCode Sync";
  const brandStyled = c.bold + c.white + brandText + c.reset;
  const sep = c.tn.gray + " — " + c.reset;
  const icon = c.tn.purple + "⚡" + c.reset;
  const actionText = action === "push" ? "Push to GitHub" : "Pull from GitHub";
  const actionStyled = c.tn.cyan + actionText + c.reset;
  const forceTag = force ? "  " + c.tn.red + c.bold + "⚠ FORCE" + c.reset : "";

  console.log();
  console.log(`  ${brandStyled}${sep}${icon} ${actionStyled}${forceTag}`);
  console.log();
}

function success(msg) {
  console.log(`  ✅  ${msg}`);
}

function error(msg) {
  printLine("✖", msg, c.tn.red);
}

function warn(msg) {
  printLine("⚠", msg, c.tn.yellow);
}

function info(msg) {
  printLine("ℹ", msg, c.tn.cyan);
}

function step(msg) {
  printLine("▸", msg, c.tn.gray);
}

function note(msg) {
  console.log(`     ${c.tn.gray}${msg}${c.reset}`);
}

function section(label, value = "") {
  console.log(`\n  ${c.tn.cyan}${c.bold}${label}${c.reset} ${value}`);
}

function done(msg) {
  console.log();
  console.log(`  ✅  ${paint(msg, c.bold, c.tn.green)}`);
}

function separator() {
  console.log();
  console.log(`  ${c.tn.cyan}${c.bold}${"━".repeat(48)}${c.reset}`);
}

function completionBanner(action, target) {
  separator();
  const actionLabel = action === "push" ? "Push" : "Pull";
  const targetLabel = target === "config" ? "配置文件" : target === "sessions" ? "会话数据" : "配置和会话";
  console.log(`  \x1b[38;2;43;129;46m${c.bold}✨ 同步完成！${c.reset}  ${c.tn.slate}${targetLabel}已成功 ${actionLabel}${c.reset}`);
  console.log();
}

function upToDateBanner(action, target) {
  separator();
  const targetLabel = target === "config" ? "配置文件" : target === "sessions" ? "会话数据" : "配置和会话";
  console.log(`  \x1b[38;2;43;129;46m${c.bold}✨ 同步完成！${c.reset}  ${c.tn.slate}${targetLabel}已是最新${c.reset}`);
  console.log();
}

// ── Stats formatting ────────────────────────────────

function formatStats(added, modified, deleted, renamed) {
  const parts = [];

  if (added > 0) parts.push(`${c.tn.green}📄+${added}${c.reset}`);
  if (modified > 0) parts.push(`${c.tn.yellow}📝~${modified}${c.reset}`);
  if (deleted > 0) parts.push(`${c.tn.red}🗑️-${deleted}${c.reset}`);
  if (renamed > 0) parts.push(`${c.tn.cyan}🔄${renamed}${c.reset}`);

  if (parts.length === 0) {
    return `${c.tn.gray}已是最新${c.reset}`;
  }

  return parts.join(` ${c.tn.gray}│${c.reset} `);
}

function formatDiffStats(diffOutput) {
  let added = 0, modified = 0, deleted = 0, renamed = 0;
  const lines = (diffOutput || "").split("\n").filter(Boolean);
  
  for (const line of lines) {
    const status = line.charAt(0).toUpperCase();
    switch (status) {
      case "A": added++; break;
      case "M": modified++; break;
      case "D": deleted++; break;
      case "R": renamed++; break;
    }
  }

  return formatStats(added, modified, deleted, renamed);
}

module.exports = {
  c,
  paint,
  logo,
  title,
  success,
  error,
  warn,
  info,
  step,
  note,
  section,
  done,
  separator,
  completionBanner,
  upToDateBanner,
  formatStats,
  formatDiffStats,
};
