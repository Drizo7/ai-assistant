# Connecting the sandbox to medeor.tz

The site's widget (`amt_website/components/ChatWidget/`) already calls `/api/rag/*`, and nginx proxies that path to medeorag. This service implements the same routes and event format, so connecting it needs no change to the widget. Two small widget additions make use of the new features.

## 1. Staging first (Phase 2 of the pilot)

1. Run this service on the LAN host, for example `192.168.0.10:8100`, beside medeorag.
2. On a **staging** copy of the site, change one line in `nginx.conf`:

   ```nginx
   location /api/rag/ {
       proxy_pass http://192.168.0.10:8100/;   # was :8000 (medeorag)
       ...
   }
   ```

3. Set `NUXT_PUBLIC_CHAT_ENABLED=true` on staging only.

**Rollback:** point `proxy_pass` back at `:8000`, or set `NUXT_PUBLIC_CHAT_ENABLED=false`.

## 2. Widget additions (small PR to amt_website)

These use fields the service already sends. Without them the widget still works; it just doesn't record feedback or handoffs.

| Change | Where | What |
| --- | --- | --- |
| Keep `turn_id` | `composables/useRag.ts` `onDone` | Add `turn_id`, `route` and `reason` to the `done` payload type. Store `turn_id` on the assistant `ChatMessage`. |
| Thumbs up/down | `components/ChatWidget/MessageList.vue` | Under answered messages, `POST /api/rag/feedback {turn_id, value}` |
| Call-back form | `components/ChatWidget/HandoffBanner.vue` | Next to the WhatsApp button, a form with name, phone or email, and a consent checkbox. It sends `POST /api/rag/handoff {name, contact, consent, turn_id, transcript}`. |
| AI notice | `components/ChatWidget/Window.vue` | One line: "You're chatting with an AI assistant" plus a privacy-policy link |
| Citation links | none needed | The service sends citations as Markdown links `[[1]](url)`, which the widget's Markdown renderer already displays |

`public/demo.html` in this repository is a working reference for all four additions.

## 3. Before public beta (gate from the pilot spec)

- [ ] Phase 0 content written, approved by named owners (`bun src/cli.ts list --status approved`)
- [ ] `config/tenants/amt.json`: real branches, hours, handoff contacts; `liveData.branchFactsConfirmedBy` set
- [ ] `eval/golden.amt.json` extended to about 80 real questions; `bun src/cli.ts eval --judge` passes at 90% or more, with no failed handoff case
- [ ] Model chosen (hosted or local Ollama) using the same golden set
- [ ] `HANDOFF_WEBHOOK_URL` delivers to the right inboxes; staff have tested it
- [ ] Privacy notice and retention periods signed off; `retention` scheduled daily
- [ ] `ADMIN_TOKEN` set; `/admin` reachable only from the office network
