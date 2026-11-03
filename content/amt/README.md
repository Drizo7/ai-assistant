# Action Medeor Tanzania content

Nothing in this folder is live until an owner approves it (`bun src/cli.ts approve <id> --by "Name"`).

The files in `faq/` are templates. Each lists the question it answers and the
source it should come from. Fill the body from the Phase 0 content audit with
the content owner, set `review_by`, then ingest and approve.

Do not put opening hours, contacts, prices or training dates here: hours and
contacts live in `config/tenants/amt.json`, training dates are read live from
`/api/trainings`, and prices are never answered.
