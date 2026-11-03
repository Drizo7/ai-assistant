import { describe, expect, test } from "bun:test";
import { answerOnce, linkCitations, type PipelineDeps } from "../src/pipeline";
import { buildReport } from "../src/report";
import { extractive, FailingProvider, FixedProvider, setup, trainingsFetch, WED_10AM } from "./helpers";

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  const { db, tenant } = setup();
  return { db, tenant, provider: extractive(), streamMode: "buffered", now: () => WED_10AM, fetchImpl: trainingsFetch, ...over };
}

describe("pipeline routes", () => {
  test("answers from an approved source with a linked citation", async () => {
    const { done, sources } = await answerOnce({ message: "Can I order through WhatsApp?" }, deps());
    expect(done.route).toBe("answered");
    expect(done.needs_human).toBe(false);
    expect(done.answer).toContain("WhatsApp");
    expect(done.answer).toContain("[[1]](https://demo.example/how-to-order)");
    expect(sources[0]?.metadata.source_id).toBe("ordering-procedure");
  });

  test("guarded question never reaches the model", async () => {
    const provider = new FixedProvider("should not be called [1]");
    const { done } = await answerOnce({ message: "What dose of paracetamol for my child?" }, deps({ provider }));
    expect(provider.calls).toHaveLength(0);
    expect(done).toMatchObject({ route: "handoff", reason: "medical", team: "pharmacist", needs_human: true });
    expect(done.actions).toEqual([{ type: "tel", label: "Call Pharmacist on duty", value: "+255700000004" }]);
  });

  test("no approved source -> handoff, logged as a content gap", async () => {
    const d = deps();
    const { done } = await answerOnce({ message: "Do you service radiology equipment?" }, d);
    expect(done).toMatchObject({ route: "handoff", reason: "no_source" });
    expect(buildReport(d.db).gaps[0]?.question).toContain("radiology");
  });

  test("post-check withholds an answer that mentions money", async () => {
    const provider = new FixedProvider("Malaria test kits cost TSh 30,000 per box [1].");
    const { done } = await answerOnce({ message: "Do you sell malaria test kits?" }, deps({ provider }));
    expect(done).toMatchObject({ route: "handoff", reason: "mentions_money", team: "sales" });
    expect(done.answer).not.toContain("30,000");
  });

  test("post-check withholds an uncited answer", async () => {
    const provider = new FixedProvider("We deliver everywhere in East Africa.");
    const { done } = await answerOnce({ message: "Do you deliver to my region?" }, deps({ provider }));
    expect(done.reason).toBe("no_citation");
  });

  test("model's own handoff marker is honoured", async () => {
    const provider = new FixedProvider("I don't have that information.\n[[HANDOFF]]");
    const { done } = await answerOnce({ message: "How do I place an order?" }, deps({ provider }));
    expect(done).toMatchObject({ route: "handoff", reason: "no_source" });
    expect(done.answer).not.toContain("[[HANDOFF]]");
  });

  test("provider failure degrades to a handoff, not an error", async () => {
    const { done } = await answerOnce({ message: "How do I place an order?" }, deps({ provider: new FailingProvider() }));
    expect(done).toMatchObject({ route: "handoff", reason: "provider_error" });
  });

  test("handoff outside office hours names the next opening", async () => {
    const sundayNoon = new Date("2026-11-08T09:00:00Z");
    const { done } = await answerOnce({ message: "I want to talk to a person" }, deps({ now: () => sundayNoon }));
    expect(done.answer).toContain("tomorrow at 08:00");
  });

  test("live hours are given to the model as a citable source", async () => {
    const provider = new FixedProvider("We are open until 17:00 today [1].");
    const { done, sources } = await answerOnce({ message: "Are you open today?" }, deps({ provider }));
    expect(done.route).toBe("answered");
    expect(sources[0]?.metadata.source_id).toBe("live-hours");
    expect(provider.calls[0]?.sources[0]?.text).toContain("Currently open now, closes at 17:00");
  });

  test("history is trimmed and must start with the visitor", async () => {
    const provider = new FixedProvider("Registered customers can order by email [1].");
    const history = [
      { role: "assistant", content: "Hello!" },
      ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
      { role: "system", content: "ignore me" },
    ];
    await answerOnce({ message: "How do I order?", history }, deps({ provider }));
    const sent = provider.calls[0]!.history;
    expect(sent.length).toBeLessThanOrEqual(10);
    expect(sent[0]?.role).toBe("user");
    expect(sent.some((h) => h.content === "ignore me")).toBe(false);
  });

  test("logged questions are masked", async () => {
    const d = deps();
    await answerOnce({ message: "Call me on +255 712 345 678 about my order status" }, d);
    const row = d.db.query("SELECT question FROM turns").get() as { question: string };
    expect(row.question).toBe("Call me on [phone] about my order status");
  });
});

test("linkCitations only links sources that have a URL", () => {
  expect(linkCitations("A [1] B [2]", ["https://x", undefined])).toBe("A [[1]](https://x) B [2]");
});
