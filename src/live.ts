/**
 * Live facts, read at question time instead of being copied into the
 * knowledge base: opening hours (tenant file) and upcoming trainings (the
 * site's own Pruvious API). They are handed to the model as extra numbered
 * sources, so they are cited like any other source.
 */

import { WEEKDAYS, type Branch, type TenantConfig, type Weekday } from "./config";

export interface LiveSource {
  id: string;
  title: string;
  url: string | null;
  text: string;
}

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/** Local date/time parts in the tenant's timezone. */
export function localParts(now: Date, timezone: string): { date: string; weekday: Weekday; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const weekday = String(p.weekday).toLowerCase().slice(0, 3) as Weekday;
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface OpenState {
  open: boolean;
  /** Human-readable next opening, e.g. "Monday 08:00", when closed. */
  nextOpening: string | null;
  closesAt: string | null;
}

export function openState(branch: Branch, now: Date, timezone: string): OpenState {
  const { date, weekday, minutes } = localParts(now, timezone);
  const closed = new Set(branch.closedDates ?? []);
  if (!closed.has(date)) {
    for (const [from, to] of branch.hours[weekday] ?? []) {
      if (minutes >= toMin(from) && minutes < toMin(to)) return { open: true, nextOpening: null, closesAt: to };
    }
  }
  // Search forward up to two weeks for the next opening.
  const startIdx = WEEKDAYS.indexOf(weekday);
  for (let i = 0; i <= 14; i++) {
    const day = WEEKDAYS[(startIdx + i) % 7]!;
    const d = addDays(date, i);
    if (closed.has(d)) continue;
    for (const [from] of branch.hours[day] ?? []) {
      if (i === 0 && toMin(from) <= minutes) continue;
      const label = i === 0 ? "today" : i === 1 ? "tomorrow" : DAY_NAMES[day];
      return { open: false, nextOpening: `${label} at ${from}`, closesAt: null };
    }
  }
  return { open: false, nextOpening: null, closesAt: null };
}

export function describeHours(branch: Branch): string {
  const order: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return order
    .map((d) => {
      const iv = branch.hours[d];
      return `${DAY_NAMES[d]}: ${iv?.length ? iv.map(([a, b]) => `${a}-${b}`).join(", ") : "closed"}`;
    })
    .join("; ");
}

export function hoursSource(tenant: TenantConfig, now: Date): LiveSource {
  const lines = tenant.branches.map((b) => {
    const s = openState(b, now, tenant.timezone);
    const status = s.open ? `open now, closes at ${s.closesAt}` : `closed now${s.nextOpening ? `, opens ${s.nextOpening}` : ""}`;
    const holidays = b.closedDates?.length ? ` Closed on: ${b.closedDates.join(", ")}.` : "";
    return `${b.name}${b.region ? ` (${b.region})` : ""}: ${describeHours(b)}. Currently ${status}.${holidays}`;
  });
  return {
    id: "live-hours",
    title: "Opening hours (live)",
    url: null,
    text: `Times are local (${tenant.timezone}).\n${lines.join("\n")}`,
  };
}

export function contactsSource(tenant: TenantConfig): LiveSource {
  const lines = tenant.branches.map((b) =>
    [b.name, b.region, b.phone && `phone ${b.phone}`, b.whatsapp && `WhatsApp ${b.whatsapp}`, b.email && `email ${b.email}`]
      .filter(Boolean)
      .join(", "),
  );
  return { id: "live-contacts", title: "Branch contacts", url: `${tenant.siteUrl}/about-us`, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Trainings — Pruvious paginated collection: { records: [...] }
// ---------------------------------------------------------------------------

interface TrainingRecord {
  title?: string;
  start?: number | string;
  end?: number | string;
  starttime?: number | string;
  endtime?: number | string;
  location?: { name?: string; region?: string } | string | null;
}

let trainingsCache: { at: number; items: TrainingRecord[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

function asDate(v: number | string | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function fetchTrainings(url: string, fetchImpl: typeof fetch = fetch): Promise<TrainingRecord[]> {
  if (trainingsCache && Date.now() - trainingsCache.at < CACHE_MS) return trainingsCache.items;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`trainings API ${res.status}`);
  const body = (await res.json()) as { records?: TrainingRecord[] } | TrainingRecord[];
  const items = Array.isArray(body) ? body : (body.records ?? []);
  trainingsCache = { at: Date.now(), items };
  return items;
}

export function resetTrainingsCache(): void {
  trainingsCache = null;
}

export async function trainingsSource(tenant: TenantConfig, now: Date, fetchImpl?: typeof fetch): Promise<LiveSource | null> {
  if (!tenant.liveData.trainingsUrl) return null;
  let items: TrainingRecord[];
  try {
    items = await fetchTrainings(tenant.liveData.trainingsUrl, fetchImpl);
  } catch {
    return null; // site API down: the assistant says it can't see dates and offers a person
  }
  const todayIso = now.toISOString().slice(0, 10);
  const upcoming = items
    .map((t) => ({ t, start: asDate(t.start), end: asDate(t.end) }))
    .filter((x) => x.start && (x.end ?? x.start)! >= todayIso)
    .sort((a, b) => a.start!.localeCompare(b.start!))
    .slice(0, 6);
  const text = upcoming.length
    ? upcoming
        .map(({ t, start, end }) => {
          const loc = typeof t.location === "string" ? t.location : t.location?.name;
          return `${t.title ?? "Training"}: ${start}${end && end !== start ? ` to ${end}` : ""}${loc ? `, ${loc}` : ""}`;
        })
        .join("\n")
    : "No upcoming trainings are listed on the website right now.";
  return { id: "live-trainings", title: "Upcoming trainings (live from website)", url: `${tenant.siteUrl}/trainings`, text };
}

const HOURS_INTENT = /\b(open|opening|close|closing|closed|hours?|time|today|tomorrow|weekend|saturday|sunday|holiday|now|saa|kufungua|kufunga|jumamosi|jumapili|leo|kesho)\b/i;
const CONTACT_INTENT = /\b(where|location|located|address|branch|branches|office|contact|phone|number|email|whatsapp|call|visit|wapi|tawi|ofisi|mawasiliano|simu)\b/i;
const TRAINING_INTENT = /\b(training|trainings|course|courses|workshop|seminar|mafunzo|semina)\b/i;

/** Live sources relevant to this question. */
export async function liveSourcesFor(question: string, tenant: TenantConfig, now = new Date(), fetchImpl?: typeof fetch): Promise<LiveSource[]> {
  const out: LiveSource[] = [];
  const confirmed = Boolean(tenant.liveData.branchFactsConfirmedBy);
  if (confirmed && HOURS_INTENT.test(question)) out.push(hoursSource(tenant, now));
  if (confirmed && CONTACT_INTENT.test(question)) out.push(contactsSource(tenant));
  if (TRAINING_INTENT.test(question)) {
    const t = await trainingsSource(tenant, now, fetchImpl);
    if (t) out.push(t);
  }
  return out;
}
