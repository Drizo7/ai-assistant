/**
 * Knowledge-base lifecycle: ingest -> review -> approve -> index -> expire.
 *
 * Source files are Markdown with a small front-matter block:
 *
 *   ---
 *   id: ordering-procedure
 *   title: How to place an order
 *   type: faq                 (faq | page | procedure | product | policy)
 *   owner: Sales              (who vouches for it)
 *   review_by: 2027-03-31     (after this date it stops being used)
 *   url: https://medeor.tz/... (optional, shown as the citation link)
 *   lang: en
 *   ---
 *   Body text...
 *
 * Ingesting never makes content live. A new or changed file becomes a new
 * DRAFT version; the previously approved version keeps serving until the
 * owner approves the new one.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceRow, SourceStatus } from "./db";

export interface ParsedSource {
  id: string;
  title: string;
  type: string;
  owner: string;
  review_by: string;
  url: string | null;
  lang: string;
  body: string;
}

const REQUIRED = ["id", "title", "owner", "review_by"] as const;

export function parseSourceFile(text: string, fileName = "<inline>"): ParsedSource {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${fileName}: missing front-matter block`);
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  for (const key of REQUIRED) {
    if (!meta[key]) throw new Error(`${fileName}: front-matter is missing "${key}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.review_by!)) {
    throw new Error(`${fileName}: review_by must be YYYY-MM-DD`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.id!)) {
    throw new Error(`${fileName}: id must be lowercase letters, digits and dashes`);
  }
  const body = match[2]!.trim();
  if (!body) throw new Error(`${fileName}: body is empty`);
  return {
    id: meta.id!,
    title: meta.title!,
    type: meta.type || "faq",
    owner: meta.owner!,
    review_by: meta.review_by!,
    url: meta.url || null,
    lang: meta.lang || "en",
    body,
  };
}

function hashOf(s: ParsedSource): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([s.title, s.type, s.owner, s.review_by, s.url, s.lang, s.body]))
    .digest("hex")
    .slice(0, 16);
}

export interface IngestResult {
  created: { id: string; version: number }[];
  unchanged: string[];
  errors: string[];
}

/** Store a source as a new draft version unless an identical version exists. */
export function ingestSource(db: Database, src: ParsedSource): { id: string; version: number } | null {
  const hash = hashOf(src);
  const latest = db
    .query("SELECT version, hash FROM sources WHERE id = ? ORDER BY version DESC LIMIT 1")
    .get(src.id) as { version: number; hash: string } | null;
  if (latest && latest.hash === hash) return null;
  const version = (latest?.version ?? 0) + 1;
  db.query(
    `INSERT INTO sources (id, version, title, type, url, owner, lang, review_by, status, body, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(src.id, version, src.title, src.type, src.url, src.owner, src.lang, src.review_by, src.body, hash);
  return { id: src.id, version };
}

/** Ingest every .md file under a directory (recursively). */
export function ingestDir(db: Database, dir: string): IngestResult {
  const result: IngestResult = { created: [], unchanged: [], errors: [] };
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      return statSync(p).isDirectory() ? walk(p) : name.endsWith(".md") && name.toLowerCase() !== "readme.md" ? [p] : [];
    });
  for (const file of walk(dir).sort()) {
    try {
      const src = parseSourceFile(readFileSync(file, "utf8"), file);
      const created = ingestSource(db, src);
      if (created) result.created.push(created);
      else result.unchanged.push(src.id);
    } catch (err) {
      result.errors.push((err as Error).message);
    }
  }
  return result;
}

/** Split a body into passages of roughly `max` characters on paragraph boundaries. */
export function chunkText(body: string, max = 700): string[] {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  let heading = "";
  for (const p of paras) {
    if (/^#{1,6}\s/.test(p) && !p.includes("\n")) {
      // A new section starts a new passage, so each passage stays on one topic.
      if (current) chunks.push(current);
      current = "";
      heading = p.replace(/^#+\s*/, "");
      continue;
    }
    const piece = heading ? `${heading}: ${p}` : p;
    if (current && current.length + piece.length + 2 > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function unindex(db: Database, sourceId: string): void {
  const rows = db.query("SELECT chunk_id FROM chunks WHERE source_id = ?").all(sourceId) as { chunk_id: number }[];
  const del = db.query("DELETE FROM chunks_fts WHERE rowid = ?");
  for (const r of rows) del.run(r.chunk_id);
  db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
}

function index(db: Database, row: SourceRow): number {
  const insChunk = db.query("INSERT INTO chunks (source_id, version, ord, text) VALUES (?, ?, ?, ?)");
  const insFts = db.query("INSERT INTO chunks_fts (rowid, text, title) VALUES (?, ?, ?)");
  const parts = chunkText(row.body);
  parts.forEach((text, i) => {
    const res = insChunk.run(row.id, row.version, i, text);
    insFts.run(Number(res.lastInsertRowid), text, row.title);
  });
  return parts.length;
}

export function getSource(db: Database, id: string, version?: number): SourceRow | null {
  return (
    version
      ? db.query("SELECT * FROM sources WHERE id = ? AND version = ?").get(id, version)
      : db.query("SELECT * FROM sources WHERE id = ? ORDER BY version DESC LIMIT 1").get(id)
  ) as SourceRow | null;
}

/**
 * Approve one version: it becomes the only indexed version of that source.
 * Any previously approved version is marked superseded.
 */
export function approve(db: Database, id: string, by: string, version?: number): SourceRow {
  const row = getSource(db, id, version);
  if (!row) throw new Error(`No source "${id}"${version ? ` version ${version}` : ""}`);
  if (row.status === "approved") return row;
  if (row.status !== "draft") throw new Error(`Source ${id} v${row.version} is ${row.status}; only drafts can be approved`);
  if (/\bTEMPLATE\.|\bTO CONFIRM\b/.test(`${row.title}\n${row.owner}\n${row.body}`)) {
    throw new Error(`Source ${id} v${row.version} still contains template text or "TO CONFIRM"; finish it before approving`);
  }
  if (row.review_by < today()) throw new Error(`Source ${id} v${row.version} has a past review_by date (${row.review_by}); update it first`);
  db.transaction(() => {
    db.query("UPDATE sources SET status = 'superseded' WHERE id = ? AND status = 'approved'").run(id);
    db.query("UPDATE sources SET status = 'approved', decided_at = datetime('now'), decided_by = ? WHERE id = ? AND version = ?").run(by, id, row.version);
    unindex(db, id);
    index(db, { ...row, status: "approved" });
  })();
  return getSource(db, id, row.version)!;
}

export function reject(db: Database, id: string, by: string, version?: number): SourceRow {
  const row = getSource(db, id, version);
  if (!row) throw new Error(`No source "${id}"`);
  if (row.status !== "draft") throw new Error(`Source ${id} v${row.version} is ${row.status}; only drafts can be rejected`);
  db.query("UPDATE sources SET status = 'rejected', decided_at = datetime('now'), decided_by = ? WHERE id = ? AND version = ?").run(by, id, row.version);
  return getSource(db, id, row.version)!;
}

/** Take a source out of service entirely (all versions). */
export function retire(db: Database, id: string, by: string): void {
  db.transaction(() => {
    db.query("UPDATE sources SET status = 'retired', decided_at = datetime('now'), decided_by = ? WHERE id = ? AND status = 'approved'").run(by, id);
    unindex(db, id);
  })();
}

/**
 * Remove sources past their review date from the index. Called on startup and
 * daily; retrieval also filters by date, so nothing expired is served even
 * between runs.
 */
export function expireSources(db: Database, on = today()): string[] {
  const rows = db.query("SELECT id FROM sources WHERE status = 'approved' AND review_by < ?").all(on) as { id: string }[];
  for (const r of rows) unindex(db, r.id);
  return rows.map((r) => r.id);
}

export function listSources(db: Database, status?: SourceStatus): SourceRow[] {
  return (
    status
      ? db.query("SELECT * FROM sources WHERE status = ? ORDER BY id, version").all(status)
      : db.query("SELECT * FROM sources ORDER BY id, version").all()
  ) as SourceRow[];
}

/** Approved sources whose review date is within `days` (or already past). */
export function dueForReview(db: Database, days = 30): SourceRow[] {
  return db
    .query("SELECT * FROM sources WHERE status = 'approved' AND review_by <= date('now', ?) ORDER BY review_by")
    .all(`+${days} days`) as SourceRow[];
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
