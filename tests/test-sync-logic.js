#!/usr/bin/env node
/**
 * test-sync-logic.js — Integration tests for sync-config.js and sync-sessions.js
 *
 * Tests push/pull logic with isolated temp git repos. No real GitHub involved.
 *
 * Usage: node tests/test-sync-logic.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync, spawnSync } = require("node:child_process");

// ── Helpers ─────────────────────────────────────────────────────

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const SYNC_CONFIG = path.join(SCRIPTS_DIR, "sync-config.js");
const SYNC_SESSIONS = path.join(SCRIPTS_DIR, "sync-sessions.js");

let tmpBase;
let passed = 0;
let failed = 0;
const failures = [];

function setup() {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ocsync-test-"));
}

function cleanup() {
  if (tmpBase && fs.existsSync(tmpBase)) {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function mkTmpDir(name) {
  const dir = path.join(tmpBase, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function initBareRemote(name) {
  const dir = mkTmpDir(name);
  git("init --bare -b main", dir);
  return dir;
}

/**
 * Run a sync script with environment overrides.
 * Returns { code, stdout, stderr }
 */
function runScript(script, args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: SCRIPTS_DIR,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30000,
    env: {
      ...process.env,
      SYNC_SKIP_LFS: "1",
      SYNC_SKIP_PROCESS_CHECK: "1",
      ...envOverrides,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function assert(condition, testName, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${testName}`);
  } else {
    failed++;
    const msg = `  \x1b[31m✗\x1b[0m ${testName}${detail ? " — " + detail : ""}`;
    console.log(msg);
    failures.push(testName);
  }
}

// ── Test Cases ──────────────────────────────────────────────────

function testConfigPushWithChanges() {
  console.log("\n\x1b[1m[sync-config] Push with changes\x1b[0m");

  const remote = initBareRemote("cfg-push-remote");
  const configRoot = mkTmpDir("cfg-push-config");
  const dataRoot = mkTmpDir("cfg-push-data");
  const stateRoot = mkTmpDir("cfg-push-state");
  const agentsRoot = mkTmpDir("cfg-push-agents");

  // Create some config files
  fs.writeFileSync(path.join(configRoot, "opencode.json"), '{"test": true}');
  fs.writeFileSync(path.join(stateRoot, "frecency.json"), '{}');

  const r = runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_STATE_ROOT: stateRoot,
    SYNC_AGENTS_ROOT: agentsRoot,
    SYNC_REMOTE_URL: remote,
  });

  const out = stripAnsi(r.stdout);
  assert(r.code === 0, "exit code 0", `got ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert(out.includes("已提交"), "shows commit message");
  assert(out.includes("已 Push"), "shows push success");
  assert(out.includes("同步完成"), "shows completionBanner");
  assert(!out.includes("已是最新"), "does NOT show up-to-date");
}

function testConfigPushNoChanges() {
  console.log("\n\x1b[1m[sync-config] Push with no changes\x1b[0m");

  const remote = initBareRemote("cfg-nopush-remote");
  const configRoot = mkTmpDir("cfg-nopush-config");
  const dataRoot = mkTmpDir("cfg-nopush-data");
  const stateRoot = mkTmpDir("cfg-nopush-state");
  const agentsRoot = mkTmpDir("cfg-nopush-agents");

  const env = {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_STATE_ROOT: stateRoot,
    SYNC_AGENTS_ROOT: agentsRoot,
    SYNC_REMOTE_URL: remote,
  };

  // First push to create initial state
  fs.writeFileSync(path.join(configRoot, "opencode.json"), '{"v":1}');
  runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], env);

  // Second push — no changes
  const r = runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], env);
  const out = stripAnsi(r.stdout);

  assert(r.code === 0, "exit code 0", `got ${r.code}`);
  assert(out.includes("已是最新"), "shows up-to-date");
  assert(out.includes("同步完成"), "shows upToDateBanner");
  assert(!out.includes("已提交"), "does NOT show commit");
}

function testConfigPullWithChanges() {
  console.log("\n\x1b[1m[sync-config] Pull with incoming changes\x1b[0m");

  const remote = initBareRemote("cfg-pull-remote");

  // Machine A pushes
  const configA = mkTmpDir("cfg-pull-A");
  const dataA = mkTmpDir("cfg-pull-dataA");
  const stateA = mkTmpDir("cfg-pull-stateA");
  const agentsA = mkTmpDir("cfg-pull-agentsA");
  fs.writeFileSync(path.join(configA, "opencode.json"), '{"from":"A"}');
  fs.writeFileSync(path.join(stateA, "kv.json"), '{"key":"value"}');

  runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], {
    SYNC_CONFIG_ROOT: configA,
    SYNC_DATA_ROOT: dataA,
    SYNC_STATE_ROOT: stateA,
    SYNC_AGENTS_ROOT: agentsA,
    SYNC_REMOTE_URL: remote,
  });

  // Machine B pulls — fresh dir, NOT pre-initialized as git repo
  const configB = mkTmpDir("cfg-pull-B");
  const dataB = mkTmpDir("cfg-pull-dataB");
  const stateB = mkTmpDir("cfg-pull-stateB");
  const agentsB = mkTmpDir("cfg-pull-agentsB");

  const r = runScript(SYNC_CONFIG, ["pull", "--target=config", "--action=pull"], {
    SYNC_CONFIG_ROOT: configB,
    SYNC_DATA_ROOT: dataB,
    SYNC_STATE_ROOT: stateB,
    SYNC_AGENTS_ROOT: agentsB,
    SYNC_REMOTE_URL: remote,
  });

  const out = stripAnsi(r.stdout);
  assert(r.code === 0, "exit code 0", `got ${r.code}\nstdout: ${stripAnsi(r.stdout)}\nstderr: ${r.stderr}`);
  assert(out.includes("Pull 完成") || out.includes("已从 GitHub Pull"), "shows pull success");
  assert(out.includes("同步完成"), "shows completionBanner");
  // Verify stageOut restored state files
  assert(fs.existsSync(path.join(stateB, "kv.json")), "state file restored");
}

function testConfigPullNoChanges_DoesNotDeleteLocalFiles() {
  console.log("\n\x1b[1m[sync-config] Pull no changes — local new files preserved (BUG1 fix)\x1b[0m");

  const remote = initBareRemote("cfg-nopull-remote");

  // Initial push
  const configRoot = mkTmpDir("cfg-nopull-config");
  const dataRoot = mkTmpDir("cfg-nopull-data");
  const stateRoot = mkTmpDir("cfg-nopull-state");
  const agentsRoot = mkTmpDir("cfg-nopull-agents");
  fs.writeFileSync(path.join(configRoot, "opencode.json"), '{"v":1}');
  fs.writeFileSync(path.join(stateRoot, "old.json"), '{}');

  const env = {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_STATE_ROOT: stateRoot,
    SYNC_AGENTS_ROOT: agentsRoot,
    SYNC_REMOTE_URL: remote,
  };

  runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], env);

  // Simulate new local state file created after push (not yet pushed)
  fs.writeFileSync(path.join(stateRoot, "new-local.json"), '{"local":"only"}');

  // Pull — no remote changes
  const r = runScript(SYNC_CONFIG, ["pull", "--target=config", "--action=pull"], env);
  const out = stripAnsi(r.stdout);

  assert(r.code === 0, "exit code 0", `got ${r.code}`);
  assert(out.includes("已是最新"), "shows up-to-date");
  // THE CRITICAL CHECK: new-local.json must still exist
  assert(
    fs.existsSync(path.join(stateRoot, "new-local.json")),
    "BUG1 FIX: local new file NOT deleted",
    "new-local.json was deleted by stageOut!"
  );
}

function testConfigPullWithChanges_StageOutCalled() {
  console.log("\n\x1b[1m[sync-config] Pull with changes — stageOut IS called\x1b[0m");

  const remote = initBareRemote("cfg-pullyes-remote");

  // Machine A pushes with state data
  const configA = mkTmpDir("cfg-pullyes-A");
  const dataA = mkTmpDir("cfg-pullyes-dataA");
  const stateA = mkTmpDir("cfg-pullyes-stateA");
  const agentsA = mkTmpDir("cfg-pullyes-agentsA");
  fs.writeFileSync(path.join(configA, "config.json"), '{"v":1}');
  fs.writeFileSync(path.join(stateA, "model.json"), '{"model":"test"}');

  runScript(SYNC_CONFIG, ["push", "--target=config", "--action=push"], {
    SYNC_CONFIG_ROOT: configA,
    SYNC_DATA_ROOT: dataA,
    SYNC_STATE_ROOT: stateA,
    SYNC_AGENTS_ROOT: agentsA,
    SYNC_REMOTE_URL: remote,
  });

  // Machine B pulls — fresh dir
  const configB = mkTmpDir("cfg-pullyes-B");
  const dataB = mkTmpDir("cfg-pullyes-dataB");
  const stateB = mkTmpDir("cfg-pullyes-stateB");
  const agentsB = mkTmpDir("cfg-pullyes-agentsB");

  const r = runScript(SYNC_CONFIG, ["pull", "--target=config", "--action=pull"], {
    SYNC_CONFIG_ROOT: configB,
    SYNC_DATA_ROOT: dataB,
    SYNC_STATE_ROOT: stateB,
    SYNC_AGENTS_ROOT: agentsB,
    SYNC_REMOTE_URL: remote,
  });

  assert(r.code === 0, "exit code 0", `got ${r.code}\nstdout: ${stripAnsi(r.stdout)}\nstderr: ${r.stderr}`);
  assert(
    fs.existsSync(path.join(stateB, "model.json")),
    "stageOut called: state file restored on pull with changes"
  );
  assert(
    fs.existsSync(path.join(configB, "config.json")),
    "config file pulled"
  );
}

function testSessionsPushWithChanges() {
  console.log("\n\x1b[1m[sync-sessions] Push with changes\x1b[0m");

  const remote = initBareRemote("ses-push-remote");
  const configRoot = mkTmpDir("ses-push-config");
  const dataRoot = mkTmpDir("ses-push-data");

  // Create session storage data (no .db to avoid sqlite3 dependency)
  const storageDir = path.join(dataRoot, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "session1.json"), '{"id":"s1"}');

  const r = runScript(SYNC_SESSIONS, ["push", "--target=sessions", "--action=push"], {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_REMOTE_URL: remote,
  });

  const out = stripAnsi(r.stdout);
  assert(r.code === 0, "exit code 0", `got ${r.code}\nstdout: ${stripAnsi(r.stdout)}\nstderr: ${r.stderr}`);
  assert(out.includes("已 Push") || out.includes("已提交"), "shows push/commit success");
  assert(out.includes("同步完成"), "shows completionBanner");
}

function testSessionsPushNoChanges() {
  console.log("\n\x1b[1m[sync-sessions] Push with no changes\x1b[0m");

  const remote = initBareRemote("ses-nopush-remote");
  const configRoot = mkTmpDir("ses-nopush-config");
  const dataRoot = mkTmpDir("ses-nopush-data");

  const env = {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_REMOTE_URL: remote,
  };

  // First push
  const storageDir = path.join(dataRoot, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "s1.json"), '{}');
  runScript(SYNC_SESSIONS, ["push", "--target=sessions", "--action=push"], env);

  // Second push — no changes
  const r = runScript(SYNC_SESSIONS, ["push", "--target=sessions", "--action=push"], env);
  const out = stripAnsi(r.stdout);

  assert(r.code === 0, "exit code 0", `got ${r.code}\nstdout: ${stripAnsi(r.stdout)}\nstderr: ${r.stderr}`);
  assert(out.includes("已是最新"), "shows up-to-date");
  assert(out.includes("同步完成"), "shows upToDateBanner");
  assert(!out.includes("已提交"), "does NOT show commit");
}

function testSessionsPullNoChanges_DoesNotDeleteLocalFiles() {
  console.log("\n\x1b[1m[sync-sessions] Pull no changes — local new files preserved (BUG1 fix)\x1b[0m");

  const remote = initBareRemote("ses-nopull-remote");
  const configRoot = mkTmpDir("ses-nopull-config");
  const dataRoot = mkTmpDir("ses-nopull-data");

  const env = {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_REMOTE_URL: remote,
  };

  // Create and push initial storage data
  const storageDir = path.join(dataRoot, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "existing.json"), '{"old":true}');
  runScript(SYNC_SESSIONS, ["push", "--target=sessions", "--action=push"], env);

  // Simulate new local session file created after push
  fs.writeFileSync(path.join(storageDir, "brand-new-session.json"), '{"new":"session"}');
  const toolDir = path.join(dataRoot, "tool-output");
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, "new-output.txt"), "tool output data");

  // Pull — no remote changes
  const r = runScript(SYNC_SESSIONS, ["pull", "--target=sessions", "--action=pull"], env);
  const out = stripAnsi(r.stdout);

  assert(r.code === 0, "exit code 0", `got ${r.code}`);
  assert(out.includes("已是最新"), "shows up-to-date");
  assert(
    fs.existsSync(path.join(storageDir, "brand-new-session.json")),
    "BUG1 FIX: new session file NOT deleted",
    "brand-new-session.json was deleted!"
  );
  assert(
    fs.existsSync(path.join(toolDir, "new-output.txt")),
    "BUG1 FIX: new tool-output file NOT deleted",
    "new-output.txt was deleted!"
  );
}

function testBannerTargetLabels() {
  console.log("\n\x1b[1m[banner] --target labels in banner output\x1b[0m");

  const remote = initBareRemote("banner-remote");
  const configRoot = mkTmpDir("banner-config");
  const dataRoot = mkTmpDir("banner-data");
  const stateRoot = mkTmpDir("banner-state");
  const agentsRoot = mkTmpDir("banner-agents");

  fs.writeFileSync(path.join(configRoot, "test.json"), '{}');
  const r = runScript(SYNC_CONFIG, ["push", "--target=both", "--action=push"], {
    SYNC_CONFIG_ROOT: configRoot,
    SYNC_DATA_ROOT: dataRoot,
    SYNC_STATE_ROOT: stateRoot,
    SYNC_AGENTS_ROOT: agentsRoot,
    SYNC_REMOTE_URL: remote,
  });

  const out = stripAnsi(r.stdout);
  assert(r.code === 0, "exit code 0", `got ${r.code}`);
  assert(out.includes("配置和会话"), "banner shows '配置和会话' for target=both");
}

function testDispatchNoDoubleBanner() {
  console.log("\n\x1b[1m[dispatch] No double banner from opencode-sync-core\x1b[0m");

  const coreSource = fs.readFileSync(
    path.join(SCRIPTS_DIR, "opencode-sync-core.js"),
    "utf8"
  );

  assert(
    !coreSource.includes("completionBanner"),
    "opencode-sync-core.js does NOT reference completionBanner"
  );
  assert(
    !coreSource.includes("upToDateBanner"),
    "opencode-sync-core.js does NOT reference upToDateBanner"
  );
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  console.log("\n\x1b[1;36m═══ OpenCode Sync Logic Tests ═══\x1b[0m");

  setup();

  try {
    testConfigPushWithChanges();
    testConfigPushNoChanges();
    testConfigPullWithChanges();
    testConfigPullNoChanges_DoesNotDeleteLocalFiles();
    testConfigPullWithChanges_StageOutCalled();

    testSessionsPushWithChanges();
    testSessionsPushNoChanges();
    testSessionsPullNoChanges_DoesNotDeleteLocalFiles();

    testBannerTargetLabels();
    testDispatchNoDoubleBanner();
  } finally {
    cleanup();
  }

  console.log("\n\x1b[1m─── Results ───\x1b[0m");
  console.log(`  \x1b[32m${passed} passed\x1b[0m`);
  if (failed > 0) {
    console.log(`  \x1b[31m${failed} failed\x1b[0m`);
    for (const f of failures) {
      console.log(`    \x1b[31m✗\x1b[0m ${f}`);
    }
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main();
