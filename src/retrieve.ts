/**
 * Keyword retrieval over approved passages (SQLite FTS5, BM25 ranking).
 *
 * BM25 scores are not comparable across questions, so the confidence used for
 * the "do we know this?" decision is COVERAGE: the share of the question's key
 * terms that appear in the best passage. It is crude but explainable, and the
 * golden test set tells us whether the threshold is right.
 */

import type { Database } from "bun:sqlite";
import type { ChunkHit } from "./db";
import { today } from "./content";

const STOPWORDS = new Set(
  (
    // English
    "a about above after again all am an and any are as at be because been before being below between both but by can could " +
    "did do does doing down during each few for from further get got had has have having he her here hers him his how i if in " +
    "into is it its itself just know let like may me might more most must my myself need no nor not now of off on once only or " +
    "other our ours out over own please same she should so some such tell than thank thanks that the their them then there " +
    "these they this those through to too under until up very want was we were what when where which while who whom why will " +
    "with would you your yours hi hello hey dear sir madam " +
    // Swahili function words
    "na ya wa za la kwa ni je mimi wewe yeye sisi nyinyi wao hii hiyo huu hizo kama lakini au pia tafadhali naomba habari asante sana"
  ).split(/\s+/),
);

export function keyTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

/** Crude stem for coverage matching: first 5 letters catch plural/tense variants. */
const stem = (t: string) => (t.length > 5 ? t.slice(0, 5) : t);

export function coverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const hay = text.toLowerCase();
  const hit = terms.filter((t) => hay.includes(stem(t))).length;
  return hit / terms.length;
}

export interface RetrievedPassage extends ChunkHit {
  coverage: number;
}

export interface RetrievalResult {
  terms: string[];
  passages: RetrievedPassage[];
  /** Coverage of the best passage, 0-1. */
  confidence: number;
}

export function retrieve(db: Database, question: string, topK = 4, type?: string): RetrievalResult {
  const terms = keyTerms(question);
  if (!terms.length) return { terms, passages: [], confidence: 0 };
  // Quote every term so FTS5 syntax characters in visitor text can't break the
  // query, and match by prefix of the crude stem: the porter stemmer maps
  // "deliver" and "delivery" to different roots, a 5-letter prefix does not.
  const match = terms.map((t) => `"${stem(t)}"*`).join(" OR ");
  const rows = db
    .query(
      `SELECT c.chunk_id, c.source_id, c.version, s.title, s.url, s.type, c.text, bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.chunk_id = chunks_fts.rowid
       JOIN sources s ON s.id = c.source_id AND s.version = c.version
       WHERE chunks_fts MATCH ?
         AND s.status = 'approved'
         AND s.review_by >= ?
         ${type ? "AND s.type = ?" : ""}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...(type ? [match, today(), type, topK * 3] : [match, today(), topK * 3])) as ChunkHit[];

  const passages = rows
    .map((r) => ({ ...r, coverage: coverage(terms, `${r.title} ${r.text}`) }))
    // BM25 first, coverage as tie-breaker; then keep the best topK
    .sort((a, b) => b.coverage - a.coverage || a.rank - b.rank)
    .slice(0, topK);

  return { terms, passages, confidence: passages[0]?.coverage ?? 0 };
}
