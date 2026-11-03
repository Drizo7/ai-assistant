import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEval, type GoldenCase } from "../src/eval";
import { createApp } from "../src/server";
import { extractive, ROOT, setup, trainingsFetch, WED_10AM } from "./helpers";

function app(over: { adminToken?: string } = {}) {
  const { db, tenant, settings } = setup();
  const a = createApp({
    db,
    tenant,
    provider: extractive(),
    settings: { ...settings, adminToken: over.adminToken ?? "" },
    now: () => WED_10AM,
    fetchImpl: trainingsFetch,
  });
  return { a, db };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Parse SSE the way amt_website/composables/useRag.ts does. */
async function readSse(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")));
}

describe("medeorag-compatible API", () => {
  test("/chat/stream emits sources, chunks, then done, as the widget expects", async () => {
    const { a } = app();
    const res = await a.fetch(post("/chat/stream", { message: "How do I place an order?", history: [] }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(res);
    expect(Array.isArray(events[0]!.sources)).toBe(true);
    const chunks = events.filter((e) => typeof e.chunk === "string");
    expect(chunks.length).toBeGreaterThan(1);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ done: true, needs_human: false, route: "answered" });
    expect(typeof done.confidence).toBe("number");
    expect(Array.isArray(done.actions)).toBe(true);
    expect(typeof done.turn_id).toBe("string");
    expect(chunks.map((c) => c.chunk).join("")).toBe(done.answer as string);
  });

  test("/chat returns the one-shot shape", async () => {
    const { a } = app();
    const res = await a.fetch(post("/chat", { message: "How much are gloves?" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["answer", "sources", "num_sources", "confidence", "needs_human", "actions"]));
    expect(body.needs_human).toBe(true);
  });

  test("/chat rejects an empty message", async () => {
    const { a } = app();
    expect((await a.fetch(post("/chat", { message: "  " }))).status).toBe(400);
  });

  test("/search returns approved passages", async () => {
    const { a } = app();
    const res = (await (await a.fetch(post("/search", { query: "register health facility licence" }))).json()) as { metadata: { source_id: string } }[];
    expect(res[0]?.metadata.source_id).toBe("ordering-procedure");
  });

  test("/healthz reports index size", async () => {
    const { a } = app();
    const body = (await (await a.fetch(new Request("http://test/healthz"))).json()) as { status: string; index_size: number };
    expect(body.status).toBe("healthy");
    expect(body.index_size).toBeGreaterThan(0);
  });
});

describe("handoff and feedback", () => {
  test("handoff requires consent and a valid contact; team comes from the turn", async () => {
    const { a, db } = app();
    const chat = (await (await a.fetch(post("/chat", { message: "How much is a box of gloves?" }))).json()) as { turn_id: string };
    expect((await a.fetch(post("/handoff", { name: "Asha", contact: "+255712345678", consent: false }))).status).toBe(400);
    expect((await a.fetch(post("/handoff", { name: "Asha", contact: "not a contact", consent: true }))).status).toBe(400);
    const res = await a.fetch(post("/handoff", { name: "Asha", contact: "+255712345678", consent: true, turn_id: chat.turn_id }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ team: "sales", branch: "dar" });
    expect((db.query("SELECT COUNT(*) n FROM handoffs").get() as { n: number }).n).toBe(1);
  });

  test("feedback is stored against the turn", async () => {
    const { a, db } = app();
    const chat = (await (await a.fetch(post("/chat", { message: "How do I place an order?" }))).json()) as { turn_id: string };
    expect((await a.fetch(post("/feedback", { turn_id: chat.turn_id, value: 1 }))).status).toBe(200);
    expect((await a.fetch(post("/feedback", { turn_id: "nope", value: 1 }))).status).toBe(404);
    expect(db.query("SELECT feedback FROM turns WHERE id = ?").get(chat.turn_id)).toEqual({ feedback: 1 });
  });
});

describe("admin", () => {
  test("disabled without a token, 401 with a wrong one", async () => {
    expect((await app().a.fetch(new Request("http://test/admin/report"))).status).toBe(404);
    const { a } = app({ adminToken: "s3cret" });
    expect((await a.fetch(new Request("http://test/admin/report", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const ok = await a.fetch(new Request("http://test/admin/report?format=md", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("# Assistant report");
  });
});

test("demo golden set passes the gate with the extractive provider", async () => {
  const { db, tenant } = setup();
  const cases = JSON.parse(readFileSync(join(ROOT, "eval", "golden.demo.json"), "utf8")) as GoldenCase[];
  const summary = await runEval(cases, { db, tenant, provider: extractive(), streamMode: "buffered", now: () => WED_10AM, fetchImpl: trainingsFetch }, { threshold: 0.9 });
  const failed = summary.results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failures.join("; ")}`);
  expect(failed).toEqual([]);
  expect(summary.gatePassed).toBe(true);
});
