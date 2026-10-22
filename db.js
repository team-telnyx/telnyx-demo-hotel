// Storage with the D1-style API (prepare → bind → all/first/run, batch), on:
//   - "sqldb-api": a Telnyx Edge SQL database over the REST API, when SQLDB_ID
//     is set (no binding, so the function deploys to every Edge site);
//   - "sqlite": a local node:sqlite file.
import fs from "node:fs";
import path from "node:path";

import { onEdge, setting } from "./settings.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  started_at TEXT NOT NULL,
  summary    TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_by_start ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS calls_by_user ON calls(user_id, started_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_messages (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_by_created ON sms_messages(created_at DESC);
CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_by_created ON contacts(created_at DESC);`;

const statements = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean);

class LocalStatement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new LocalStatement(this.db, this.sql, params); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params), meta: {} }; }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    return col ? (row?.[col] ?? null) : row;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
}

class LocalDb {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new LocalStatement(this.sqlite, sql); }
  async batch(stmts) {
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

// A Telnyx Edge SQL database over the REST API. Every statement is one HTTPS
// round trip, so callers keep reads cached (auth.js, concierge.js, email.js do).
const SQLDB_API = () => process.env.SQLDB_API_BASE || "https://api.telnyx.com/v2";

class RestStatement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new RestStatement(this.db, this.sql, params); }
  async all() {
    const r = await this.db.query(this.sql, this.params);
    return { results: r.results ?? [], meta: r.meta ?? {} };
  }
  async first(col) {
    const row = (await this.all()).results[0] ?? null;
    return col ? (row?.[col] ?? null) : row;
  }
  async run() {
    const { meta } = await this.all();
    return { results: [], meta };
  }
}

class RestDb {
  constructor(id, apiKey) { this.id = id; this.apiKey = apiKey; }
  prepare(sql) { return new RestStatement(this, sql); }
  async query(sql, params) {
    const res = await fetch(`${SQLDB_API()}/storage/sqldbs/${encodeURIComponent(this.id)}/actions/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(params.length ? { sql, params } : { sql }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = body.errors?.[0] || {};
      throw new Error(`SQL database ${res.status}: ${e.detail || e.title || "query failed"}`);
    }
    // One statement in, one result out; tolerate the array form too.
    return Array.isArray(body.data) ? body.data[0] ?? {} : body.data ?? {};
  }
  // Not atomic over REST: statements run one after another.
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

async function openLocal(file) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  return new LocalDb(sqlite);
}

export async function openDb(dataDir) {
  let db, engine;
  if (setting("SQLDB_ID")) {
    db = new RestDb(setting("SQLDB_ID"), setting("SQLDB_API_KEY") || setting("TELNYX_API_KEY"));
    engine = "sqldb-api";
  } else if (onEdge()) {
    throw new Error("TELNYXHOTEL_SQLDB_ID is not set");
  } else {
    db = await openLocal(path.join(dataDir, "telnyxhotel.db"));
    engine = "sqlite";
  }
  for (const sql of statements(SCHEMA)) await db.prepare(sql).run();
  return { db, engine };
}
