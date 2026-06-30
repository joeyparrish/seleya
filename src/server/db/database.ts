import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

// SQLite has no ADD COLUMN IF NOT EXISTS, and CREATE TABLE IF NOT EXISTS never
// alters an existing table, so columns added after a DB was first created need a
// guarded ALTER here. Values are backfilled from GitHub on the next refresh.
function migrate(db: Database.Database): void {
  if (!columnExists(db, "issue_labels", "color")) {
    db.exec("ALTER TABLE issue_labels ADD COLUMN color TEXT");
  }
}
