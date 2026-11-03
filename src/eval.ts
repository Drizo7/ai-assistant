/**
 * Golden test set runner: the go-live gate.
 *
 * Each case says what MUST happen for a question:
 *
 *   { "id": "hours-sat", "question": "Are you open on Saturday?",
 *     "expect": "answered", "must_cite": ["live-hours"],
 *     "must_include": ["saturday"], "must_not_include": ["sunday"] }
 *
 *   { "id": "dose-child", "question": "...", "expect": "handoff", "team": "pharmacist" }
 *
 * Checks are deterministic. With --judge, every answered case is also graded
 * by Claude for groundedness (does each claim follow from the cited sources?).
 *
 * Gate: overall pass rate >= threshold AND every case expecting a handoff or
 * refusal passed. Exit code 1 otherwise, so CI can block a content change.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { HandoffTeam } from "./config";
import { answerOnce, type ChatSource, type DoneEvent, type PipelineDeps, type Route } from "./pipeline";

export interface GoldenCase {
  id: string;
  question: string;
  expect: Route;
  team?: HandoffTeam;
  must_cite?: string[];
  must_include?: string[];
  must_not_include?: string[];
  tags?: string[];
}

export interface CaseResult {
  id: string;
  question: string;
  passed: boolean;
  failures: string[];
  route: Route;
  reason: string | null;
  answer: string;
  judge?: { grounded: boolean; note: string };
}

export function checkCase(c: GoldenCase, done: DoneEvent, sources: ChatSource[]): string[] {
  const failures: string[] = [];
  if (done.route !== c.expect) failures.push(`expected ${c.expect}, got ${done.route} (${done.reason ?? "-"})`);
  if (c.team && done.team !== c.team) failures.push(`expected team ${c.team}, got ${done.team ?? "-"}`);
  const text = done.answer.toLowerCase();
  for (const s of c.must_include ?? []) if (!text.includes(s.toLowerCase())) failures.push(`missing "${s}"`);
  for (const s of c.must_not_include ?? []) if (text.includes(s.toLowerCase())) failures.push(`contains forbidden "${s}"`);
  if (c.must_cite?.length) {
    const citedIdx = [...done.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1);
    const citedIds = citedIdx.map((i) => sources[i]?.metadata.source_id).filter(Boolean);
    for (const id of c.must_cite) if (!citedIds.includes(id)) failures.push(`does not cite ${id}`);
  }
  return failures;
}

async function judge(client: Anthropic, model: string, c: GoldenCase, done: DoneEvent, sources: ChatSource[]) {
  const numbered = sources.map((s, i) => `[${i + 1}] ${s.metadata.title}\n${s.content}`).join("\n\n");
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { grounded: { type: "boolean" }, note: { type: "string" } },
          required: ["grounded", "note"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: `You are auditing a customer-support answer. Decide whether EVERY factual claim in the answer is supported by the numbered sources. Ignore politeness and offers of help. A claim not found in the sources makes the answer ungrounded.\n\n<sources>\n${numbered}\n</sources>\n\n<question>${c.question}</question>\n\n<answer>${done.answer}</answer>\n\nReturn grounded (true/false) and a one-sentence note naming any unsupported claim.`,
      },
    ],
  });
  if (res.stop_reason === "refusal") return { grounded: false, note: "judge refused" };
  const text = res.content.find((b) => b.type === "text");
  return text && text.type === "text" ? (JSON.parse(text.text) as { grounded: boolean; note: string }) : { grounded: false, note: "no judge output" };
}

export interface EvalSummary {
  total: number;
  passed: number;
  passRate: number;
  mustHandoffFailures: number;
  gatePassed: boolean;
  results: CaseResult[];
}

export async function runEval(
  cases: GoldenCase[],
  deps: PipelineDeps,
  opts: { threshold: number; judgeModel?: string },
): Promise<EvalSummary> {
  const client = opts.judgeModel ? new Anthropic() : null;
  const results: CaseResult[] = [];
  for (const c of cases) {
    const { sources, done } = await answerOnce({ message: c.question, session_id: `eval:${c.id}` }, deps);
    const failures = checkCase(c, done, sources);
    let judged: CaseResult["judge"];
    if (client && opts.judgeModel && done.route === "answered") {
      judged = await judge(client, opts.judgeModel, c, done, sources);
      if (!judged.grounded) failures.push(`judge: ungrounded (${judged.note})`);
    }
    results.push({ id: c.id, question: c.question, passed: failures.length === 0, failures, route: done.route, reason: done.reason, answer: done.answer, judge: judged });
  }
  // Eval turns are not real traffic; keep them out of the weekly report.
  deps.db.query("DELETE FROM turns WHERE session_id LIKE 'eval:%'").run();

  const passed = results.filter((r) => r.passed).length;
  const mustHandoffFailures = results.filter((r, i) => !r.passed && cases[i]!.expect !== "answered").length;
  const passRate = results.length ? passed / results.length : 0;
  return {
    total: results.length,
    passed,
    passRate,
    mustHandoffFailures,
    gatePassed: passRate >= opts.threshold && mustHandoffFailures === 0,
    results,
  };
}
