import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import { findingsPage } from "../../../src/pages/generators/findings.js";
import type { GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";

let db: Database;
let store: PagesStore;
let findings: FindingsStore;
const noRepos: RepoSource = { listRepos: () => [], recentCommits: () => [] };
const noVault: VaultSource = { list: () => ({ sourcePaths: [], failedDirs: [] }) };

const noGit: GitHistorySource = { history: () => new Map() };
const ctx = (iso = "2026-08-11T04:00:00Z"): GeneratorContext => ({
  repos: noRepos, store, git: noGit, vault: noVault, findings, now: () => new Date(iso),
});

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  findings = new FindingsStore(db);
});

test("produces one page at brain-findings", async () => {
  const pages = await findingsPage.run(ctx());
  expect(pages).toHaveLength(1);
  expect(pages[0].slug).toBe("brain-findings");
});

// The runner lints generated pages and ONE unresolved link fails the entire
// nightly run. This page enumerates unresolved link targets by name, so a
// wikilink here would fail every night it had anything to report.
test("never emits a wikilink", async () => {
  findings.upsertDetected({ kind: "unresolved", subject: "Nowhere", detail: "linked from a" },
    "macbrain", "2026-08-01T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
  expect(page.body).toContain("`Nowhere`");
});

// A body that differs run to run re-chunks and re-embeds every night.
test("is byte-identical across runs with different clocks", async () => {
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "no inbound links" },
    "macbrain", "2026-08-01T00:00:00Z");
  const [first] = await findingsPage.run(ctx("2026-08-11T04:00:00Z"));
  const [second] = await findingsPage.run(ctx("2026-08-12T04:00:00Z"));
  expect(first.body).toBe(second.body);
});

// The axis that actually fires nightly: the wall clock the generator runs
// under is constant (it's always "now"), but times_reported and last_seen
// advance every single detection run regardless. If the rendered line
// includes either, the page's content_hash/embed_hash misses every night,
// forever — different clocks agreeing proves nothing about this.
test("is byte-identical across runs with an advancing ledger", async () => {
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "no inbound links" },
    "macbrain", "2026-08-01T00:00:00Z");
  const [first] = await findingsPage.run(ctx("2026-08-11T04:00:00Z"));
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "no inbound links" },
    "macbrain", "2026-08-10T00:00:00Z");
  const [second] = await findingsPage.run(ctx("2026-08-11T04:00:00Z"));
  expect(second.body).toBe(first.body);
});

// `detail` is free text — for `contradiction`, LLM output captured by
// brain-gardener's probe. A `[[Foo]]` in it would create a red-link/unresolved
// finding about brain-findings itself, which would render right back in:
// a self-sustaining loop the vault owner can't fix by editing the vault.
test("neutralises a wikilink embedded in a finding's detail", async () => {
  findings.upsertDetected(
    { kind: "contradiction", subject: "x|y", detail: "[[a]] says X but [[b]] says Y" },
    "gardener", "2026-08-01T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
});

// replaceAll("[[", "[ [") matches non-overlapping occurrences left to right,
// so a run of 3+ consecutive "[" leaves a residual "[[": "[[[".replaceAll(...)
// -> "[ [[", which still matches parse.ts's wikilink regex. Any run length,
// odd or even, must be fully broken up.
test("neutralises odd and even runs of 3+ consecutive brackets", async () => {
  findings.upsertDetected(
    { kind: "contradiction", subject: "odd", detail: "[[[" },
    "gardener", "2026-08-01T00:00:00Z");
  findings.upsertDetected(
    { kind: "contradiction", subject: "even", detail: "[[[[" },
    "gardener", "2026-08-01T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
});

test("neutralises a malformed wikilink hidden inside a bracket run", async () => {
  findings.upsertDetected(
    { kind: "contradiction", subject: "malformed", detail: "text [[[Foo]]] more" },
    "gardener", "2026-08-01T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
});

test("segregates wont_fix and omits resolved", async () => {
  findings.upsertDetected({ kind: "orphan", subject: "open-one", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "orphan", subject: "declined", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "orphan", subject: "gone", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.setState("orphan:declined", "wont_fix", "deliberate placeholder", "2026-08-01T00:00:00Z");
  findings.setState("orphan:gone", "resolved", null, "2026-08-01T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("open-one");
  expect(page.body).toContain("declined");
  expect(page.body).toContain("deliberate placeholder");
  expect(page.body).not.toContain("gone");
});

// needs-human items are asks a session filed for the owner, not conditions a detector
// swept for. They render first because they are the only ones with a deadline
// and the only ones nobody but the owner can clear.
test("renders needs-human items ahead of the detector sections", async () => {
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "codex-reauth", detail: "re-auth the token" },
    "session", "2026-08-16T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("## Needs human");
  expect(page.body.indexOf("## Needs human")).toBeLessThan(page.body.indexOf("## Orphans"));
});

// Deadline ordering was the organising principle of the hand-written report
// this replaces: an ask that expires outranks one that merely waits, whatever
// their keys sort like.
test("orders needs-human by due date, undated last", async () => {
  findings.add({ kind: "needs-human", subject: "a-undated", detail: "d" }, "session", "2026-08-16T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "z-soon", detail: "d", due: "2026-08-20" }, "session", "2026-08-16T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "m-later", detail: "d", due: "2026-09-30" }, "session", "2026-08-16T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body.indexOf("z-soon")).toBeLessThan(page.body.indexOf("m-later"));
  expect(page.body.indexOf("m-later")).toBeLessThan(page.body.indexOf("a-undated"));
});

// The report these replace carried commands and a pass/fail signature per
// item. One line per finding, the shape the detector sections use, would
// throw that away and leave the owner to reconstruct it.
test("renders a needs-human detail verbatim, multiple lines intact", async () => {
  findings.add({ kind: "needs-human", subject: "mailrc", detail: "Restore the file:\n\n    cp .mailrc.bak .mailrc\n\nA good run prints polling." },
    "session", "2026-08-16T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("### mailrc");
  expect(page.body).toContain("Restore the file:\n\n    cp .mailrc.bak .mailrc\n\nA good run prints polling.");
});

test("shows the due date on a needs-human item", async () => {
  findings.add({ kind: "needs-human", subject: "codex-reauth", detail: "d", due: "2026-08-20T20:39:00Z" },
    "session", "2026-08-16T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("2026-08-20T20:39:00Z");
});

// times_reported is excluded from the detector lines because a nightly sweep
// advances it whether or not anything changed. Nothing sweeps for needs-human,
// so it advances only when a session deliberately files the ask again — which
// is a real content change, and the number the owner most wants to see.
test("counts a repeated ask but stays byte-identical until one is re-filed", async () => {
  findings.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-16T00:00:00Z");
  const [once] = await findingsPage.run(ctx());
  const [again] = await findingsPage.run(ctx("2026-08-17T04:00:00Z"));
  expect(again.body).toBe(once.body);
  findings.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-17T00:00:00Z");
  const [refiled] = await findingsPage.run(ctx());
  expect(refiled.body).not.toBe(once.body);
  expect(refiled.body).toContain("asked 2 times");
});

test("neutralises a wikilink in a needs-human detail", async () => {
  findings.add({ kind: "needs-human", subject: "a", detail: "see [[some-page]]" }, "session", "2026-08-16T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
});

// Todos are dated items the owner asked for. They sit under the asks, which carry
// hard external deadlines, and above the detector sections, which carry none.
test("renders todos between the asks and the detector sections", async () => {
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "codex-reauth", detail: "re-auth" }, "session", "2026-08-16T00:00:00Z");
  findings.add({ kind: "todo", subject: "git-web-app", detail: "Create a git web application", due: "2026-09-01T23:59:59Z" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("## Todo (1)");
  expect(page.body.indexOf("## Needs human")).toBeLessThan(page.body.indexOf("## Todo"));
  expect(page.body.indexOf("## Todo")).toBeLessThan(page.body.indexOf("## Orphans"));
});

// The stored instant is end-of-day UTC; the date the owner typed is what they read.
test("renders a todo's due date as the day, not the instant", async () => {
  findings.add({ kind: "todo", subject: "a", detail: "d", due: "2026-09-01T23:59:59Z" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("(due 2026-09-01)");
  expect(page.body).not.toContain("23:59:59");
});

// An undated item is a note to self, not a commitment. It is counted and
// listed, never escalated, and it sorts last.
test("lists an undated todo last and without a due marker", async () => {
  findings.add({ kind: "todo", subject: "a-undated", detail: "someday" }, "add_finding", "2026-08-18T00:00:00Z");
  findings.add({ kind: "todo", subject: "z-dated", detail: "d", due: "2026-09-01T23:59:59Z" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body.indexOf("z-dated")).toBeLessThan(page.body.indexOf("a-undated"));
  expect(page.body).toMatch(/- `a-undated` — someday/);
});

// Byte-determinism is load-bearing: a body that differs run to run re-chunks
// and re-embeds every night. times_reported advances when an item is re-filed
// and must not reach this section.
test("a todo section is byte-identical across runs", async () => {
  findings.add({ kind: "todo", subject: "a", detail: "d", due: "2026-09-01T23:59:59Z" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [once] = await findingsPage.run(ctx());
  const [again] = await findingsPage.run(ctx("2026-08-19T04:00:00Z"));
  expect(again.body).toBe(once.body);
});

test("neutralises a wikilink in a todo detail", async () => {
  findings.add({ kind: "todo", subject: "a", detail: "take the [[m2k]] measurement" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toMatch(/\[\[/);
});

// A resolved todo is a done todo. The page shows what is outstanding.
test("drops a resolved todo", async () => {
  findings.add({ kind: "todo", subject: "done-thing", detail: "d" }, "add_finding", "2026-08-18T00:00:00Z");
  findings.setState("todo:done-thing", "resolved", "did it", "2026-08-18T01:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).not.toContain("done-thing");
});

// Finding 3: a multi-line detail used to interpolate straight into the page,
// so a detail containing "\n## fake heading" emitted a real heading and
// broke the section structure. The bash reader (needs-human) collapses at the
// SQL layer and truncates at the first newline regardless, so the two
// readers must agree the line is one line, not many.
test("collapses a newline in a todo's detail to a single space", async () => {
  findings.add({ kind: "todo", subject: "a", detail: "line one\n## fake heading" },
    "add_finding", "2026-08-18T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("line one ## fake heading");
  expect(page.body).not.toMatch(/^## fake heading/m);
});

// An alert is happening now, so it leads the page, above even the asks. Left
// to the generic detector path it would render through `line()`, which does
// not collapse newlines, and a script's multi-line detail would emit headings.
test("renders alerts first, one line each, newlines collapsed", async () => {
  findings.add({ kind: "needs-human", subject: "codex-reauth", detail: "re-auth" }, "session", "2026-08-16T00:00:00Z");
  findings.add({ kind: "alert", subject: "mail-down", detail: "SMTP refused\n## fake heading" },
    "cli", "2026-11-04T00:00:00Z");
  const [page] = await findingsPage.run(ctx());
  expect(page.body).toContain("## Alerts (1)");
  expect(page.body.indexOf("## Alerts")).toBeLessThan(page.body.indexOf("## Needs human"));
  expect(page.body).toContain("SMTP refused ## fake heading");
  expect(page.body).not.toMatch(/^## fake heading/m);
  expect(page.body).not.toContain("## alert");
});
