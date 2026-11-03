/**
 * SQLite storage (Bun's built-in driver). One file holds everything:
 *
 *   sources   every version of every document, with its approval status
 *   chunks    passages of APPROVED source versions only, full-text indexed
 *   turns     one row per visitor question: route, reason, citations, feedback
 *   handoffs  requests for a person, with contact details and transcript
 *
 * Only approved, unexpired content ever reaches `chunks`, so retrieval cannot
 * return a draft even by mistake.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SourceStatus = "draft" | "approved" | "rejected" | "retired" | "superseded";

export interface SourceRow {
  id: string;
  version: number;
  title: string;
  type: string;
  url: string | null;
  owner: string;
  lang: string;
  review_by: string;
  status: SourceStatus;
  body: string;
  hash: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface ChunkHit {
  chunk_id: number;
  source_id: string;
  version: number;
  title: string;
  url: string | null;
  type: string;
  text: string;
  rank: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT NOT NULL,
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'faq',
  url         TEXT,
  owner       TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'en',
  review_by   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  body        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT,
  decided_by  TEXT,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, title, tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  question    TEXT NOT NULL,
  lang        TEXT NOT NULL,
  route       TEXT NOT NULL,
  reason      TEXT,
  team        TEXT,
  confidence  REAL NOT NULL,
  cited       TEXT NOT NULL DEFAULT '[]',
  provider    TEXT NOT NULL,
  latency_ms  INTEGER NOT NULL,
  feedback    INTEGER
);
CREATE INDEX IF NOT EXISTS turns_created ON turns(created_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL,
  branch      TEXT NOT NULL,
  team        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  transcript  TEXT NOT NULL,
  consent     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** Delete chat logs and closed handoffs older than the retention periods. */
export function applyRetention(db: Database, turnDays: number, handoffDays: number): { turns: number; handoffs: number } {
  const t = db.query("DELETE FROM turns WHERE created_at < datetime('now', ?)").run(`-${turnDays} days`);
  const h = db.query("DELETE FROM handoffs WHERE created_at < datetime('now', ?)").run(`-${handoffDays} days`);
  return { turns: t.changes, handoffs: h.changes };
}
