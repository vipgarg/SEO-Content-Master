// Side-effect module: registers custom pg type parsers, then does
// nothing else. Import this once, early, for its effect — it mutates
// pg's global type-parser registry (shared process-wide across every
// Pool instance, not per-pool), so one import anywhere before the
// first query is enough.
//
// Why this exists: node-postgres returns BIGINT/BIGSERIAL columns as
// JS strings by default, not numbers — deliberately, since bigint can
// exceed Number.MAX_SAFE_INTEGER. Every id in this schema is
// BIGSERIAL. Without this, `pool.query<{ id: number }>(...)` lies —
// the TypeScript annotation says number, the runtime value is a
// string, and nothing catches the mismatch until two ids that "are
// the same" fail a `===` or Set/Map lookup because one came from a
// query result (string) and the other from, say, a JSON payload
// (real number). That's not hypothetical: it's exactly what
// findUnknownEvidenceReferences would have hit in production —
// Claude's real tool-call output returns genuine JSON numbers, so
// every legitimate claim would have been flagged as citing "unknown"
// evidence purely because the pack's ids, loaded from Postgres, were
// strings.
//
// IDs in this application (pages, evidence, claims, ...) will never
// realistically approach 2^53 — parsing them as JS numbers is safe.

import { types } from "pg";

const OID_INT8 = 20; // bigint / bigserial scalar

types.setTypeParser(OID_INT8, (value: string) => Number.parseInt(value, 10));
