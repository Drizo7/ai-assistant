/**
 * Staff and developer commands.
 *
 *   bun src/cli.ts ingest [dir]                 load Markdown sources as drafts
 *   bun src/cli.ts list [--status draft]        list sources
 *   bun src/cli.ts show <id> [--version n]      print a source
 *   bun src/cli.ts approve <id> --by "Name"     make a draft live
 *   bun src/cli.ts reject <id> --by "Name"
 *   bun src/cli.ts retire <id> --by "Name"      take a source out of service
 *   bun src/cli.ts ask "question"               run one question through the pipeline
 *   bun src/cli.ts report [--days 7]            weekly report (Markdown)
 *   bun src/cli.ts eval [file] [--threshold 0.9] [--judge]   golden-set gate
 *   bun src/cli.ts retention [--turn-days 90] [--handoff-days 365]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { approve, expireSources, getSource, ingestDir, listSources, reject, retire } from "./content";
import { contentDir, loadSettings, loadTenant } from "./config";
import { applyRetention, openDb, type SourceStatus } from "./db";
import { runEval, type GoldenCase } from "./eval";
import { makeProvider } from "./llm";
import { answerOnce } from "./pipeline";
import { buildReport, reportToMarkdown } from "./report";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (args[i + 1] && !args[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const settings = loadSettings();
  const tenant = loadTenant(settings.rootDir, settings.tenant);
  const db = openDb(settings.dbPath);
  expireSources(db);
  const pos = positional(args);
  const by = flag(args, "by");
  const version = flag(args, "version") ? Number(flag(args, "version")) : undefined;

  switch (cmd) {
    case "ingest": {
      const dir = pos[0] ?? contentDir(settings.rootDir, settings.tenant);
      const r = ingestDir(db, dir);
      for (const c of r.created) console.log(`draft  ${c.id} v${c.version}`);
      if (r.unchanged.length) console.log(`unchanged: ${r.unchanged.length}`);
      for (const e of r.errors) console.error(`error  ${e}`);
      console.log(`\n${r.created.length} new draft version(s). Review with: bun src/cli.ts list --status draft`);
      process.exitCode = r.errors.length ? 1 : 0;
      break;
    }
    case "list": {
      const rows = listSources(db, flag(args, "status") as SourceStatus | undefined);
      for (const s of rows) console.log(`${s.status.padEnd(10)} ${s.id} v${s.version}  owner=${s.owner}  review_by=${s.review_by}  "${s.title}"`);
      if (!rows.length) console.log("(none)");
      break;
    }
    case "show": {
      const s = getSource(db, pos[0] ?? "", version);
      if (!s) throw new Error(`No source ${pos[0]}`);
      console.log(`${s.title}  [${s.id} v${s.version}, ${s.status}, owner ${s.owner}, review by ${s.review_by}]\n${s.url ?? ""}\n\n${s.body}`);
      break;
    }
    case "approve":
    case "reject":
    case "retire": {
      if (!pos[0] || !by) throw new Error(`usage: ${cmd} <id> --by "Name"`);
      if (cmd === "retire") {
        retire(db, pos[0], by);
        console.log(`retired ${pos[0]}`);
      } else {
        const s = (cmd === "approve" ? approve : reject)(db, pos[0], by, version);
        console.log(`${s.status} ${s.id} v${s.version} by ${by}`);
      }
      break;
    }
    case "ask": {
      const question = pos.join(" ");
      const { sources, done } = await answerOnce(
        { message: question, session_id: "cli" },
        { db, tenant, provider: makeProvider(settings), streamMode: "buffered" },
      );
      console.log(done.answer);
      console.log(`\nroute=${done.route} reason=${done.reason ?? "-"} team=${done.team ?? "-"} confidence=${done.confidence.toFixed(2)}`);
      sources.forEach((s, i) => console.log(`  [${i + 1}] ${s.metadata.title} (${s.metadata.source_id}${s.metadata.version ? ` v${s.metadata.version}` : ""})`));
      break;
    }
    case "report": {
      console.log(reportToMarkdown(buildReport(db, Number(flag(args, "days") ?? 7))));
      break;
    }
    case "eval": {
      const file = pos[0] ?? join(settings.rootDir, "eval", `golden.${settings.tenant}.json`);
      const cases = JSON.parse(readFileSync(file, "utf8")) as GoldenCase[];
      const threshold = Number(flag(args, "threshold") ?? 0.9);
      const summary = await runEval(
        cases,
        { db, tenant, provider: makeProvider(settings), streamMode: "buffered" },
        { threshold, judgeModel: args.includes("--judge") ? settings.anthropicModel : undefined },
      );
      for (const r of summary.results) {
        console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.id.padEnd(28)} ${r.route}${r.reason ? `/${r.reason}` : ""}`);
        for (const f of r.failures) console.log(`        - ${f}`);
      }
      console.log(
        `\n${summary.passed}/${summary.total} passed (${Math.round(summary.passRate * 100)}%), required ${Math.round(threshold * 100)}%; ` +
          `handoff/refusal cases failed: ${summary.mustHandoffFailures}  ->  gate ${summary.gatePassed ? "PASSED" : "FAILED"}  [provider: ${settings.provider}]`,
      );
      mkdirSync(join(settings.rootDir, "eval", "results"), { recursive: true });
      const out = join(settings.rootDir, "eval", "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${settings.provider}.json`);
      writeFileSync(out, JSON.stringify(summary, null, 2));
      console.log(`details: ${out}`);
      process.exitCode = summary.gatePassed ? 0 : 1;
      break;
    }
    case "retention": {
      const r = applyRetention(db, Number(flag(args, "turn-days") ?? 90), Number(flag(args, "handoff-days") ?? 365));
      console.log(`deleted ${r.turns} turn(s) and ${r.handoffs} handoff(s) past retention`);
      break;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*?|^ \* ?/gm, ""));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
