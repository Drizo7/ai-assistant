/**
 * Weekly report for staff: what people asked, what the assistant could not
 * answer (= content to write), why it handed off, and how visitors rated it.
 */

import type { Database } from "bun:sqlite";
import { dueForReview } from "./content";
import { keyTerms } from "./retrieve";

export interface Report {
  from: string;
  to: string;
  totals: { turns: number; answered: number; handoff: number; refused: number; thumbsUp: number; thumbsDown: number };
  topQuestions: { topic: string; count: number; example: string }[];
  gaps: { question: string; count: number }[];
  handoffsByReason: { reason: string; count: number }[];
  mostCited: { source: string; count: number }[];
  dueForReview: { id: string; title: string; owner: string; review_by: string }[];
  medianLatencyMs: number | null;
}

/** Group questions by their two most informative terms (good enough for a weekly list). */
function topicOf(question: string): string {
  const terms = keyTerms(question).filter((t) => t.length > 2);
  return terms.slice(0, 2).sort().join(" + ") || "(other)";
}

export function buildReport(db: Database, days = 7): Report {
  const since = `-${days} days`;
  const rows = db
    .query("SELECT question, route, reason, cited, feedback, latency_ms, created_at FROM turns WHERE created_at >= datetime('now', ?) ORDER BY created_at")
    .all(since) as { question: string; route: string; reason: string | null; cited: string; feedback: number | null; latency_ms: number; created_at: string }[];

  const count = <T extends string>(xs: T[]) => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const topics = new Map<string, { count: number; example: string }>();
  for (const r of rows) {
    const t = topicOf(r.question);
    const cur = topics.get(t);
    topics.set(t, { count: (cur?.count ?? 0) + 1, example: cur?.example ?? r.question });
  }

  const gapQuestions = rows.filter((r) => r.reason === "no_source").map((r) => r.question.toLowerCase().replace(/\s+/g, " ").trim());
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);

  return {
    from: (db.query("SELECT date('now', ?) d").get(since) as { d: string }).d,
    to: (db.query("SELECT date('now') d").get() as { d: string }).d,
    totals: {
      turns: rows.length,
      answered: rows.filter((r) => r.route === "answered").length,
      handoff: rows.filter((r) => r.route === "handoff").length,
      refused: rows.filter((r) => r.route === "refused").length,
      thumbsUp: rows.filter((r) => r.feedback === 1).length,
      thumbsDown: rows.filter((r) => r.feedback === -1).length,
    },
    topQuestions: [...topics.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([topic, v]) => ({ topic, count: v.count, example: v.example })),
    gaps: count(gapQuestions).slice(0, 20).map(([question, c]) => ({ question, count: c })),
    handoffsByReason: count(rows.filter((r) => r.route !== "answered").map((r) => r.reason ?? "unknown")).map(([reason, c]) => ({ reason, count: c })),
    mostCited: count(rows.flatMap((r) => JSON.parse(r.cited) as string[])).slice(0, 10).map(([source, c]) => ({ source, count: c })),
    dueForReview: dueForReview(db, 30).map((s) => ({ id: s.id, title: s.title, owner: s.owner, review_by: s.review_by })),
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
  };
}

export function reportToMarkdown(r: Report): string {
  const pct = (n: number) => (r.totals.turns ? `${Math.round((n / r.totals.turns) * 100)}%` : "-");
  const rated = r.totals.thumbsUp + r.totals.thumbsDown;
  const lines = [
    `# Assistant report ${r.from} to ${r.to}`,
    "",
    `Questions: ${r.totals.turns} | answered ${r.totals.answered} (${pct(r.totals.answered)}) | handed off ${r.totals.handoff} (${pct(r.totals.handoff)}) | refused ${r.totals.refused}`,
    `Visitor rating: ${rated ? `${Math.round((r.totals.thumbsUp / rated) * 100)}% thumbs up (${rated} rated)` : "no ratings yet"} | median response ${r.medianLatencyMs ?? "-"} ms`,
    "",
    "## Top questions",
    ...r.topQuestions.map((t) => `- ${t.count} x ${t.topic} (e.g. "${t.example}")`),
    "",
    "## Unanswered: write an FAQ for these",
    ...(r.gaps.length ? r.gaps.map((g) => `- ${g.count} x "${g.question}"`) : ["- none"]),
    "",
    "## Handoffs by reason",
    ...(r.handoffsByReason.length ? r.handoffsByReason.map((h) => `- ${h.reason}: ${h.count}`) : ["- none"]),
    "",
    "## Most cited sources",
    ...(r.mostCited.length ? r.mostCited.map((c) => `- ${c.source}: ${c.count}`) : ["- none"]),
    "",
    "## Sources due for review (next 30 days)",
    ...(r.dueForReview.length ? r.dueForReview.map((s) => `- ${s.review_by} ${s.id} "${s.title}" (owner: ${s.owner})`) : ["- none"]),
  ];
  return lines.join("\n");
}
