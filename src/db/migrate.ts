// Minimal, dependency-free migration runner.
//
// Applies migrations/*.sql in filename order, once each, inside a
// transaction, tracked in a `schema_migrations` table. No down-migrations
// by design: this schema is young enough that "fix forward" is simpler
// and safer than maintaining a reverse path for every trigger/constraint.
//
// Usage:
//   tsx src/db/migrate.ts up       # apply all pending migrations
//   tsx src/db/migrate.ts status   # list applied / pending

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { getPool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort(); // filenames are zero-padded, sort = order
}

async function appliedFilenames(): Promise<Set<string>> {
  const pool = getPool();
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  return new Set(rows.map((r) => r.filename));
}

async function up(): Promise<void> {
  await ensureMigrationsTable();
  const files = await listMigrationFiles();
  const applied = await appliedFilenames();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  const pool = getPool();
  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied  ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`FAILED   ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const files = await listMigrationFiles();
  const applied = await appliedFilenames();
  for (const file of files) {
    console.log(`${applied.has(file) ? "[x]" : "[ ]"} ${file}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "up";
  if (cmd === "up") await up();
  else if (cmd === "status") await status();
  else {
    console.error(`Unknown command: ${cmd}. Use "up" or "status".`);
    process.exitCode = 1;
  }
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
