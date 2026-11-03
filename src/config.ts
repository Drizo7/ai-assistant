/**
 * Runtime settings (from the environment) and the tenant file.
 *
 * A tenant is one organisation using the assistant: its branches, opening
 * hours, handoff destinations and guard settings. Facts that change (hours,
 * contacts) live here, never in the knowledge base, so the assistant cannot
 * quote a stale copy of them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Opening intervals per weekday, "HH:MM" local time. Missing day = closed. */
export type WeeklyHours = Partial<Record<Weekday, [string, string][]>>;

export interface Contact {
  label: string;
  whatsapp?: string;
  phone?: string;
  email?: string;
}

export interface Branch extends Contact {
  id: string;
  name: string;
  region?: string;
  hours: WeeklyHours;
  /** ISO dates (YYYY-MM-DD) the branch is closed. */
  closedDates?: string[];
}

export type HandoffTeam =
  | "general"
  | "sales"
  | "pharmacist"
  | "customer_service";

export interface TenantConfig {
  id: string;
  name: string;
  assistantName: string;
  siteUrl: string;
  privacyPolicyUrl: string;
  timezone: string;
  /** Branch used when the visitor has not chosen one. */
  defaultBranch: string;
  branches: Branch[];
  /** Who receives each kind of handoff. */
  teams: Record<HandoffTeam, Contact>;
  /** When false, questions detected as Swahili get a short Swahili reply and a handoff. */
  swahiliAnswers: boolean;
  retrieval: {
    topK: number;
    /** Share of the question's key terms the best passage must contain (0-1). */
    minCoverage: number;
  };
  liveData: {
    /**
     * Branch hours and contacts are only given to the assistant once a named
     * person has confirmed them (Phase 0, section 5). Until then, hours and
     * contact questions hand off instead of risking a wrong answer.
     */
    branchFactsConfirmedBy?: string;
    /** Pruvious trainings endpoint, e.g. https://medeor.tz/api/trainings */
    trainingsUrl?: string;
  };
}

export interface Settings {
  tenant: string;
  dbPath: string;
  port: number;
  provider: "extractive" | "anthropic" | "ollama";
  anthropicModel: string;
  anthropicEffort: "low" | "medium" | "high" | "xhigh" | "max";
  ollamaUrl: string;
  ollamaModel: string;
  adminToken: string;
  handoffWebhookUrl: string;
  streamMode: "buffered" | "live";
  rootDir: string;
}

const ROOT = join(import.meta.dir, "..");

export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  const provider = (env.LLM_PROVIDER ?? "extractive") as Settings["provider"];
  if (!["extractive", "anthropic", "ollama"].includes(provider)) {
    throw new Error(`LLM_PROVIDER must be extractive, anthropic or ollama (got "${provider}")`);
  }
  return {
    tenant: env.TENANT ?? "amt",
    dbPath: env.DB_PATH ?? join(ROOT, "data", "assistant.sqlite"),
    port: Number(env.PORT ?? 8000),
    provider,
    anthropicModel: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    anthropicEffort: (env.ANTHROPIC_EFFORT || "low") as Settings["anthropicEffort"],
    ollamaUrl: env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "llama3.1:8b",
    adminToken: env.ADMIN_TOKEN ?? "",
    handoffWebhookUrl: env.HANDOFF_WEBHOOK_URL ?? "",
    streamMode: env.STREAM_MODE === "live" ? "live" : "buffered",
    rootDir: ROOT,
  };
}

export function tenantPath(rootDir: string, tenant: string): string {
  return join(rootDir, "config", "tenants", `${tenant}.json`);
}

export function contentDir(rootDir: string, tenant: string): string {
  return join(rootDir, "content", tenant);
}

export function loadTenant(rootDir: string, tenant: string): TenantConfig {
  const raw = JSON.parse(readFileSync(tenantPath(rootDir, tenant), "utf8")) as TenantConfig;
  if (!raw.branches?.length) throw new Error(`Tenant ${tenant} has no branches`);
  if (!raw.branches.some((b) => b.id === raw.defaultBranch)) {
    throw new Error(`Tenant ${tenant}: defaultBranch "${raw.defaultBranch}" is not a branch id`);
  }
  return raw;
}
