/**
 * The answer pipeline. Order matters, cheapest and safest first:
 *
 *   1. pre-guard      rules route medical / price / complaint / "a person please"
 *   2. retrieval      approved passages + live facts; below the floor -> handoff
 *   3. generation     model answers from numbered sources only
 *   4. post-check     money, dose, missing citation, model's own handoff marker
 *   5. log            masked question, route, reason, citations, latency
 *
 * Events are emitted in the medeorag wire format the existing widget already
 * consumes: { sources } -> { chunk }* -> { done, confidence, needs_human, actions }.
 * `done` also carries turn_id / route / reason; the widget ignores unknown keys.
 */

import type { Database } from "bun:sqlite";
import type { Contact, HandoffTeam, TenantConfig } from "./config";
import { detectLanguage, HANDOFF_MARKER, postCheck, preGuard, type GuardReason, type PostCheckFailure } from "./guard";
import { liveSourcesFor, openState, type LiveSource } from "./live";
import { buildSystemPrompt, type PromptSource, type Provider } from "./llm";
import { maskPII } from "./mask";
import { retrieve, type RetrievedPassage } from "./retrieve";

// ---------------------------------------------------------------------------
// Wire types (mirror amt_website/composables/useRag.ts)
// ---------------------------------------------------------------------------

export type ContentType = "page" | "news" | "product" | "document" | "team" | "training" | "location" | "contact";

export interface ChatSource {
  content: string;
  metadata: { content_type?: ContentType; title?: string; source?: string; source_id?: string; version?: number };
  score?: number | null;
  url?: string;
  summary?: string;
}

export interface ChatAction {
  type: "whatsapp" | "tel" | "mailto" | "branch";
  label: string;
  value: string;
}

export type Route = "answered" | "handoff" | "refused";

export type Reason = GuardReason | PostCheckFailure | "no_source" | "provider_error";

export interface DoneEvent {
  done: true;
  answer: string;
  confidence: number;
  needs_human: boolean;
  actions: ChatAction[];
  turn_id: string;
  route: Route;
  reason: Reason | null;
  team: HandoffTeam | null;
}

export type PipelineEvent = { sources: ChatSource[] } | { chunk: string } | DoneEvent;

export interface ChatInput {
  message: string;
  history?: { role: string; content: string }[];
  session_id?: string;
  branch?: string;
}

export interface PipelineDeps {
  db: Database;
  tenant: TenantConfig;
  provider: Provider;
  streamMode: "buffered" | "live";
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Fixed, reviewed replies (never model-generated)
// ---------------------------------------------------------------------------

const REPLIES: Record<"en" | "sw", Record<GuardReason | "no_source" | "post_check" | "provider_error", string>> = {
  en: {
    asked_for_person: "Of course. Leave your name and number below, or message us on WhatsApp, and a colleague will get back to you.",
    medical:
      "I can't give medical or dosage advice. Please speak to a pharmacist or your health worker. You can reach our pharmacist using the contact below.",
    price_or_stock:
      "Prices, stock and orders are handled by our sales team so you get an accurate quote. Leave your details below or message them directly.",
    complaint:
      "I'm sorry to hear that. Our customer service team will look into it. Please leave your name and number below so they can contact you.",
    prompt_injection: "I can only help with questions about our products, services, branches and trainings.",
    swahili_pending_review:
      "Asante kwa ujumbe wako. Mwenzetu atakusaidia kwa Kiswahili. Tafadhali acha jina na namba yako, au tuandikie WhatsApp.",
    no_source: "I don't have approved information on that yet, so I'd rather not guess. A colleague can help you.",
    post_check: "I'd like a colleague to answer that one so you get accurate information.",
    provider_error: "Sorry, I can't answer right now. A colleague can help you instead.",
  },
  sw: {
    asked_for_person: "Sawa kabisa. Acha jina na namba yako hapa chini, au tuandikie WhatsApp, na mwenzetu atakupigia.",
    medical: "Siwezi kutoa ushauri wa kitabibu au wa dozi. Tafadhali ongea na mfamasia au mhudumu wa afya.",
    price_or_stock: "Bei, upatikanaji wa bidhaa na oda hushughulikiwa na timu yetu ya mauzo. Acha mawasiliano yako hapa chini.",
    complaint: "Samahani kwa usumbufu. Timu yetu ya huduma kwa wateja itashughulikia. Tafadhali acha jina na namba yako.",
    prompt_injection: "Ninaweza kusaidia tu kuhusu bidhaa, huduma, matawi na mafunzo yetu.",
    swahili_pending_review:
      "Asante kwa ujumbe wako. Mwenzetu atakusaidia kwa Kiswahili. Tafadhali acha jina na namba yako, au tuandikie WhatsApp.",
    no_source: "Sina taarifa iliyothibitishwa kuhusu hilo. Mwenzetu atakusaidia.",
    post_check: "Ningependa mwenzetu ajibu swali hili ili upate taarifa sahihi.",
    provider_error: "Samahani, siwezi kujibu sasa hivi. Mwenzetu atakusaidia.",
  },
};

// ---------------------------------------------------------------------------

function contactActions(contact: Contact): ChatAction[] {
  const out: ChatAction[] = [];
  if (contact.whatsapp) out.push({ type: "whatsapp", label: `WhatsApp ${contact.label}`, value: contact.whatsapp.replace(/^\+/, "") });
  if (contact.phone) out.push({ type: "tel", label: `Call ${contact.label}`, value: contact.phone });
  if (contact.email) out.push({ type: "mailto", label: `Email ${contact.label}`, value: contact.email });
  return out;
}

function afterHoursNote(tenant: TenantConfig, branchId: string, now: Date, lang: "en" | "sw"): string {
  if (!tenant.liveData.branchFactsConfirmedBy) return "";
  const branch = tenant.branches.find((b) => b.id === branchId) ?? tenant.branches[0]!;
  const s = openState(branch, now, tenant.timezone);
  if (s.open || !s.nextOpening) return "";
  return lang === "sw"
    ? ` Ofisi imefungwa sasa; tutawasiliana nawe tukifungua (${s.nextOpening}).`
    : ` We're closed right now; a colleague will reply when we open (${s.nextOpening}).`;
}

function contentTypeOf(sourceType: string): ContentType {
  if (sourceType === "product") return "product";
  if (sourceType === "training") return "training";
  if (sourceType === "news") return "news";
  if (sourceType === "procedure" || sourceType === "policy") return "document";
  return "page";
}

function toChatSources(passages: RetrievedPassage[], live: LiveSource[]): ChatSource[] {
  return [
    ...passages.map<ChatSource>((p) => ({
      content: p.text,
      metadata: { content_type: contentTypeOf(p.type), title: p.title, source: p.url ?? undefined, source_id: p.source_id, version: p.version },
      score: Number(p.coverage.toFixed(2)),
      url: p.url ?? undefined,
      summary: p.type === "product" ? p.text.slice(0, 160) : undefined,
    })),
    ...live.map<ChatSource>((l) => ({
      content: l.text,
      metadata: {
        content_type: l.id === "live-trainings" ? "training" : l.id === "live-contacts" ? "contact" : "page",
        title: l.title,
        source: l.url ?? undefined,
        source_id: l.id,
      },
      score: null,
      url: l.url ?? undefined,
    })),
  ];
}

/** Turn "[2]" citations into Markdown links where the source has a URL. */
export function linkCitations(answer: string, urls: (string | undefined)[]): string {
  return answer.replace(/\[(\d+)\](?!\()/g, (m, n: string) => {
    const url = urls[Number(n) - 1];
    return url ? `[[${n}]](${url})` : m;
  });
}

function newId(): string {
  return crypto.randomUUID();
}

function logTurn(
  db: Database,
  row: { id: string; session_id?: string; question: string; lang: string; route: Route; reason: Reason | null; team: string | null; confidence: number; cited: string[]; provider: string; latency_ms: number },
) {
  db.query(
    `INSERT INTO turns (id, session_id, question, lang, route, reason, team, confidence, cited, provider, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.session_id ?? null, maskPII(row.question), row.lang, row.route, row.reason, row.team, row.confidence, JSON.stringify(row.cited), row.provider, row.latency_ms);
}

const MAX_QUESTION = 1000;
const MAX_HISTORY_TURNS = 5;

export async function* answer(input: ChatInput, deps: PipelineDeps, signal?: AbortSignal): AsyncGenerator<PipelineEvent> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const { db, tenant, provider } = deps;
  const question = input.message.trim().slice(0, MAX_QUESTION);
  const lang = detectLanguage(question);
  const branchId = input.branch && tenant.branches.some((b) => b.id === input.branch) ? input.branch : tenant.defaultBranch;
  const turnId = newId();

  const finishHandoff = function* (
    reason: Reason,
    team: HandoffTeam,
    route: Route,
    confidence: number,
  ): Generator<PipelineEvent> {
    const key = (reason in REPLIES.en ? reason : "post_check") as keyof (typeof REPLIES)["en"];
    const text = REPLIES[lang][key] + (route === "handoff" ? afterHoursNote(tenant, branchId, now, lang) : "");
    yield { chunk: text };
    logTurn(db, { id: turnId, session_id: input.session_id, question, lang, route, reason, team, confidence, cited: [], provider: provider.name, latency_ms: Date.now() - started });
    yield {
      done: true,
      answer: text,
      confidence,
      needs_human: true,
      actions: contactActions(tenant.teams[team]),
      turn_id: turnId,
      route,
      reason,
      team,
    };
  };

  // 1. Pre-guard
  const guard = preGuard(question, { swahiliAnswers: tenant.swahiliAnswers });
  if (guard) {
    yield { sources: [] };
    yield* finishHandoff(guard.reason, guard.team, guard.route === "refuse" ? "refused" : "handoff", 0);
    return;
  }

  // 2. Retrieval: approved passages + live facts
  const retrieval = retrieve(db, question, tenant.retrieval.topK);
  const passages = retrieval.passages.filter((p) => p.coverage >= tenant.retrieval.minCoverage);
  const live = await liveSourcesFor(question, tenant, now, deps.fetchImpl);
  const sources = toChatSources(passages, live);
  const confidence = live.length ? Math.max(retrieval.confidence, 0.75) : retrieval.confidence;
  yield { sources };

  if (!passages.length && !live.length) {
    yield* finishHandoff("no_source", "general", "handoff", retrieval.confidence);
    return;
  }

  // 3. Generation
  const promptSources: PromptSource[] = sources.map((s, i) => ({ n: i + 1, title: s.metadata.title ?? "Source", text: s.content }));
  const history = (input.history ?? [])
    .filter((h): h is { role: "user" | "assistant"; content: string } => (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((h) => ({ role: h.role, content: h.content.slice(0, MAX_QUESTION) }));
  // The API requires the first message to be from the user.
  while (history[0]?.role === "assistant") history.shift();

  let text = "";
  try {
    for await (const delta of provider.generate(
      { system: buildSystemPrompt(tenant, lang), history, question, sources: promptSources },
      signal,
    )) {
      text += delta;
      // Live mode streams as it goes; the marker is stripped from what is shown.
      if (deps.streamMode === "live" && !text.includes("[[")) yield { chunk: delta };
    }
  } catch (err) {
    if (signal?.aborted) return;
    console.error("provider error:", (err as Error).message);
    yield* finishHandoff("provider_error", "general", "handoff", confidence);
    return;
  }

  // 4. Post-check
  const failure = postCheck(text, { requireCitation: true });
  if (failure) {
    const team: HandoffTeam = failure === "mentions_dose" ? "pharmacist" : failure === "mentions_money" ? "sales" : "general";
    if (deps.streamMode === "live" && text) yield { chunk: "\n\n" };
    yield* finishHandoff(failure === "model_requested_handoff" ? "no_source" : failure, team, "handoff", confidence);
    return;
  }

  const shown = linkCitations(text.trim(), sources.map((s) => s.url));
  if (deps.streamMode === "buffered") {
    // Re-chunk so the widget still renders progressively.
    for (const piece of shown.match(/[\s\S]{1,40}(\s|$)/g) ?? [shown]) yield { chunk: piece };
  }

  const citedIdx = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1))];
  const cited = citedIdx
    .map((i) => sources[i])
    .filter((s): s is ChatSource => Boolean(s))
    .map((s) => (s.metadata.version ? `${s.metadata.source_id}@v${s.metadata.version}` : String(s.metadata.source_id)));

  logTurn(db, { id: turnId, session_id: input.session_id, question, lang, route: "answered", reason: null, team: null, confidence, cited, provider: provider.name, latency_ms: Date.now() - started });

  yield {
    done: true,
    answer: shown,
    confidence,
    needs_human: false,
    actions: [],
    turn_id: turnId,
    route: "answered",
    reason: null,
    team: null,
  };
}

/** Run the pipeline to completion (for /chat, the CLI and the eval). */
export async function answerOnce(input: ChatInput, deps: PipelineDeps): Promise<{ sources: ChatSource[]; done: DoneEvent }> {
  let sources: ChatSource[] = [];
  let done: DoneEvent | null = null;
  for await (const ev of answer(input, deps)) {
    if ("sources" in ev) sources = ev.sources;
    if ("done" in ev) done = ev;
  }
  if (!done) throw new Error("pipeline ended without a result");
  return { sources, done };
}

export { HANDOFF_MARKER };
