import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
 * same shape as one produced from a live database. The foreign keys mirror
 * OpenCode's too: without `ON DELETE CASCADE` an `INSERT OR REPLACE` on a
 * shared project row looks harmless, which is how #2 went unnoticed.
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, workspace_id TEXT,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE TABLE todo (
  session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
  priority TEXT NOT NULL, position INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
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
    const before = fs.readFileSync(shard);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    // An unchanged session must not produce a new diff on every push — same
    // bytes, same mtime, no diff for git to pick up.
    expect(fs.readFileSync(shard).equals(before)).toBe(true);
  });
});

/** Write a shard by hand, the way an older or another machine's export would. */
function writeShard(repo: string, shard: Record<string, unknown>): void {
  const dir = path.join(repo, "_sessions");
  fs.mkdirSync(dir, { recursive: true });
  const id = String((shard.session as any).id);
  fs.writeFileSync(path.join(dir, `${id}.json.gz`), gzipSync(Buffer.from(JSON.stringify(shard))));
}

function projectRow(id: string, worktree: string, updated: number): Record<string, unknown> {
  return { id, worktree, name: null, time_created: 1, time_updated: updated, sandboxes: "[]" };
}

function shardFor(
  sessionId: string,
  projectId: string,
  updated: number,
  project?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    formatVersion: 1,
    session: {
      id: sessionId,
      project_id: projectId,
      parent_id: null,
      slug: sessionId,
      directory: "/work",
      title: sessionId,
      version: "1.0.0",
      time_created: updated,
      time_updated: updated,
      workspace_id: null,
    },
    ...(project ? { project } : {}),
    tables: {
      message: [
        {
          id: `msg_${sessionId}`,
          session_id: sessionId,
          time_created: 1,
          time_updated: 1,
          data: "{}",
        },
      ],
      part: [
        {
          id: `prt_${sessionId}`,
          message_id: `msg_${sessionId}`,
          session_id: sessionId,
          time_created: 1,
          time_updated: 1,
          data: "{}",
        },
      ],
      todo: [
        {
          session_id: sessionId,
          content: "todo",
          status: "pending",
          priority: "high",
          position: 0,
          time_created: 1,
          time_updated: 1,
        },
      ],
    },
    exportedAt: updated,
  };
}

async function emptyTarget(file: string, projects: Record<string, unknown>[] = []): Promise<void> {
  const db = await openDatabase(file);
  db.exec(SCHEMA);
  for (const p of projects) {
    db.prepare(
      "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)",
    ).run(p.id, p.worktree, p.name, p.time_created, p.time_updated, p.sandboxes);
  }
  db.close();
}

async function count(file: string, sql: string, ...params: unknown[]): Promise<number> {
  const db = await openDatabase(file, { readOnly: true });
  const rows = db.prepare(sql).all(...params) as any[];
  db.close();
  return Number(rows[0].n);
}

describe("import safety (#2, #4)", () => {
  it("keeps every session when shards share one project", async () => {
    if (!available) return;
    const repo = path.join(root, "repo");
    writeShard(repo, shardFor("ses_a", "prj_shared", 100, projectRow("prj_shared", "/a", 10)));
    writeShard(repo, shardFor("ses_b", "prj_shared", 200, projectRow("prj_shared", "/b", 20)));

    const target = path.join(root, "target.sqlite");
    await emptyTarget(target);
    // The cascade needs enforced foreign keys on the connection the importer
    // opens; node:sqlite enables them by default. Guard against a vacuous pass.
    expect(await count(target, "SELECT foreign_keys AS n FROM pragma_foreign_keys")).toBe(1);

    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(2);

    // INSERT OR REPLACE on the shared project row cascaded into ses_a.
    expect(await count(target, "SELECT COUNT(*) AS n FROM session")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM message")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM part")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM todo")).toBe(2);

    const db = await openDatabase(target, { readOnly: true });
    const project = db
      .prepare("SELECT worktree FROM project WHERE id = 'prj_shared'")
      .all() as any[];
    db.close();
    // The newer project row from shard B wins.
    expect(project[0].worktree).toBe("/b");
  });

  it("does not let an older project row overwrite a newer local one", async () => {
    if (!available) return;
    const repo = path.join(root, "repo");
    writeShard(repo, shardFor("ses_a", "prj_shared", 100, projectRow("prj_shared", "/stale", 10)));

    const target = path.join(root, "target.sqlite");
    await emptyTarget(target, [projectRow("prj_shared", "/local", 50)]);

    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);

    const db = await openDatabase(target, { readOnly: true });
    const project = db
      .prepare("SELECT worktree FROM project WHERE id = 'prj_shared'")
      .all() as any[];
    db.close();
    expect(project[0].worktree).toBe("/local");
  });

  it("does not export the synthetic global project row", async () => {
    if (!available) return;
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    await makeDatabase(source, now);

    const db = await openDatabase(source);
    db.prepare(
      "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)",
    ).run("global", "/machine-a", null, now, now, "[]");
    db.prepare("UPDATE session SET project_id = 'global' WHERE id = 'ses_recent'").run();
    db.close();

    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    const read = (id: string): any =>
      JSON.parse(
        gunzipSync(fs.readFileSync(path.join(repo, "_sessions", `${id}.json.gz`))).toString(),
      );

    expect(read("ses_recent").project).toBeUndefined();
    // A real project still travels.
    expect(read("ses_alsorecent").project.id).toBe("prj_1");
  });

  it("keeps the local global project when importing new shards without it", async () => {
    if (!available) return;
    const repo = path.join(root, "repo");
    writeShard(repo, shardFor("ses_a", "global", 100));
    writeShard(repo, shardFor("ses_b", "global", 200));

    const target = path.join(root, "target.sqlite");
    const local = projectRow("global", "/machine-b", 5);
    await emptyTarget(target, [local]);

    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);
    expect(await count(target, "SELECT COUNT(*) AS n FROM session")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM part")).toBe(2);

    const db = await openDatabase(target, { readOnly: true });
    const rows = db.prepare("SELECT * FROM project WHERE id = 'global'").all() as any[];
    db.close();
    expect({ ...rows[0] }).toEqual(local);
  });

  it("keeps the local global project when importing old shards that still carry it", async () => {
    if (!available) return;
    const repo = path.join(root, "repo");
    // Newer than the local row on purpose: the global row must never be
    // overwritten, whatever its timestamp.
    writeShard(repo, shardFor("ses_a", "global", 100, projectRow("global", "/machine-a", 900)));
    writeShard(repo, shardFor("ses_b", "global", 200, projectRow("global", "/machine-a", 901)));

    const target = path.join(root, "target.sqlite");
    const local = projectRow("global", "/machine-b", 5);
    await emptyTarget(target, [local]);

    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM session")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM message")).toBe(2);
    expect(await count(target, "SELECT COUNT(*) AS n FROM part")).toBe(2);

    const db = await openDatabase(target, { readOnly: true });
    const rows = db.prepare("SELECT * FROM project WHERE id = 'global'").all() as any[];
    db.close();
    expect({ ...rows[0] }).toEqual(local);
  });

  it("updates a composite-key row in place on re-import", async () => {
    if (!available) return;
    const repo = path.join(root, "repo");
    const target = path.join(root, "target.sqlite");
    await emptyTarget(target, [projectRow("prj_1", "/w", 1)]);

    writeShard(repo, shardFor("ses_a", "prj_1", 100));
    await importSessions(target, repo, silentReporter);

    const newer = shardFor("ses_a", "prj_1", 200) as any;
    newer.tables.todo[0].status = "completed";
    newer.tables.todo[0].time_updated = 2;
    writeShard(repo, newer);
    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);

    const db = await openDatabase(target, { readOnly: true });
    const todos = db.prepare("SELECT status FROM todo WHERE session_id = 'ses_a'").all() as any[];
    db.close();
    expect(todos.map((t) => t.status)).toEqual(["completed"]);
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
