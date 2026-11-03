import { describe, expect, test } from "bun:test";
import { approve, chunkText, expireSources, ingestSource, parseSourceFile, reject, retire } from "../src/content";
import { openDb } from "../src/db";
import { retrieve } from "../src/retrieve";
import { setup } from "./helpers";

const file = (body: string, extra = "") => `---
id: opening-test
title: Test source
owner: Tester
review_by: 2099-01-01
${extra}---
${body}`;

describe("content lifecycle", () => {
  test("drafts are never retrievable; approval makes them live", () => {
    const db = openDb(":memory:");
    ingestSource(db, parseSourceFile(file("Our depot stocks laboratory reagents.")));
    expect(retrieve(db, "laboratory reagents").passages).toHaveLength(0);
    approve(db, "opening-test", "Owner");
    expect(retrieve(db, "laboratory reagents").passages[0]?.source_id).toBe("opening-test");
  });

  test("a changed file becomes a new draft; the approved version keeps serving until re-approved", () => {
    const db = openDb(":memory:");
    ingestSource(db, parseSourceFile(file("Version one mentions reagents.")));
    approve(db, "opening-test", "Owner");
    const v2 = ingestSource(db, parseSourceFile(file("Version two mentions reagents and gloves.")));
    expect(v2).toEqual({ id: "opening-test", version: 2 });
    expect(retrieve(db, "reagents").passages[0]?.version).toBe(1);
    approve(db, "opening-test", "Owner");
    const hits = retrieve(db, "reagents").passages;
    expect(hits.map((h) => h.version)).toEqual([2]);
    const statuses = db.query("SELECT version, status FROM sources ORDER BY version").all();
    expect(statuses).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "approved" },
    ]);
  });

  test("re-ingesting an identical file creates nothing", () => {
    const db = openDb(":memory:");
    const src = parseSourceFile(file("Same text."));
    expect(ingestSource(db, src)).not.toBeNull();
    expect(ingestSource(db, src)).toBeNull();
  });

  test("templates and TO CONFIRM text cannot be approved", () => {
    const db = openDb(":memory:");
    ingestSource(db, parseSourceFile(file("TEMPLATE. Replace this paragraph.")));
    expect(() => approve(db, "opening-test", "Owner")).toThrow(/template/);
  });

  test("past review date: cannot approve, and approved content expires from retrieval", () => {
    const db = openDb(":memory:");
    ingestSource(db, parseSourceFile(file("Expired reagents text.").replace("2099-01-01", "2020-01-01")));
    expect(() => approve(db, "opening-test", "Owner")).toThrow(/review_by/);

    const db2 = openDb(":memory:");
    ingestSource(db2, parseSourceFile(file("Reagents text.")));
    approve(db2, "opening-test", "Owner");
    db2.query("UPDATE sources SET review_by = '2020-01-01'").run();
    expect(retrieve(db2, "reagents").passages).toHaveLength(0); // filtered at query time
    expect(expireSources(db2)).toEqual(["opening-test"]);
    expect((db2.query("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n).toBe(0);
  });

  test("reject and retire", () => {
    const { db } = setup();
    retire(db, "about-us", "Owner");
    expect(retrieve(db, "fictional wholesaler").passages.some((p) => p.source_id === "about-us")).toBe(false);
    expect(() => reject(db, "about-us", "Owner")).toThrow(/only drafts/);
  });

  test("front-matter validation", () => {
    expect(() => parseSourceFile("no front matter")).toThrow(/front-matter/);
    expect(() => parseSourceFile(file("x").replace("owner: Tester\n", ""))).toThrow(/owner/);
    expect(() => parseSourceFile(file("x").replace("2099-01-01", "next year"))).toThrow(/YYYY-MM-DD/);
  });

  test("chunking starts a new passage at each heading", () => {
    const chunks = chunkText("# A\n\nAlpha text.\n\n# B\n\nBeta text.");
    expect(chunks).toEqual(["A: Alpha text.", "B: Beta text."]);
  });

  test("FTS syntax in visitor text cannot break the query", () => {
    const { db } = setup();
    expect(() => retrieve(db, 'order" OR (NEAR * "')).not.toThrow();
  });
});
