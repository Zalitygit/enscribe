import "./node-guard.js"; // must precede the better-sqlite3 import (fails fast on unsupported Node)
import { readFileSync, readdirSync, mkdirSync, openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type Database = BetterSqlite3.Database;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

// Apply every migrations/NNN_*.sql not yet recorded, in filename order. Files
// stay CREATE ... IF NOT EXISTS, so applying to a pre-existing DB is harmless;
// the _migrations table just prevents re-running an already-applied file.
// Each file's SQL and its _migrations row commit in ONE transaction, so a
// failing migration rolls back whole rather than half-applying unrecorded.
export function migrate(db: Database, dir = MIGRATIONS_DIR): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare(`SELECT name FROM _migrations`).all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const record = db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`);
  const now = new Date().toISOString();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(f, now);
    })();
  }
}

export function openDb(path: string): Database {
  // Ensure the parent directory exists for a file-based DB, so every entry point
  // (CLI, MCP server) can open a fresh path without pre-creating the dir.
  // Directories and the DB file this call creates are private (0700/0600), as
  // backup.ts does, rather than whatever the umask allows; SQLite gives the
  // -wal/-shm sidecars the DB file's mode. Existing dirs and files keep theirs,
  // so an operator-supplied shared parent is never chmod'ed.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    createPrivateFile(path);
  }
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  migrate(db);
  return db;
}

// Create `path` 0600 if it does not exist. The exclusive create is the check:
// two processes opening one missing path can both see it absent, and the one
// that loses gets EEXIST and opens the winner's file. Any other error throws.
export function createPrivateFile(path: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}
