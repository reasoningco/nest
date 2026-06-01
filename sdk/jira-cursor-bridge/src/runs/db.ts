import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type DB = Database.Database;

export function openDb(filePath: string): DB {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function runMigrations(db: DB, migrationsDir: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name),
  );
  const dir = resolve(migrationsDir);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const insert = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf-8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      insert.run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
