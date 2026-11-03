/**
 * Rules that run WITHOUT a model, before and after generation.
 *
 * Pre-guard: some questions must never be answered by the assistant (medical
 * advice, prices, complaints) or are attempts to subvert it. Those are routed
 * by pattern, cheaply and predictably, before retrieval or a model is involved.
 *
 * Post-check: even a grounded answer is withheld if it mentions money or a
 * dose, or cites nothing. The visitor gets the handoff reply instead.
 *
 * Patterns are deliberately broad: a false handoff costs a staff reply, a
 * false answer on a medical question costs far more.
 */

import type { HandoffTeam } from "./config";

export type GuardReason =
  | "asked_for_person"
  | "medical"
  | "price_or_stock"
  | "complaint"
  | "prompt_injection"
  | "swahili_pending_review";

export interface GuardDecision {
  reason: GuardReason;
  /** handoff = offer a person; refuse = decline, still offer a person */
  route: "handoff" | "refuse";
  team: HandoffTeam;
}

const RULES: { reason: GuardReason; route: GuardDecision["route"]; team: HandoffTeam; pattern: RegExp }[] = [
  {
    reason: "prompt_injection",
    route: "refuse",
    team: "general",
    pattern:
      /\b(ignore|disregard|forget)\b.{0,30}\b(instructions?|rules|prompt|above)\b|\bsystem prompt\b|\byou are now\b|\bdeveloper mode\b|\bjailbreak\b|\bact as (an? )?(unrestricted|different)\b|\breveal (your|the) (instructions|prompt)\b/i,
  },
  {
    reason: "asked_for_person",
    route: "handoff",
    team: "general",
    pattern:
      /\b(speak|talk|chat|connect)\b.{0,20}\b(human|person|someone|somebody|agent|staff|representative|pharmacist|colleague)\b|\breal person\b|\bcall me( back)?\b|\bcustomer (service|care)\b|\b(nataka|naomba)\b.{0,20}\b(kuongea|kuzungumza)\b|\bmtu halisi\b/i,
  },
  {
    reason: "medical",
    route: "handoff",
    team: "pharmacist",
    pattern:
      /\b(dose|doses|dosage|dosing|overdose|side[- ]effects?|contraindicat\w*|interact\w* with|prescri\w*|symptoms?|pregnan\w*|breastfeed\w*)\b|\bhow (much|many)\b.{0,30}\b(take|give|tablets?|pills?|ml|mg|drops)\b|\b(can|should|may) (i|my|we|he|she)\b.{0,30}\b(take|give|use|mix)\b|\bmy (child|baby|son|daughter|wife|husband|mother|father|patient)\b.{0,40}\b(has|have|is|got)\b|\b(i|we) (have|got|feel)\b.{0,20}\b(fever|pain|cough|rash|infection|malaria|diarrh\w*|vomit\w*)\b|\b(diagnose|diagnosis) (me|my|him|her|them|this)\b|\b(dozi|dawa gani|nimeugua|homa)\b/i,
  },
  {
    reason: "complaint",
    route: "handoff",
    team: "customer_service",
    pattern:
      /\b(complain\w*|damaged|broken|leak\w*|expired product|wrong (item|product|order)|refund\w*|never (arrived|came|received)|late delivery|not delivered|missing items?|poor service|malalamiko|imeharibika)\b/i,
  },
  {
    reason: "price_or_stock",
    route: "handoff",
    team: "sales",
    pattern:
      /\b(price|prices|pricing|cost|costs|costing|quote|quotation|discount\w*|invoice|tsh|tzs|shillings?|usd|in stock|out of stock|stock level|availability of stock|how much (is|are|does|do|for)|order status|track(ing)? (my )?order|proforma|bei|punguzo|gharama|shilingi)\b/i,
  },
];

const SWAHILI_MARKERS =
  /\b(habari|je|nini|wapi|gani|lini|ngapi|mna|nina|nataka|naomba|tafadhali|asante|karibu|saa|kufungua|kufunga|mafunzo|dawa|duka|tawi|leo|kesho|jumamosi|jumapili|ofisi|bidhaa|mko)\b/gi;

export function detectLanguage(text: string): "sw" | "en" {
  const words = text.trim().split(/\s+/).length || 1;
  const hits = text.match(SWAHILI_MARKERS)?.length ?? 0;
  return hits >= 2 || (hits >= 1 && words <= 4) ? "sw" : "en";
}

export function preGuard(question: string, opts: { swahiliAnswers: boolean }): GuardDecision | null {
  for (const rule of RULES) {
    if (rule.pattern.test(question)) return { reason: rule.reason, route: rule.route, team: rule.team };
  }
  if (!opts.swahiliAnswers && detectLanguage(question) === "sw") {
    return { reason: "swahili_pending_review", route: "handoff", team: "general" };
  }
  return null;
}

const MONEY = /\b(tsh|tzs|usd|kes|shillings?|shilingi)\b|[$€£]\s?\d|\d[\d,.]*\s?(\/=|(tsh|tzs|usd)\b)/i;
const DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ml|g|iu|units?|tablets?|tabs?|capsules?|drops?)\b.{0,25}\b(per|a|every|each|times|daily|day|kg|hours?|x)\b/i;
const CITATION = /\[\d+\]/;

export type PostCheckFailure = "mentions_money" | "mentions_dose" | "no_citation" | "model_requested_handoff";

export const HANDOFF_MARKER = "[[HANDOFF]]";

/** Returns why an answer must be withheld, or null if it may be shown. */
export function postCheck(answer: string, opts: { requireCitation: boolean }): PostCheckFailure | null {
  if (answer.includes(HANDOFF_MARKER)) return "model_requested_handoff";
  if (MONEY.test(answer)) return "mentions_money";
  if (DOSE.test(answer)) return "mentions_dose";
  if (opts.requireCitation && !CITATION.test(answer)) return "no_citation";
  return null;
}
