import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ensureDir } from "./fsx.js";
import { SESSIONS_DIR } from "./paths.js";
import type { Reporter } from "./reporter.js";
import type { SessionSettings } from "./settings.js";
import { type SqliteDatabase, existingTables, openDatabase, tableColumns } from "./sqlite.js";

/**
 * Selective session sync.
 *
 * The naive approach — commit `opencode.db` — stops working almost immediately.
 * A real database reaches several gigabytes, dominated by tool output stored in
 * `part.data`, and Git has no way to delta-compress it. Worse, copying a live
 * database together with its write-ahead log can capture a torn state that only
 * reveals itself much later.
 *
 * So sessions are exported one at a time. Each session becomes an independent,
 * gzipped JSON shard containing its own rows plus the project and workspace
 * rows it depends on. That buys three things:
 *
 *   - **No large files.** Shards are individually small and compress well.
 *   - **Conflict isolation.** Two machines editing different sessions touch
 *     different files, so Git merges them without any special handling. The
 *     only true conflict is the same session edited in two places, where the
 *     newer `time_updated` wins.
 *   - **Selectivity.** A time window, an explicit include list, a project
 *     filter and a per-session size cap decide what travels. Ancient sessions
 *     stay on the machine that created them.
 *
 * Import is an upsert inside a transaction, so a failure leaves the local
 * database exactly as it was.
 */

/** Tables whose rows belong to exactly one session. */
const SESSION_TABLES = [
  "session_message",
  "message",
  "part",
  "todo",
  "session_share",
  "session_context_epoch",
  "session_input",
] as const;

/**
 * `event` and `event_sequence` are deliberately excluded. They are an internal
 * append-only runtime log, they dwarf everything else in row count, and nothing
 * about resuming a conversation on another machine depends on them.
 */

export interface SessionRecord {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
  timeCreated: number;
  projectId: string;
}

export interface SessionShard {
  formatVersion: 1;
  session: Record<string, unknown>;
  project?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  exportedAt: number;
}

export interface SelectOptions extends SessionSettings {
  now?: number;
}

export interface ExportResult {
  written: string[];
  skippedTooLarge: { id: string; title: string; bytes: number }[];
  considered: number;
}

export interface ImportResult {
  imported: number;
  skippedOlder: number;
  failed: { file: string; reason: string }[];
}

function shardPath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, SESSIONS_DIR, `${sanitizeId(sessionId)}.json.gz`);
}

/** Session ids are opaque; keep them filesystem-safe without losing identity. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function readRows(db: SqliteDatabase, sql: string, params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

/**
 * Choose which sessions to export.
 *
 * Explicitly included ids always win, even when they fall outside the window.
 * Everything else must be inside the time window, pass the directory filter and
 * survive the count cap, which keeps the newest sessions.
 */
export function selectSessions(db: SqliteDatabase, options: SelectOptions): SessionRecord[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.days * 24 * 60 * 60 * 1000;

  const rows = readRows(
    db,
    `SELECT id, title, directory, time_updated, time_created, project_id
       FROM session
      ORDER BY time_updated DESC`,
    [],
  ) as any[];

  const exclude = new Set(options.exclude);
  const include = new Set(options.include);
  const directories = options.directories.map((d) => path.resolve(d));

  const matchesDirectory = (directory: string): boolean => {
    if (directories.length === 0) return true;
    const resolved = path.resolve(String(directory ?? ""));
    return directories.some((d) => resolved === d || resolved.startsWith(`${d}${path.sep}`));
  };

  const selected: SessionRecord[] = [];
  let windowCount = 0;

  for (const row of rows) {
    const id = String(row.id);
    if (exclude.has(id)) continue;

    const record: SessionRecord = {
      id,
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    };

    if (include.has(id)) {
      selected.push(record);
      continue;
    }
    if (record.timeUpdated < cutoff) continue;
    if (!matchesDirectory(record.directory)) continue;
    if (windowCount >= options.maxSessions) continue;

    windowCount++;
    selected.push(record);
  }

  return selected;
}

function buildShard(db: SqliteDatabase, sessionId: string, tables: string[]): SessionShard {
  const sessionRow = readRows(db, "SELECT * FROM session WHERE id = ?", [sessionId])[0];
  if (!sessionRow) throw new Error(`Session ${sessionId} disappeared while exporting`);

  const shard: SessionShard = {
    formatVersion: 1,
    session: sessionRow,
    tables: {},
    exportedAt: Date.now(),
  };

  const projectId = sessionRow.project_id;
  if (projectId) {
    shard.project = readRows(db, "SELECT * FROM project WHERE id = ?", [projectId])[0];
  }
  const workspaceId = (sessionRow as any).workspace_id;
  if (workspaceId) {
    const rows = readRows(db, "SELECT * FROM workspace WHERE id = ?", [workspaceId]);
    if (rows[0]) shard.workspace = rows[0];
  }

  for (const table of tables) {
    shard.tables[table] = readRows(db, `SELECT * FROM "${table}" WHERE session_id = ?`, [
      sessionId,
    ]);
  }

  return shard;
}

/** Export the selected sessions into `<repo>/_sessions`. */
export async function exportSessions(
  databaseFile: string,
  repoRoot: string,
  options: SelectOptions,
  reporter: Reporter,
): Promise<ExportResult> {
  const result: ExportResult = { written: [], skippedTooLarge: [], considered: 0 };
  if (!fs.existsSync(databaseFile)) return result;

  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const tables = existingTables(db, [...SESSION_TABLES]).filter((table) =>
      tableColumns(db, table).includes("session_id"),
    );
    const sessions = selectSessions(db, options);
    result.considered = sessions.length;

    const outDir = path.join(repoRoot, SESSIONS_DIR);
    ensureDir(outDir);

    const keep = new Set<string>();

    for (const session of sessions) {
      const shard = buildShard(db, session.id, tables);
      const payload = gzipSync(Buffer.from(JSON.stringify(shard)), { level: 9 });

      if (payload.byteLength > options.maxSessionBytes) {
        result.skippedTooLarge.push({
          id: session.id,
          title: session.title,
          bytes: payload.byteLength,
        });
        continue;
      }

      const file = shardPath(repoRoot, session.id);
      keep.add(path.basename(file));
      // Only rewrite when the payload actually changed, otherwise every push
      // would produce a diff for every session purely from the gzip timestamp.
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(payload)) {
        fs.writeFileSync(file, payload);
      }
      result.written.push(session.id);
    }

    pruneShards(outDir, keep, options, reporter);
  } finally {
    db.close();
  }

  return result;
}

/**
 * Delete shards that no longer qualify.
 *
 * A shard is removed when it is outside the retention window, so the repository
 * does not accumulate every session ever synced. Shards for explicitly included
 * sessions are always kept.
 */
function pruneShards(
  outDir: string,
  keep: Set<string>,
  options: SelectOptions,
  reporter: Reporter,
): void {
  let removed = 0;
  const includeFiles = new Set(options.include.map((id) => `${sanitizeId(id)}.json.gz`));
  for (const entry of fs.readdirSync(outDir)) {
    if (!entry.endsWith(".json.gz")) continue;
    if (keep.has(entry) || includeFiles.has(entry)) continue;
    fs.rmSync(path.join(outDir, entry), { force: true });
    removed++;
  }
  if (removed > 0)
    reporter.detail(`Removed ${removed} session shard(s) outside the retention window`);
}

function readShard(file: string): SessionShard {
  const raw = gunzipSync(fs.readFileSync(file));
  const shard = JSON.parse(raw.toString("utf8")) as SessionShard;
  if (shard.formatVersion !== 1) {
    throw new Error(`Unsupported shard format v${shard.formatVersion}`);
  }
  return shard;
}

function upsert(
  db: SqliteDatabase,
  table: string,
  row: Record<string, unknown>,
  allowedColumns: Set<string>,
): void {
  const columns = Object.keys(row).filter((column) => allowedColumns.has(column));
  if (columns.length === 0) return;
  const placeholders = columns.map(() => "?").join(", ");
  const quoted = columns.map((column) => `"${column}"`).join(", ");
  db.prepare(`INSERT OR REPLACE INTO "${table}" (${quoted}) VALUES (${placeholders})`).run(
    ...columns.map((column) => normalize(row[column])),
  );
}

/** SQLite drivers accept null/number/string/bigint/Buffer only. */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Import every shard from `<repo>/_sessions` into the local database. */
export async function importSessions(
  databaseFile: string,
  repoRoot: string,
  reporter: Reporter,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skippedOlder: 0, failed: [] };
  const shardDir = path.join(repoRoot, SESSIONS_DIR);
  if (!fs.existsSync(shardDir)) return result;

  const files = fs.readdirSync(shardDir).filter((f) => f.endsWith(".json.gz"));
  if (files.length === 0) return result;
  if (!fs.existsSync(databaseFile)) {
    reporter.warn("No local OpenCode database yet — start OpenCode once, then pull again.");
    return result;
  }

  const db = await openDatabase(databaseFile);
  try {
    const columnsFor = new Map<string, Set<string>>();
    const columns = (table: string): Set<string> => {
      let set = columnsFor.get(table);
      if (!set) {
        set = new Set(tableColumns(db, table));
        columnsFor.set(table, set);
      }
      return set;
    };

    const localTimes = new Map<string, number>();
    for (const row of readRows(db, "SELECT id, time_updated FROM session", []) as any[]) {
      localTimes.set(String(row.id), Number(row.time_updated ?? 0));
    }

    for (const file of files) {
      const full = path.join(shardDir, file);
      try {
        const shard = readShard(full);
        const sessionId = String(shard.session.id);
        const incoming = Number(shard.session.time_updated ?? 0);
        const local = localTimes.get(sessionId);

        // Last-writer-wins at session granularity. A session that is newer
        // locally is left completely alone, so an in-progress conversation is
        // never clobbered by a stale copy from another machine.
        if (local !== undefined && local >= incoming) {
          result.skippedOlder++;
          continue;
        }

        db.exec("BEGIN IMMEDIATE");
        try {
          if (shard.project) upsert(db, "project", shard.project, columns("project"));
          if (shard.workspace) upsert(db, "workspace", shard.workspace, columns("workspace"));
          upsert(db, "session", shard.session, columns("session"));

          for (const [table, rows] of Object.entries(shard.tables)) {
            if (rows.length === 0) continue;
            let allowed: Set<string>;
            try {
              allowed = columns(table);
            } catch {
              continue; // Table does not exist in this OpenCode version.
            }
            if (allowed.size === 0) continue;
            for (const row of rows) upsert(db, table, row, allowed);
          }
          db.exec("COMMIT");
          result.imported++;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        result.failed.push({ file, reason: (err as Error).message });
      }
    }
  } finally {
    db.close();
  }

  return result;
}

/** List sessions available locally, newest first — powers `sessions list`. */
export async function listSessions(databaseFile: string, limit: number): Promise<SessionRecord[]> {
  if (!fs.existsSync(databaseFile)) return [];
  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const rows = readRows(
      db,
      `SELECT id, title, directory, time_updated, time_created, project_id
         FROM session ORDER BY time_updated DESC LIMIT ?`,
      [limit],
    ) as any[];
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    }));
  } finally {
    db.close();
  }
}
