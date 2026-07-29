import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentReporter } from "../src/core/reporter.js";
import {
  exportSessions,
  importSessions,
  listSessions,
  sanitizeId,
  selectSessions,
} from "../src/core/sessions.js";
import type { SessionSettings } from "../src/core/settings.js";
import { openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

/**
 * These tests build a miniature copy of the real OpenCode schema. The column
 * set mirrors what OpenCode actually creates, so a shard produced here has the
 * same shape as one produced from a live database.
 */
const SCHEMA = `
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, workspace_id TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE todo (
  session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
  priority TEXT NOT NULL, position INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);
CREATE TABLE event (
  id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, data TEXT NOT NULL
);
`;

const DAY = 24 * 60 * 60 * 1000;

const settings = (patch: Partial<SessionSettings> = {}): SessionSettings & { now?: number } => ({
  enabled: true,
  days: 7,
  maxSessions: 50,
  maxSessionBytes: 5 * 1024 * 1024,
  include: [],
  exclude: [],
  directories: [],
  ...patch,
});

let root: string;
let available = false;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-sessions-"));
  available = await sqliteAvailable();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function makeDatabase(file: string, now: number): Promise<void> {
  const db = await openDatabase(file);
  db.exec(SCHEMA);

  db.prepare(
    "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)",
  ).run("prj_1", "/work/app", "app", now, now, "[]");

  const addSession = (id: string, title: string, directory: string, updated: number): void => {
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, "prj_1", id, directory, title, "1.0.0", updated - DAY, updated);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
    ).run(`msg_${id}`, id, updated, updated, JSON.stringify({ role: "user" }));
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run(
      `prt_${id}`,
      `msg_${id}`,
      id,
      updated,
      updated,
      JSON.stringify({ text: `body of ${id}` }),
    );
    db.prepare(
      `INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, "do the thing", "pending", "high", 0, updated, updated);
  };

  addSession("ses_recent", "Recent work", "/work/app", now - 1 * DAY);
  addSession("ses_alsorecent", "Also recent", "/work/other", now - 2 * DAY);
  addSession("ses_old", "Ancient history", "/work/app", now - 90 * DAY);

  db.prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)").run(
    "evt_1",
    "ses_recent",
    1,
    "noise",
    "{}",
  );

  db.close();
}

describe("selectSessions", () => {
  it("keeps sessions inside the window and drops older ones", async () => {
    if (!available) return;
    const now = Date.now();
    const file = path.join(root, "db.sqlite");
    await makeDatabase(file, now);

    const db = await openDatabase(file, { readOnly: true });
    const selected = selectSessions(db, { ...settings(), now });
    db.close();

    expect(selected.map((s) => s.id).sort()).toEqual(["ses_alsorecent", "ses_recent"]);
  });

  it("always keeps explicitly included sessions", async () => {
    if (!available) return;
    const now = Date.now();
    const file = path.join(root, "db.sqlite");
    await makeDatabase(file, now);

    const db = await openDatabase(file, { readOnly: true });
    const selected = selectSessions(db, { ...settings({ include: ["ses_old"] }), now });
    db.close();

    expect(selected.map((s) => s.id)).toContain("ses_old");
  });

  it("honours the exclude list even inside the window", async () => {
    if (!available) return;
    const now = Date.now();
    const file = path.join(root, "db.sqlite");
    await makeDatabase(file, now);

    const db = await openDatabase(file, { readOnly: true });
    const selected = selectSessions(db, { ...settings({ exclude: ["ses_recent"] }), now });
    db.close();

    expect(selected.map((s) => s.id)).not.toContain("ses_recent");
  });

  it("applies the directory filter", async () => {
    if (!available) return;
    const now = Date.now();
    const file = path.join(root, "db.sqlite");
    await makeDatabase(file, now);

    const db = await openDatabase(file, { readOnly: true });
    const selected = selectSessions(db, {
      ...settings({ directories: ["/work/other"] }),
      now,
    });
    db.close();

    expect(selected.map((s) => s.id)).toEqual(["ses_alsorecent"]);
  });

  it("caps how many sessions are selected, keeping the newest", async () => {
    if (!available) return;
    const now = Date.now();
    const file = path.join(root, "db.sqlite");
    await makeDatabase(file, now);

    const db = await openDatabase(file, { readOnly: true });
    const selected = selectSessions(db, { ...settings({ maxSessions: 1 }), now });
    db.close();

    expect(selected.map((s) => s.id)).toEqual(["ses_recent"]);
  });
});

describe("export and import", () => {
  it("round-trips a session into an empty database", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    await makeDatabase(source, now);

    const exported = await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(exported.written.sort()).toEqual(["ses_alsorecent", "ses_recent"]);
    expect(fs.existsSync(path.join(repo, "_sessions", "ses_recent.json.gz"))).toBe(true);

    const target = path.join(root, "target.sqlite");
    const empty = await openDatabase(target);
    empty.exec(SCHEMA);
    empty.close();

    const result = await importSessions(target, repo, silentReporter);
    expect(result.imported).toBe(2);
    expect(result.failed).toEqual([]);

    const listed = await listSessions(target, 10);
    expect(listed.map((s) => s.id).sort()).toEqual(["ses_alsorecent", "ses_recent"]);

    const db = await openDatabase(target, { readOnly: true });
    const parts = db.prepare("SELECT data FROM part WHERE session_id = ?").all("ses_recent");
    const todos = db.prepare("SELECT content FROM todo WHERE session_id = ?").all("ses_recent");
    const events = db.prepare("SELECT COUNT(*) AS n FROM event").all() as any[];
    db.close();

    expect(parts).toHaveLength(1);
    expect(todos).toHaveLength(1);
    // The runtime event log is intentionally not part of a shard.
    expect(events[0].n).toBe(0);
  });

  it("does not overwrite a session that is newer locally", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    await makeDatabase(source, now);
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    const target = path.join(root, "target.sqlite");
    const db = await openDatabase(target);
    db.exec(SCHEMA);
    db.prepare(
      "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)",
    ).run("prj_1", "/work/app", "app", now, now, "[]");
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("ses_recent", "prj_1", "s", "/work/app", "Newer local title", "1.0.0", now, now + DAY);
    db.close();

    const result = await importSessions(target, repo, silentReporter);
    expect(result.skippedOlder).toBe(1);

    const check = await openDatabase(target, { readOnly: true });
    const rows = check.prepare("SELECT title FROM session WHERE id = ?").all("ses_recent") as any[];
    check.close();
    expect(rows[0].title).toBe("Newer local title");
  });

  it("skips a session larger than the configured cap", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    await makeDatabase(source, now);

    const db = await openDatabase(source);
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run("prt_big", "msg_ses_recent", "ses_recent", now, now, "x".repeat(400_000));
    db.close();

    const exported = await exportSessions(
      source,
      repo,
      { ...settings({ maxSessionBytes: 512 }), now },
      silentReporter,
    );

    expect(exported.skippedTooLarge.map((s) => s.id)).toContain("ses_recent");
    expect(fs.existsSync(path.join(repo, "_sessions", "ses_recent.json.gz"))).toBe(false);
  });

  it("removes shards that fall out of the retention window", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "_sessions"), { recursive: true });
    fs.writeFileSync(path.join(repo, "_sessions", "ses_stale.json.gz"), "junk");
    await makeDatabase(source, now);

    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(fs.existsSync(path.join(repo, "_sessions", "ses_stale.json.gz"))).toBe(false);
  });

  it("writes byte-identical shards on a repeat export", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    await makeDatabase(source, now);

    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    const shard = path.join(repo, "_sessions", "ses_recent.json.gz");
    const before = fs.statSync(shard).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    // An unchanged session must not produce a new diff on every push.
    expect(fs.statSync(shard).mtimeMs).toBe(before);
  });
});

describe("sanitizeId", () => {
  it("keeps safe ids untouched", () => {
    expect(sanitizeId("ses_065cad1caffeN3lf1RgLZno30")).toBe("ses_065cad1caffeN3lf1RgLZno30");
  });

  it("replaces path separators", () => {
    expect(sanitizeId("a/b\\c")).toBe("a_b_c");
  });
});
