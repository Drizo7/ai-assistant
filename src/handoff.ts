/**
 * Handoff records: a visitor asked for (or was routed to) a person. The
 * record carries the transcript so staff don't have to ask again, and is
 * pushed to an optional webhook (mail relay, n8n, Slack...) for notification.
 */

import type { Database } from "bun:sqlite";
import type { HandoffTeam, TenantConfig } from "./config";

export interface HandoffInput {
  turn_id?: string;
  name: string;
  contact: string;
  branch?: string;
  team?: HandoffTeam;
  reason?: string;
  transcript?: { role: string; content: string }[];
  consent: boolean;
}

export interface HandoffRecord {
  id: string;
  team: HandoffTeam;
  branch: string;
  route_to: { label: string; email?: string; whatsapp?: string; phone?: string };
}

const TEAMS: HandoffTeam[] = ["general", "sales", "pharmacist", "customer_service"];

export function validateHandoff(body: unknown): HandoffInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(b.name, 120);
  const contact = str(b.contact, 120);
  if (!name) throw new Error("name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) && !/^\+?[\d\s-]{7,20}$/.test(contact)) {
    throw new Error("contact must be a phone number or an email address");
  }
  if (b.consent !== true) throw new Error("consent is required to store contact details");
  const team = TEAMS.includes(b.team as HandoffTeam) ? (b.team as HandoffTeam) : undefined;
  const transcript = Array.isArray(b.transcript)
    ? (b.transcript as unknown[])
        .slice(-12)
        .map((m) => m as { role?: unknown; content?: unknown })
        .filter((m) => typeof m.role === "string" && typeof m.content === "string")
        .map((m) => ({ role: String(m.role), content: String(m.content).slice(0, 2000) }))
    : [];
  return {
    turn_id: str(b.turn_id, 64) || undefined,
    name,
    contact,
    branch: str(b.branch, 64) || undefined,
    team,
    reason: str(b.reason, 64) || undefined,
    transcript,
    consent: true,
  };
}

export async function createHandoff(
  db: Database,
  tenant: TenantConfig,
  input: HandoffInput,
  webhookUrl = "",
  fetchImpl: typeof fetch = fetch,
): Promise<HandoffRecord> {
  // Team: explicit, else from the turn that triggered it, else general.
  const fromTurn = input.turn_id
    ? (db.query("SELECT team, reason FROM turns WHERE id = ?").get(input.turn_id) as { team: HandoffTeam | null; reason: string | null } | null)
    : null;
  const team: HandoffTeam = input.team ?? fromTurn?.team ?? "general";
  const reason = input.reason ?? fromTurn?.reason ?? "visitor_request";
  const branch = tenant.branches.some((b) => b.id === input.branch) ? input.branch! : tenant.defaultBranch;
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO handoffs (id, turn_id, name, contact, branch, team, reason, transcript, consent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, input.turn_id ?? null, input.name, input.contact, branch, team, reason, JSON.stringify(input.transcript ?? []));

  const routeTo = tenant.teams[team];
  if (webhookUrl) {
    try {
      await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ id, team, branch, reason, route_to: routeTo, name: input.name, contact: input.contact, transcript: input.transcript }),
      });
    } catch (err) {
      // The record is saved either way; staff also see it in /admin/handoffs.
      console.error("handoff webhook failed:", (err as Error).message);
    }
  }
  return { id, team, branch, route_to: routeTo };
}
