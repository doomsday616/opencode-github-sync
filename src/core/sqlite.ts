/**
 * Minimal SQLite adapter.
 *
 * OpenCode stores every session in a single SQLite database. We need to read
 * and write it without dragging in a native dependency, because this package is
 * loaded inside the OpenCode runtime where a compiled addon would have to match
 * whatever engine the user happens to be running.
 *
 * Two built-in drivers are supported, in preference order:
 *   1. `bun:sqlite`  — present when OpenCode runs the plugin under Bun
 *   2. `node:sqlite` — Node 22.5+
 *
 * Neither requires an install step. When neither is available session sync is
 * disabled with a clear message rather than failing halfway through.
 */

export interface SqliteStatement {
  all(...params: unknown[]): any[];
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface OpenOptions {
  readOnly?: boolean;
}

/**
 * Built from parts so bundlers and TypeScript never try to resolve the Bun
 * built-in at build time. It only ever exists inside the Bun runtime.
 */
const BUN_SQLITE = ["bun", "sqlite"].join(":");

async function importBunSqlite(): Promise<any> {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ BUN_SQLITE);
}

let cachedDriver: "bun" | "node" | "none" | undefined;

async function detectDriver(): Promise<"bun" | "node" | "none"> {
  if (cachedDriver) return cachedDriver;
  if (typeof (globalThis as any).Bun !== "undefined") {
    try {
      await importBunSqlite();
      cachedDriver = "bun";
      return cachedDriver;
    } catch {
      // Fall through to the Node driver.
    }
  }
  try {
    const mod: any = await import("node:sqlite");
    if (mod?.DatabaseSync) {
      cachedDriver = "node";
      return cachedDriver;
    }
  } catch {
    // Not available on this runtime.
  }
  cachedDriver = "none";
  return cachedDriver;
}

export class SqliteUnavailableError extends Error {
  constructor() {
    super(
      "Session sync needs SQLite support. Run OpenCode under Bun, or use Node 22.5 or newer.\n" +
        "Configuration sync works without it — only `sessions` is affected.",
    );
    this.name = "SqliteUnavailableError";
  }
}

export async function sqliteAvailable(): Promise<boolean> {
  return (await detectDriver()) !== "none";
}

export async function openDatabase(
  file: string,
  options: OpenOptions = {},
): Promise<SqliteDatabase> {
  const driver = await detectDriver();

  if (driver === "bun") {
    const { Database } = await importBunSqlite();
    const db = new Database(file, options.readOnly ? { readonly: true } : { create: true });
    return {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          all: (...params: unknown[]) => stmt.all(...params),
          run: (...params: unknown[]) => stmt.run(...params),
        };
      },
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    };
  }

  if (driver === "node") {
    const { DatabaseSync } = (await import("node:sqlite")) as any;
    const db = new DatabaseSync(file, options.readOnly ? { readOnly: true } : {});
    return {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          all: (...params: unknown[]) => stmt.all(...params),
          run: (...params: unknown[]) => stmt.run(...params),
        };
      },
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    };
  }

  throw new SqliteUnavailableError();
}

/** Which of the given tables actually exist in this database. */
export function existingTables(db: SqliteDatabase, candidates: string[]): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  const present = new Set(rows.map((r) => r.name));
  return candidates.filter((name) => present.has(name));
}

/** Column names of a table, in declaration order. */
export function tableColumns(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map((r) => r.name);
}
