import { join } from "node:path";
import { approve, ingestDir } from "../src/content";
import { loadSettings, loadTenant, type Settings, type TenantConfig } from "../src/config";
import { openDb } from "../src/db";
import { ExtractiveProvider, type GenerateInput, type Provider } from "../src/llm";

export const ROOT = join(import.meta.dir, "..");

export const DEMO_APPROVED = [
  "ordering-procedure",
  "delivery-areas",
  "returns-policy",
  "about-us",
  "product-malaria-rdt",
  "trainings-general",
];

/** A Wednesday, 10:00 in Dar es Salaam (UTC+3). */
export const WED_10AM = new Date("2026-11-04T07:00:00Z");

export function setup(opts: { approveAll?: boolean; tenant?: Partial<TenantConfig> } = {}) {
  const db = openDb(":memory:");
  ingestDir(db, join(ROOT, "content", "demo"));
  if (opts.approveAll !== false) for (const id of DEMO_APPROVED) approve(db, id, "test");
  const tenant: TenantConfig = { ...loadTenant(ROOT, "demo"), ...opts.tenant };
  const settings: Settings = { ...loadSettings({ TENANT: "demo", DB_PATH: ":memory:" }), rootDir: ROOT };
  return { db, tenant, settings };
}

/** Provider that returns a fixed answer, to exercise the post-check. */
export class FixedProvider implements Provider {
  name = "fixed";
  calls: GenerateInput[] = [];
  constructor(private text: string) {}
  async *generate(input: GenerateInput): AsyncIterable<string> {
    this.calls.push(input);
    yield this.text;
  }
  async healthy() {
    return true;
  }
}

export class FailingProvider implements Provider {
  name = "failing";
  // eslint-disable-next-line require-yield
  async *generate(): AsyncIterable<string> {
    throw new Error("model unavailable");
  }
  async healthy() {
    return false;
  }
}

export const extractive = () => new ExtractiveProvider();

/** fetch stub for the trainings API (Pruvious paginate shape). */
export const trainingsFetch: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      records: [
        { title: "Cold chain management", start: "2026-11-20", end: "2026-11-21", location: { name: "Dar es Salaam" } },
        { title: "Past course", start: "2025-01-10", end: "2025-01-11" },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
