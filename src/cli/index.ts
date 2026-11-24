import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openDb } from "../core/db.js";
import { Store } from "../core/store.js";
import { SearchService } from "../search/index.js";
import { createEmbedder, type Embedder } from "../embed/index.js";
import { runStdio } from "../mcp/stdio.js";
import { startHttp } from "../mcp/http.js";
import { loadTokens } from "../mcp/auth.js";
import { resolveDbPath, resolveEmbedderConfig, resolvePort, resolveHost, resolveTokensPath } from "../config.js";
import { recordInputSchema } from "../schema.js";
import { RECORD_TYPES, type RecordInput, type RecordType } from "../core/types.js";
import { PagesStore } from "../pages/store.js";
import { PageService } from "../pages/service.js";
import { FindingsStore } from "../findings/ledger.js";
import type { FindingState } from "../findings/types.js";
import { runDetection } from "../findings/index.js";
import { appendFinding } from "../findings/append.js";
import { backfillFromArchive } from "../findings/backfill.js";
import { loadVaultConfig } from "../pages/vault-config.js";
import { normalize, slugify } from "../pages/slug.js";
import { parseFrontmatter, frontmatterAliases, extractLinks, LINK_TYPES } from "../pages/parse.js";
import { unknownLinkFields } from "../findings/detectors.js";
import { findSecrets } from "../pages/secret-guard.js";
import { syncVault } from "../pages/vault-sync.js";
import { watchVault } from "../pages/vault-watch.js";
import { runGenerators } from "../pages/generators/runner.js";
import { repoInventory } from "../pages/generators/repo-inventory.js";
import { activityDigest } from "../pages/generators/activity-digest.js";
import { healthReport } from "../pages/generators/health-report.js";
import { changeDigest } from "../pages/generators/change-digest.js";
import { findingsPage } from "../pages/generators/findings.js";
import { vaultSource } from "../pages/generators/vault-source.js";
import { gitRepoSource } from "../pages/generators/repo-source.js";
import { gitHistorySource } from "../pages/generators/git-history-source.js";
import { backupDb } from "../core/backup.js";
import { startNightly } from "../mcp/scheduler.js";
import { dataDir, env } from "../env.js";

function services() {
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  const store = new Store(db);
  const search = new SearchService(db, store, createEmbedder(resolveEmbedderConfig()));
  return { store, search };
}

function pageServices(embedder: Embedder = createEmbedder(resolveEmbedderConfig())) {
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  const pages = new PagesStore(db);
  const service = new PageService(db, pages, embedder);
  const findings = new FindingsStore(db);
  return { db, pages, service, findings };
}

// Every name a link can resolve to on disk, for `check`: slugified basename plus
// normalized title and aliases of each .md under the vault ROOT, not just the
// include dirs. Two cases the index cannot see: a page written earlier this
// session and not yet ingested, and deny-listed or non-included files (the
// private/ health pages), which Obsidian resolves but MacBrain never indexes.
// Names only; no body is read past its frontmatter, and nothing leaves the box.
function vaultFileNames(root: string): Set<string> {
  const names = new Set<string>();
  for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".md") || rel.split("/").some((s) => s.startsWith("."))) continue;
    names.add(slugify(basename(rel, ".md")));
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(join(root, rel), "utf8"));
      if (typeof frontmatter.title === "string") names.add(normalize(frontmatter.title));
      for (const a of frontmatterAliases(frontmatter)) names.add(normalize(a));
    } catch { /* unparseable frontmatter: the basename still counts */ }
  }
  return names;
}

// A `/`-bearing link target that names a file on disk, read relative to the
// linking file and then to the vault root, as given or with `.md` added.
// README.md's [[wiki/_schema]] and [[../biography.md]] are links Obsidian
// follows by path; the gardener's red-link scan applies the same rule.
function pathLinkExists(file: string, root: string, target: string): boolean {
  if (!target.includes("/")) return false;
  return [dirname(file), root].some((base) =>
    existsSync(join(base, target)) || existsSync(join(base, target + ".md")));
}

function backupDir(): string {
  return env("BACKUP_DIR") ?? join(dataDir(), "backups");
}

// Shared by the `generate` CLI command and `serve`'s in-daemon nightly run so
// the two call sites cannot drift — the acceptance gate only ever exercises
// one of them, so a hand-duplicated list here would be silently unverified.
//
// `pageHistory` is DELIBERATELY ABSENT, and the absence is pinned by a test.
// It is built, unit-tested and imported nowhere else — the same posture as the
// two rot detectors, and for the same reason: it was measured and it failed its
// own pre-registered gate. It delivers what it was built for (the 8 git-only
// temporal questions go 2/8 to 6/8, and relational nDCG@5 0.574 -> 0.585 with
// temporal 0.472 -> 0.495) but costs more than the rule allowed on the other
// query set: qrels v2 nDCG@5 0.847 -> 0.807 against a budget of 0.01, with 9 of
// 20 queries down. The mechanism is migration 004's title prefix — a page titled
// "History of <slug>" matches every query that matches its subject's name, so it
// lands beside the page it describes and takes an unlabeled top-five slot (13 of
// 100 across that set). Report and both reports:
// docs/evidence/2026-09-13-page-history-gate.md.
export const GENERATORS = [repoInventory, activityDigest, healthReport, findingsPage, changeDigest];

function buildGeneratorContext(pages: PagesStore, findings: FindingsStore) {
  const config = loadVaultConfig();
  return {
    repos: gitRepoSource(),
    store: pages,
    vault: vaultSource(config),
    git: gitHistorySource(config.root),
    findings,
    now: () => new Date(),
  };
}

// `serve`'s in-daemon nightly pass. Takes the daemon's embedder rather than
// building one: the DB handle is per-pass (opened and closed here), the model
// is not.
export function nightlyTask(embedder: Embedder): () => Promise<void> {
  return async () => {
    const { db, pages, service, findings } = pageServices(embedder);
    try {
      // Detection first: the findings generator renders ledger state, so it
      // must run against state that is already committed.
      const d = runDetection(pages, findings, new Date());
      console.log(`[nightly] findings: ${d.added} new, ${d.reopened} reopened, ${d.resolved} resolved`);
      const r = await runGenerators(service, pages, buildGeneratorContext(pages, findings), GENERATORS);
      for (const e of r.lintErrors) console.error(`[nightly] LINT: generated page '${e.slug}' -> unresolved [[${e.raw_text}]]`);
      await backupDb(resolveDbPath(), backupDir());
      console.log(`[nightly] ${r.generated} generated, ${r.pruned} pruned, ${r.skipped.length} skipped, ${r.lintErrors.length} lint error(s); backup done`);
    } finally {
      db.close();
    }
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "ingest": {
      if (!rest[0]) {
        console.log("usage: enscribe ingest <file.json>");
        return 1;
      }
      let input: RecordInput;
      try {
        input = recordInputSchema.parse(JSON.parse(readFileSync(rest[0], "utf8"))) as RecordInput;
      } catch (e) {
        console.log(`ingest: invalid record — ${(e as Error).message}`);
        return 1;
      }
      const { store, search } = services();
      const rec = store.add(input);
      await search.index(rec);
      console.log(`ingested ${rec.id} (${rec.type}) ${rec.subject}`);
      return 0;
    }
    case "query": {
      const type = flag(rest, "type");
      if (type !== undefined && !RECORD_TYPES.includes(type as RecordType)) {
        console.log(`query: invalid --type '${type}' (expected one of: ${RECORD_TYPES.join(", ")})`);
        return 1;
      }
      const { search } = services();
      const limit = flag(rest, "limit") ? Number(flag(rest, "limit")) : undefined;
      const text = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--")).join(" ");
      const hits = await search.search(text, { type: type as RecordType | undefined, limit });
      for (const h of hits) console.log(`${h.score.toFixed(4)}  ${h.record.type}  ${h.record.subject}`);
      return 0;
    }
    case "dump": {
      const { store } = services();
      const limit = flag(rest, "limit") ? Number(flag(rest, "limit")) : 100;
      for (const r of store.listCurrent({ limit })) console.log(`${r.id}  ${r.type}  ${r.subject}`);
      return 0;
    }
    case "reindex": {
      const { search } = services();
      const { records, failed } = await search.reindexAll();
      console.log(`reindexed ${records} current record(s)`);
      if (failed.length) {
        console.log(`embedding failed for ${failed.length} record(s); keyword index is complete, prior vectors kept`);
        return 1;
      }
      return 0;
    }
    case "doctor": {
      const { search } = services();
      const h = search.doctor();
      const issues =
        h.missingVector.length + h.missingFts.length + h.missingEmbeddingMeta.length +
        h.orphanVector + h.orphanFts + h.orphanRelationships + h.staleModel;
      console.log(`current records: ${h.currentRecords}`);
      console.log(`missing  — vector: ${h.missingVector.length}  fts: ${h.missingFts.length}  embedding-meta: ${h.missingEmbeddingMeta.length}`);
      console.log(`orphaned — vector: ${h.orphanVector}  fts: ${h.orphanFts}  relationships: ${h.orphanRelationships}  stale-model: ${h.staleModel}`);
      console.log(issues === 0 ? "healthy" : `${issues} issue(s) — run 'enscribe reindex' to heal`);
      return 0;
    }
    case "findings": {
      const { db, pages, findings } = pageServices();
      try {
        // `findings resolve <key> [reason]` closes one item by hand, and must
        // not run the detector sweep on the way past: resolving an ask has
        // nothing to do with recomputing orphans, and the sweep would rewrite
        // unrelated ledger state as a side effect of a one-item edit.
        // `wont-fix` is the decline beside it, same shape; it is sticky through
        // re-detection, so a detector cannot reopen it.
        if (rest[0] === "resolve" || rest[0] === "wont-fix") {
          const state = rest[0] === "resolve" ? "resolved" : "wont_fix";
          const key = rest[1];
          if (!key) { console.error(`usage: enscribe findings ${rest[0]} <key> [reason]`); return 1; }
          // Quote a multi-word reason at the shell. Unquoted, a ';' in it ends
          // the command and the tail runs as a separate one, so the ledger
          // records half a reason and still reports success.
          const reason = rest.slice(2).join(" ") || null;
          try {
            findings.setState(key, state, reason, new Date().toISOString());
          } catch (e) {
            console.error((e as Error).message);
            return 1;
          }
          console.log(`${state} ${key}`);
          return 0;
        }
        // `findings add <kind> <subject> <detail> [--due D] [--doc slug]` is
        // the add_finding write path from a terminal (2026-11-04), so cron
        // scripts on the brain host can raise an `alert` for the desk panel and clear
        // it with `resolve` when the condition goes away. It goes through
        // appendFinding, the same kind whitelist and normalizers as the MCP
        // tool, and like `resolve` it must not run the detector sweep.
        if (rest[0] === "add") {
          const usage = "usage: enscribe findings add <kind> <subject> <detail|-> [--due YYYY-MM-DD|ISO] [--doc slug]";
          const due = flag(rest, "due");
          const doc = flag(rest, "doc");
          // Positionals are what is left once each flag and its value are
          // taken out, so the flags may come anywhere on the line.
          const flagAt = new Set<number>();
          for (const name of ["due", "doc"]) {
            const i = rest.indexOf(`--${name}`);
            if (i >= 0) { flagAt.add(i); flagAt.add(i + 1); }
          }
          const pos = rest.slice(1).filter((_, i) => !flagAt.has(i + 1));
          // Exactly three. An unquoted detail arrives as many words, and one
          // with a ';' in it has already lost its tail to the shell, so
          // joining the words would file a truncated handoff and report
          // success. Refuse and say how to pass it.
          if (pos.length !== 3 || (rest.includes("--due") && due === undefined) || (rest.includes("--doc") && doc === undefined)) {
            console.error(usage);
            console.error("quote the detail as one argument, or pass - and pipe it on stdin");
            return 1;
          }
          const [kind, subject, detailArg] = pos;
          // `-` reads the detail from stdin, so a script can pipe or heredoc
          // a multi-line handoff without shell-quoting it (the owner's text often
          // holds a ';'). Trailing newlines are dropped: a heredoc or `echo`
          // always adds one, and it is not part of the detail.
          let detail = detailArg;
          if (detailArg === "-") {
            const chunks: Buffer[] = [];
            for await (const c of process.stdin) chunks.push(Buffer.from(c));
            detail = Buffer.concat(chunks).toString("utf8").replace(/\n+$/, "");
          }
          let wrote: ReturnType<typeof appendFinding>;
          try {
            wrote = appendFinding(findings, { kind, subject, detail, due, doc }, "cli", new Date().toISOString());
          } catch (e) {
            console.error((e as Error).message);
            return 1;
          }
          // The same facts add_finding returns, as lines a script can grep.
          console.log(wrote.created ? `created ${wrote.key}` : `re-filed ${wrote.key} (times_reported ${wrote.times_reported})`);
          if (wrote.reopened) console.log(`reopened ${wrote.key} (it had been resolved)`);
          if (doc && !pages.resolve(doc)) console.log(`doc ${doc} (NO SUCH PAGE yet)`);
          for (const k of wrote.similar) console.log(`similar ${k}`);
          return 0;
        }
        // `show` and `list` are the READ path, and like `resolve` they must not
        // run the detector sweep. Until 2026-09-22 there was no read path at
        // all: the bare subcommand printed kind/subject/times_reported and
        // nothing else, so a finding's `detail` — which common.md makes the
        // whole handoff — could be written from a session and never read back
        // from a terminal. Worse, the only way to list the ledger also wrote to
        // it, so it could not be inspected without mutating it.
        if (rest[0] === "show") {
          const key = rest[1];
          if (!key) { console.error("usage: enscribe findings show <key>"); return 1; }
          const f = findings.get(key);
          if (!f) { console.error(`no such finding: ${key}`); return 1; }
          console.log(`key        ${f.key}`);
          console.log(`kind       ${f.kind}`);
          console.log(`subject    ${f.subject}`);
          console.log(`state      ${f.state}`);
          console.log(`due        ${f.due ?? "(none)"}`);
          // The payoff of `doc` being a column rather than prose: we can say
          // whether it still points at something. Never a write-side gate --
          // a finding may legitimately be filed before its page exists -- so
          // this is reported here and nowhere else.
          if (f.doc) {
            const hit = new PagesStore(db).resolve(f.doc);
            console.log(`doc        ${f.doc}${hit ? `  -> ${hit}` : "  (NO SUCH PAGE)"}`);
          }
          console.log(`source     ${f.source}`);
          console.log(`first seen ${f.first_seen}`);
          console.log(`last seen  ${f.last_seen}`);
          console.log(`reported   ${f.times_reported}x`);
          if (f.note) console.log(`note       ${f.note}`);
          // Verbatim and unwrapped. The detail routinely carries indented
          // command blocks that must stay pasteable.
          console.log("");
          console.log(f.detail);
          return 0;
        }
        if (rest[0] === "list") {
          // `--state all` lifts the open-only default, which is how a closed
          // item is audited without reopening it. Any other value is passed
          // through to the store as-is.
          const stateArg = flag(rest, "state") ?? "open";
          const kind = flag(rest, "kind");
          const filter: { state?: FindingState; kind?: string } = {};
          if (stateArg !== "all") filter.state = stateArg as FindingState;
          if (kind) filter.kind = kind;
          const rows = findings.list(filter);
          for (const f of rows) {
            const due = f.due ? `  due ${f.due.slice(0, 10)}` : "";
            const doc = f.doc ? `  doc:${f.doc}` : "";
            console.log(`  ${f.key}  [${f.state}]  (${f.times_reported}x)${due}${doc}`);
          }
          console.log(`${rows.length} finding(s) — full detail: enscribe findings show <key>`);
          return 0;
        }
        const r = runDetection(pages, findings, new Date());
        console.log(`findings: ${r.added} new, ${r.reopened} reopened, ${r.resolved} resolved, ${r.unchanged} unchanged`);
        // Backfill runs after detection: a finding must exist in the ledger
        // before its first_seen can be moved earlier.
        const dir = flag(rest, "backfill");
        if (dir) {
          // This path is a hand-typed dir in a manual deployment step, so a
          // bad path must read as a message, not a raw fs stack trace.
          try {
            const files = readdirSync(dir)
              .filter((n) => /^brain-gardener-\d{4}-\d{2}-\d{2}\.md$/.test(n))
              .map((n) => ({ date: n.slice(15, 25), text: readFileSync(join(dir, n), "utf8") }));
            const b = backfillFromArchive(findings, files);
            console.log(`backfill: ${b.updated} finding(s) re-dated from ${files.length} archived report(s)`);
          } catch (e) {
            console.error(`backfill: ${(e as Error).message}`);
            return 1;
          }
        }
        for (const f of findings.list({ state: "open" })) {
          console.log(`  ${f.kind}  ${f.subject}  (${f.times_reported}x)`);
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case "mcp": {
      await runStdio(resolveDbPath(), resolveEmbedderConfig());
      return 0;
    }
    case "serve": {
      const tokens = loadTokens(resolveTokensPath());
      // One embedder for the life of the daemon, shared by the HTTP server and
      // the nightly pass. A fresh one per night loaded a fresh ONNX session each
      // time and never released the old one (1.85 GB RSS after 8 days).
      const embedder = createEmbedder(resolveEmbedderConfig());
      const server = await startHttp({
        dbPath: resolveDbPath(),
        port: resolvePort(),
        host: resolveHost(),
        tokens,
        embedderInstance: embedder,
      });
      const addr = server.address();
      const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
      console.log(`enscribe serving shared MCP on http://${where}/mcp (${tokens.size} client token(s))`);
      startNightly(nightlyTask(embedder));
      await new Promise<never>(() => {}); // keep the process alive for the server's lifetime
      return 0;
    }
    case "vault": {
      const sub = rest[0];
      const config = loadVaultConfig();
      const { pages, service } = pageServices();
      if (sub === "sync") {
        const s = await syncVault(config, service, pages, (abs) => readFileSync(abs, "utf8"));
        console.log(`vault sync: ${s.ingested} ingested, ${s.unchanged} unchanged, ${s.pruned} pruned, ${s.authoredStamped} authored-dated, ${s.unresolvedLinks} unresolved link(s)`);
        for (const a of s.ambiguousAliases) console.log(`  ambiguous alias '${a.alias}' claimed by: ${a.slugs.join(", ")} — resolves to none`);
        for (const c of s.collisions) console.log(`  QUARANTINED: slug '${c.slug}' claimed by ${c.paths.join(", ")} — none ingested, existing page left as-is`);
        for (const u of s.unparseable) console.log(`  QUARANTINED: ${u.path} — frontmatter did not parse (${u.error.split("\n")[0]}); not ingested, existing page left as-is`);
        if (s.pruneSkipped === "failed-dirs") {
          console.log(`  PRUNE SKIPPED: could not enumerate ${s.failedDirs.join(", ")} — the walk is not a complete view of the vault`);
        }
        // All three are operator-actionable: the index is now knowingly incomplete.
        return s.collisions.length > 0 || s.unparseable.length > 0 || s.pruneSkipped !== null ? 1 : 0;
      }
      if (sub === "watch") {
        console.log(`vault watch: syncing + watching ${config.root} ...`);
        await watchVault(config, service, pages);
        await new Promise<never>(() => {}); // keep alive for the watcher's lifetime
        return 0;
      }
      console.log("usage: enscribe vault <sync | watch>");
      return 1; // missing or unknown subcommand is a usage error
    }
    case "generate": {
      const { pages, service, findings } = pageServices();
      const r = await runGenerators(service, pages, buildGeneratorContext(pages, findings), GENERATORS);
      console.log(`generate: ${r.generated} generated, ${r.pruned} pruned, ${r.skipped.length} skipped, ${r.lintErrors.length} lint error(s)`);
      // Not an error: authored-wins is the intended outcome. Reported so a slug
      // silently absent from the generated set has a visible reason.
      for (const s of r.skipped) console.log(`  SKIP: ${s.generator} yielded '${s.slug}' to authored ${s.sourcePath}`);
      for (const e of r.lintErrors) console.log(`  LINT: generated page '${e.slug}' -> unresolved [[${e.raw_text}]]`);
      return r.lintErrors.length ? 1 : 0;
    }
    case "check": {
      // The write-time twin of the nightly unresolved / unknown-link-type /
      // secret findings, run by a Claude Code PostToolUse hook after a vault edit.
      // Silent and 0 when clean, so the hook says nothing on a good write.
      if (rest.length === 0) { console.log("usage: enscribe check FILE..."); return 1; }
      const pages = new PagesStore(openDb(resolveDbPath()));
      const root = loadVaultConfig().root;
      const onDisk = vaultFileNames(root);
      let problems = 0;
      for (const file of rest) {
        const text = readFileSync(file, "utf8");
        const { body } = parseFrontmatter(text);
        const missing = new Set(extractLinks(body).map((l) => l.raw)
          .filter((raw) => pages.resolve(raw) === null && !onDisk.has(slugify(raw)) && !onDisk.has(normalize(raw))
            && !pathLinkExists(file, root, raw)));
        for (const raw of missing) { console.log(`${file}: unresolved [[${raw}]]`); problems++; }
        for (const name of unknownLinkFields(body).keys()) {
          console.log(`${file}: \`${name}::\` is not a link type (one of ${LINK_TYPES.join(", ")}); its links are stored as plain wikilinks`);
          problems++;
        }
        // Whole file, frontmatter included; file line numbers. Never prints the match.
        for (const h of findSecrets(text)) {
          console.log(`${file}:${h.line}: possible secret (${h.rule}); remove it before it is committed, and keep it in the secrets store`);
          problems++;
        }
      }
      return problems ? 1 : 0;
    }
    case "backup": {
      const { file, pruned } = await backupDb(resolveDbPath(), backupDir());
      console.log(`backup: wrote ${file}, pruned ${pruned} old`);
      return 0;
    }
    case "purge": {
      const { pages } = pageServices();
      const n = pages.purgeTombstoned();
      console.log(`purge: ${n} tombstoned page(s) hard-deleted (bodies remain in backups until they age out)`);
      return 0;
    }
    default:
      console.log("usage: enscribe <ingest FILE | query TEXT | dump | reindex | doctor | findings [list [--kind K] [--state S|all] | show KEY | resolve KEY [REASON] | wont-fix KEY [REASON]] | mcp | serve | vault <sync|watch> | generate | check FILE... | backup | purge>");
      return cmd ? 1 : 0;
  }
}

// Executed as a binary (dist/cli/index.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
