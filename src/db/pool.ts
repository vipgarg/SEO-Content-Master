import { Pool } from "pg";

let pool: Pool | undefined;

/** Shared connection pool, lazily created from DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
