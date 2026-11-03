import { describe, expect, test, beforeEach } from "bun:test";
import { liveSourcesFor, localParts, openState, resetTrainingsCache, trainingsSource } from "../src/live";
import { setup, trainingsFetch } from "./helpers";

const { tenant } = setup({ approveAll: false });
const dar = tenant.branches.find((b) => b.id === "dar")!;
const tz = tenant.timezone;

describe("opening hours", () => {
  test("local time uses the tenant timezone", () => {
    // 2026-11-07 is a Saturday; 07:30 UTC = 10:30 in Dar es Salaam
    expect(localParts(new Date("2026-11-07T07:30:00Z"), tz)).toEqual({ date: "2026-11-07", weekday: "sat", minutes: 630 });
  });

  test("open on Saturday morning, closes at 13:00", () => {
    expect(openState(dar, new Date("2026-11-07T07:30:00Z"), tz)).toEqual({ open: true, nextOpening: null, closesAt: "13:00" });
  });

  test("closed Sunday, next opening Monday 08:00", () => {
    expect(openState(dar, new Date("2026-11-08T09:00:00Z"), tz)).toEqual({ open: false, nextOpening: "tomorrow at 08:00", closesAt: null });
  });

  test("closed dates skip to the next working day", () => {
    // Friday 25 Dec 2026 is closed; 26 Dec (Sat) is closed too -> Monday 28th
    const s = openState(dar, new Date("2026-12-25T07:00:00Z"), tz);
    expect(s.open).toBe(false);
    expect(s.nextOpening).toBe("Monday at 08:00");
  });

  test("hours and contacts are only offered once someone confirmed them", async () => {
    expect((await liveSourcesFor("are you open today?", tenant)).map((s) => s.id)).toEqual(["live-hours"]);
    const unconfirmed = { ...tenant, liveData: { ...tenant.liveData, branchFactsConfirmedBy: undefined } };
    expect(await liveSourcesFor("are you open today? where is the branch?", unconfirmed)).toEqual([]);
  });
});

describe("trainings", () => {
  beforeEach(() => resetTrainingsCache());

  test("lists upcoming trainings only", async () => {
    const src = await trainingsSource(tenant, new Date("2026-11-03T08:00:00Z"), trainingsFetch);
    expect(src?.text).toContain("Cold chain management: 2026-11-20 to 2026-11-21, Dar es Salaam");
    expect(src?.text).not.toContain("Past course");
  });

  test("site API failure yields no source instead of an error", async () => {
    const failing = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
    expect(await trainingsSource(tenant, new Date(), failing)).toBeNull();
  });
});
