/**
 * HTTP API. The first four routes match medeorag, so the existing medeor.tz
 * widget can be pointed here by changing nginx's proxy_pass only.
 *
 *   POST /chat           one-shot answer
 *   POST /chat/stream    SSE: {sources} -> {chunk}* -> {done,...}
 *   POST /search         retrieval only
 *   GET  /healthz        health
 *   POST /handoff        new: store a request for a person
 *   POST /feedback       new: thumbs up/down on one answer
 *   GET  /admin/*        new: staff views (bearer token)
 *   GET  /demo           sandbox test page with a minimal widget
 */

import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approve, expireSources, listSources, reject } from "./content";
import { contentDir, loadSettings, loadTenant, type Settings, type TenantConfig } from "./config";
import { openDb } from "./db";
import { createHandoff, validateHandoff } from "./handoff";
import { makeProvider, type Provider } from "./llm";
import { answer, answerOnce, type ChatInput, type PipelineDeps } from "./pipeline";
import { buildReport, reportToMarkdown } from "./report";
import { retrieve } from "./retrieve";

export interface AppDeps {
  db: Database;
  tenant: TenantConfig;
  provider: Provider;
  settings: Settings;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** Fixed-window limiter per visitor IP: 20 questions a minute. */
function rateLimiter(limit = 20, windowMs = 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    cur.n += 1;
    return cur.n <= limit;
  };
}

function parseChat(body: unknown): ChatInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.message !== "string" || !b.message.trim()) throw new Error("message is required");
  return {
    message: b.message,
    history: Array.isArray(b.history) ? (b.history as ChatInput["history"]) : [],
    session_id: typeof b.session_id === "string" ? b.session_id.slice(0, 64) : undefined,
    branch: typeof b.branch === "string" ? b.branch : undefined,
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const allow = rateLimiter();
  const pipelineDeps: PipelineDeps = {
    db: deps.db,
    tenant: deps.tenant,
    provider: deps.provider,
    streamMode: deps.settings.streamMode,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
  };
  const clientKey = (c: Context) => c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  const readJson = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };

  app.post("/chat", async (c) => {
    if (!allow(clientKey(c))) return c.json({ detail: "Too many questions, please wait a minute." }, 429);
    let input: ChatInput;
    try {
      input = parseChat(await readJson(c));
    } catch (e) {
      return c.json({ detail: (e as Error).message }, 400);
    }
    const { sources, done } = await answerOnce(input, pipelineDeps);
    return c.json({
      answer: done.answer,
      sources,
      num_sources: sources.length,
      confidence: done.confidence,
      needs_human: done.needs_human,
      actions: done.actions,
      turn_id: done.turn_id,
      route: done.route,
      reason: done.reason,
    });
  });

  app.post("/chat/stream", async (c) => {
    if (!allow(clientKey(c))) return c.json({ detail: "Too many questions, please wait a minute." }, 429);
    let input: ChatInput;
    try {
      input = parseChat(await readJson(c));
    } catch (e) {
      return c.json({ detail: (e as Error).message }, 400);
    }
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        try {
          for await (const ev of answer(input, pipelineDeps, abort.signal)) send(ev);
        } catch (err) {
          console.error("stream error:", err);
          send({ error: "The assistant failed to answer. Please try again or contact us." });
        } finally {
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.post("/search", async (c) => {
    const b = ((await readJson(c)) ?? {}) as { query?: unknown; top_k?: unknown };
    if (typeof b.query !== "string" || !b.query.trim()) return c.json({ detail: "query is required" }, 400);
    const k = Math.min(Math.max(Number(b.top_k) || deps.tenant.retrieval.topK, 1), 10);
    const r = retrieve(deps.db, b.query, k);
    return c.json(
      r.passages.map((p) => ({
        content: p.text,
        metadata: { title: p.title, source: p.url ?? undefined, source_id: p.source_id, version: p.version },
        score: Number(p.coverage.toFixed(2)),
        url: p.url ?? undefined,
      })),
    );
  });

  app.get("/healthz", async (c) => {
    const indexSize = (deps.db.query("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
    const modelOk = await deps.provider.healthy();
    const healthy = modelOk && indexSize > 0;
    return c.json(
      {
        status: healthy ? "healthy" : "degraded",
        db: true,
        ollama: deps.provider.name === "ollama" ? modelOk : false,
        model_available: modelOk,
        configured_model: deps.provider.name === "anthropic" ? deps.settings.anthropicModel : deps.provider.name === "ollama" ? deps.settings.ollamaModel : "extractive",
        index_size: indexSize,
      },
      healthy ? 200 : 503,
    );
  });

  app.post("/handoff", async (c) => {
    if (!allow(`handoff:${clientKey(c)}`)) return c.json({ detail: "Too many requests" }, 429);
    try {
      const input = validateHandoff(await readJson(c));
      const rec = await createHandoff(deps.db, deps.tenant, input, deps.settings.handoffWebhookUrl, deps.fetchImpl);
      return c.json({ id: rec.id, team: rec.team, branch: rec.branch }, 201);
    } catch (e) {
      return c.json({ detail: (e as Error).message }, 400);
    }
  });

  app.post("/feedback", async (c) => {
    const b = ((await readJson(c)) ?? {}) as { turn_id?: unknown; value?: unknown };
    if (typeof b.turn_id !== "string" || (b.value !== 1 && b.value !== -1)) {
      return c.json({ detail: "turn_id and value (1 or -1) are required" }, 400);
    }
    const res = deps.db.query("UPDATE turns SET feedback = ? WHERE id = ?").run(b.value, b.turn_id);
    return res.changes ? c.json({ ok: true }) : c.json({ detail: "unknown turn_id" }, 404);
  });

  // ---- staff only -------------------------------------------------------
  app.use("/admin/*", async (c, next) => {
    const token = deps.settings.adminToken;
    if (!token) return c.json({ detail: "admin disabled: set ADMIN_TOKEN" }, 404);
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ detail: "unauthorized" }, 401);
    await next();
  });

  app.get("/admin/sources", (c) => {
    const status = c.req.query("status") as Parameters<typeof listSources>[1];
    return c.json(listSources(deps.db, status).map(({ body, ...rest }) => ({ ...rest, preview: body.slice(0, 300) })));
  });

  app.post("/admin/sources/:id/approve", async (c) => {
    const b = ((await readJson(c)) ?? {}) as { by?: string; version?: number };
    if (!b.by) return c.json({ detail: "by (approver name) is required" }, 400);
    try {
      return c.json(approve(deps.db, c.req.param("id"), b.by, b.version));
    } catch (e) {
      return c.json({ detail: (e as Error).message }, 400);
    }
  });

  app.post("/admin/sources/:id/reject", async (c) => {
    const b = ((await readJson(c)) ?? {}) as { by?: string; version?: number };
    if (!b.by) return c.json({ detail: "by (reviewer name) is required" }, 400);
    try {
      return c.json(reject(deps.db, c.req.param("id"), b.by, b.version));
    } catch (e) {
      return c.json({ detail: (e as Error).message }, 400);
    }
  });

  app.get("/admin/report", (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
    const r = buildReport(deps.db, days);
    return c.req.query("format") === "md" ? c.text(reportToMarkdown(r)) : c.json(r);
  });

  app.get("/admin/handoffs", (c) =>
    c.json(deps.db.query("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 200").all()),
  );

  // ---- sandbox demo page ---------------------------------------------------
  app.get("/demo", (c) =>
    c.html(readFileSync(join(deps.settings.rootDir, "public", "demo.html"), "utf8").replace("{{PRIVACY_URL}}", deps.tenant.privacyPolicyUrl)),
  );
  app.get("/", (c) => c.redirect("/demo"));

  return app;
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const settings = loadSettings();
  const tenant = loadTenant(settings.rootDir, settings.tenant);
  const db = openDb(settings.dbPath);
  const expired = expireSources(db);
  if (expired.length) console.warn(`Expired (past review date, no longer served): ${expired.join(", ")}`);
  setInterval(() => expireSources(db), 6 * 60 * 60 * 1000);
  const indexed = (db.query("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
  if (!indexed) {
    console.warn(
      `No approved content yet. Run: bun src/cli.ts ingest && bun src/cli.ts list --status draft  (content: ${contentDir(settings.rootDir, settings.tenant)})`,
    );
  }
  const app = createApp({ db, tenant, provider: makeProvider(settings), settings });
  Bun.serve({ port: settings.port, fetch: app.fetch, idleTimeout: 120 });
  console.log(`${tenant.assistantName} (${settings.provider}, ${settings.streamMode}) on http://localhost:${settings.port}  demo: /demo`);
}
