#!/usr/bin/env node
/**
 * Render docs/menu.svg and docs/menu.zh-CN.svg from the real menu.
 *
 * The menu runs in-process from the compiled CLI against a throwaway sandbox
 * (temp roots, a local bare repository, a fake scheduler), so the screenshot
 * text is whatever the code actually prints. Re-run after changing menu
 * strings:  npm run build && node scripts/render-menu-svg.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = (p) => pathToFileURL(path.join(root, "dist", p)).href;

process.env.NO_COLOR = "1";
process.env.OPENCODE_SYNC_NO_GH = "1";
process.env.OPENCODE_SYNC_HOST_ALIAS = "work-laptop";

const { runMenu } = await import(dist("cli/menu.js"));
const { setOutput } = await import(dist("cli/render.js"));
const { setLang } = await import(dist("cli/i18n.js"));
const { Ui } = await import(dist("cli/ui.js"));
const { defaultSettings, saveSettings } = await import(dist("core/settings.js"));
const { writeState } = await import(dist("core/autosync.js"));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-svg-"));
const remote = path.join(sandbox, "remote.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
const roots = Object.fromEntries(
  ["config", "data", "state", "agents", "cache"].map((k) => [k, path.join(sandbox, k)]),
);
for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });

const settings = defaultSettings();
// The URL is what syncs; owner/name is what the header shows.
settings.repo = { url: remote, owner: "you", name: "my-opencode-config", branch: "main" };
settings.autosync.enabled = true;
settings.autosync.intervalMinutes = 5;
saveSettings(settings, roots.config);
const now = Date.UTC(2026, 9, 26, 9, 30, 0);
writeState(roots, { lastRunAt: now - 2 * 60_000, lastSuccessAt: now - 2 * 60_000 });

// One real sync, dated two minutes before `now`, so "last sync" is genuine.
fs.writeFileSync(path.join(roots.config, "opencode.jsonc"), "{}\n");
const stamp = new Date(now - 2 * 60_000).toISOString();
process.env.GIT_AUTHOR_DATE = stamp;
process.env.GIT_COMMITTER_DATE = stamp;
const { push } = await import(dist("core/sync.js"));
await push({ roots });
delete process.env.GIT_AUTHOR_DATE;
delete process.env.GIT_COMMITTER_DATE;

const scheduler = {
  install: () => ({ ok: true, kind: "schtasks", detail: [], warnings: [] }),
  uninstall: () => ({ removed: true }),
  status: () => ({ installed: true, kind: "schtasks" }),
  elevated: () => false,
};

async function capture(lang) {
  setLang(lang);
  let text = "";
  setOutput({
    write: (s) => {
      text += s;
      return true;
    },
  });
  const ui = new Ui({
    input: Readable.from(["q\n"]),
    output: new Writable({
      write(chunk, _e, cb) {
        text += chunk.toString();
        cb();
      },
    }),
    interactive: false,
  });
  await runMenu({ ui, roots, scheduler, now: () => now, discover: () => [], cwd: sandbox });
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n")
    .trim()
    .split("\n")
    .filter((l) => !/›\s*q$/.test(l));
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svg(lines, lang) {
  const lineHeight = 22;
  const top = 76;
  const height = top + lines.length * lineHeight + 40;
  const width = 900;
  const body = lines
    .map((line, i) => {
      const y = top + i * lineHeight;
      let cls = "text";
      if (/^opencode-sync/.test(line.trim())) {
        return `    <text x="28" y="${y}"><tspan class="brand">opencode</tspan><tspan class="accent">-sync</tspan></text>`;
      }
      // Columns are placed at fixed x positions rather than padded with
      // spaces: CJK glyphs are not exactly two monospace cells wide in every
      // font, so space padding drifts.
      const tag = /^(\s*)\[(\w)\](\s+)(.*)$/.exec(line);
      if (tag) {
        const [, , key, , label] = tag;
        return `    <text y="${y}"><tspan x="44" class="cyan">[${key}]</tspan><tspan x="84" class="text">${esc(label)}</tspan></text>`;
      }
      const kv = /^(\s*)(\S.*?)(\s{2,})(.*)$/.exec(line);
      if (kv) {
        const [, , key, , value] = kv;
        const valueClass = /autosync|自动同步/.test(key) ? "green" : "text";
        return `    <text y="${y}"><tspan x="44" class="muted">${esc(key)}</tspan><tspan x="172" class="${valueClass}">${esc(value)}</tspan></text>`;
      }
      if (/›/.test(line)) cls = "brand";
      return `    <text x="28" y="${y}" class="${cls}">${esc(line.trim())}</text>`;
    })
    .join("\n");
  const font =
    lang === "zh-CN"
      ? `ui-monospace, SFMono-Regular, Menlo, Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace`
      : `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="opencode-sync menu">
  <!-- Generated by scripts/render-menu-svg.mjs from the real menu. Do not edit by hand. -->
  <defs>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#222634"/>
      <stop offset="100%" stop-color="#1b1f2b"/>
    </linearGradient>
    <style>
      text { font-family: ${font}; font-size: 14px; }
      .brand { fill: #7aa2f7; font-weight: 700; }
      .accent{ fill: #bb9af7; font-weight: 700; }
      .muted { fill: #6c779e; }
      .faint { fill: #464f73; }
      .text  { fill: #c0caf5; }
      .green { fill: #9ece6a; }
      .cyan  { fill: #7dcfff; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" rx="14" fill="#13161f"/>
  <path d="M0 14 A14 14 0 0 1 14 0 H${width - 14} A14 14 0 0 1 ${width} 14 V44 H0 Z" fill="url(#chrome)"/>
  <circle cx="26" cy="22" r="6" fill="#f7768e"/>
  <circle cx="48" cy="22" r="6" fill="#e0af68"/>
  <circle cx="70" cy="22" r="6" fill="#9ece6a"/>
  <text class="faint" x="${width / 2}" y="27" text-anchor="middle">opencode-sync</text>
${body}
</svg>
`;
}

try {
  for (const [lang, file] of [
    ["en", "menu.svg"],
    ["zh-CN", "menu.zh-CN.svg"],
  ]) {
    const lines = await capture(lang);
    fs.writeFileSync(path.join(root, "docs", file), svg(lines, lang));
    console.log(`docs/${file}: ${lines.length} lines`);
  }
} finally {
  setOutput(process.stdout);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
