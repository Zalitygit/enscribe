import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../../src/cli/index.js";
import { openDb } from "../../src/core/db.js";
import { FindingsStore } from "../../src/findings/ledger.js";

let dir: string;
let out: string[];
let errOut: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "macbrain-"));
  process.env.MACBRAIN_DB = join(dir, "t.db");
  process.env.MACBRAIN_EMBED_URL = "";          // force onnx? no — use fake via flag
  process.env.MACBRAIN_EMBED_BACKEND = "fake";  // test-only shortcut, honored by config
  out = [];
  errOut = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errOut.push(a.join(" ")); });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACBRAIN_DB;
  delete process.env.MACBRAIN_EMBED_BACKEND;
});

test("ingest a JSON record then query finds it", async () => {
  const file = join(dir, "rec.json");
  writeFileSync(file, JSON.stringify({ type: "note", subject: "Ports", content: "eero forwards port 3133" }));
  expect(await run(["ingest", file])).toBe(0);
  expect(await run(["query", "eero forwards port 3133"])).toBe(0);
  expect(out.join("\n")).toContain("Ports");
});

test("ingest rejects an invalid record (schema validation) with exit 1", async () => {
  const file = join(dir, "bad.json");
  // Missing required `content`, and an out-of-set `type`.
  writeFileSync(file, JSON.stringify({ type: "not-a-real-type", subject: "X" }));
  expect(await run(["ingest", file])).toBe(1);
  expect(out.join("\n")).toContain("invalid record");
});

test("query rejects an invalid --type with exit 1", async () => {
  expect(await run(["query", "anything", "--type", "bogus"])).toBe(1);
  expect(out.join("\n")).toContain("invalid --type");
});

test("dump lists ingested records", async () => {
  const file = join(dir, "rec.json");
  writeFileSync(file, JSON.stringify({ type: "fact", subject: "X", content: "y" }));
  await run(["ingest", file]);
  out.length = 0;
  expect(await run(["dump"])).toBe(0);
  expect(out.join("\n")).toContain("X");
});

test("purge hard-deletes tombstoned pages left by a vault prune", async () => {
  const vaultRoot = join(dir, "vault");
  const cfgPath = join(dir, "vault.json");
  mkdirSync(join(vaultRoot, "wiki/concepts"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ root: vaultRoot, include: ["wiki/concepts"], deny: [] }));
  process.env.MACBRAIN_VAULT_CONFIG = cfgPath;
  try {
    writeFileSync(join(vaultRoot, "wiki/concepts/doomed.md"), "---\ntitle: Doomed\n---\n# Doomed\nsensitive\n");
    // A surviving file, so deleting `doomed` leaves a non-empty walk — an empty
    // walk against a non-empty index deliberately blocks the prune.
    writeFileSync(join(vaultRoot, "wiki/concepts/keeper.md"), "---\ntitle: Keeper\n---\n# Keeper\n");
    expect(await run(["vault", "sync"])).toBe(0);
    rmSync(join(vaultRoot, "wiki/concepts/doomed.md"));
    expect(await run(["vault", "sync"])).toBe(0); // prunes -> tombstone
    expect(await run(["purge"])).toBe(0);
    expect(out.join("\n")).toContain("purge: 1 tombstoned page(s) hard-deleted");
    out = [];
    expect(await run(["purge"])).toBe(0);
    expect(out.join("\n")).toContain("purge: 0 tombstoned page(s) hard-deleted");
  } finally {
    delete process.env.MACBRAIN_VAULT_CONFIG;
  }
});

test("findings reports what it detected", async () => {
  const code = await run(["findings"]);
  expect(code).toBe(0);
  expect(out.join("\n")).toMatch(/findings: \d+ new, \d+ reopened, \d+ resolved/);
});

// This is a hand-typed path in a manual deployment step (macbrain findings
// --backfill <dir>), so a typo must produce a readable message, not a raw
// ENOENT stack trace through an unhandled rejection.
test("findings --backfill with a missing directory fails clearly instead of throwing", async () => {
  const missing = join(dir, "does-not-exist");
  const code = await run(["findings", "--backfill", missing]);
  expect(code).toBe(1);
  expect(errOut.join("\n")).toContain("backfill:");
  expect(errOut.join("\n")).toContain(missing);
});

// Closing an ask has to be possible from a terminal. Requiring a Claude Code
// session to mark item 3 done makes the ledger cost more to clear than the
// list it replaced.
test("findings resolve closes an item and records the reason", async () => {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).add({ kind: "needs-human", subject: "mailrc", detail: "d" }, "session", "2026-08-16T00:00:00Z");
  db.close();
  expect(await run(["findings", "resolve", "needs-human:mailrc", "restored from the backup"])).toBe(0);
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("needs-human:mailrc")).toMatchObject({
    state: "resolved", note: "restored from the backup",
  });
  check.close();
});

// A hand-typed key that misses must read as a message and a non-zero exit,
// not a stack trace, and above all not as success.
test("findings resolve on an unknown key exits 1 with a message", async () => {
  expect(await run(["findings", "resolve", "needs-human:no-such-thing"])).toBe(1);
  expect(errOut.join("\n")).toContain("no such finding");
});

// Declining a finding was possible only over MCP with findings.write, which the
// claude-ai token no longer has, so from a terminal it took a script against
// the DB. `wont-fix` is the decline beside `resolve`, with the same shape.
test("findings wont-fix declines an item, records the reason, and does not run detection", async () => {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).upsertDetected({ kind: "secret", subject: "old-note", detail: "d" }, "macbrain", "2026-10-31T00:00:00Z");
  db.close();
  expect(await run(["findings", "wont-fix", "secret:old-note", "truncated", "fragment"])).toBe(0);
  expect(out.join("\n")).toContain("wont_fix secret:old-note");
  expect(out.join("\n")).not.toContain("reopened");
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("secret:old-note")).toMatchObject({ state: "wont_fix", note: "truncated fragment" });
  check.close();
});

test("findings wont-fix on an unknown key exits 1 with a message", async () => {
  expect(await run(["findings", "wont-fix", "secret:no-such-thing"])).toBe(1);
  expect(errOut.join("\n")).toContain("no such finding");
});

// Resolving must not trigger the nightly sweep as a side effect: the detector
// pass rewrites unrelated ledger state and has nothing to do with closing one
// item by hand.
test("findings resolve does not run detection", async () => {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-16T00:00:00Z");
  db.close();
  await run(["findings", "resolve", "needs-human:a"]);
  expect(out.join("\n")).not.toContain("reopened");
});

// --- reading the ledger from a terminal -----------------------------------
//
// `detail` is the whole handoff by convention (see common.md), and until
// 2026-09-22 the CLI printed only kind/subject/times_reported and offered no
// way to see it. A finding's detail was effectively write-only from a
// terminal: readable over MCP and truncated to 96 characters of its first
// line by the needs-human hook, but never in full. `show` is that missing read.

const LONG_DETAIL = [
  "first line, the headline",
  "",
  "  a command to run",
  "and a trailing paragraph that must survive intact",
].join("\n");

function seed(kind = "needs-human", subject = "mailrc", detail = LONG_DETAIL, due: string | null = null) {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).add({ kind, subject, detail, due }, "session", "2026-08-16T00:00:00Z");
  db.close();
}

test("findings show prints the whole detail, not just the first line", async () => {
  seed();
  expect(await run(["findings", "show", "needs-human:mailrc"])).toBe(0);
  const printed = out.join("\n");
  // Every line of the handoff, including the indented command and the tail.
  for (const line of LONG_DETAIL.split("\n").filter(Boolean)) {
    expect(printed).toContain(line);
  }
  expect(printed).toContain("needs-human:mailrc");
});

test("findings show does not run detection", async () => {
  seed();
  await run(["findings", "show", "needs-human:mailrc"]);
  expect(out.join("\n")).not.toMatch(/findings: \d+ new/);
});

test("findings show on an unknown key exits 1 with a message", async () => {
  expect(await run(["findings", "show", "needs-human:nope"])).toBe(1);
  expect(errOut.join("\n")).toContain("no such finding");
});

test("findings show with no key exits 1 with usage", async () => {
  expect(await run(["findings", "show"])).toBe(1);
  expect(errOut.join("\n")).toContain("usage: enscribe findings show");
});

test("findings list does not run detection", async () => {
  seed();
  expect(await run(["findings", "list"])).toBe(0);
  expect(out.join("\n")).not.toMatch(/findings: \d+ new/);
  expect(out.join("\n")).toContain("mailrc");
});

test("findings list --kind filters", async () => {
  seed("needs-human", "keep");
  seed("todo", "drop");
  await run(["findings", "list", "--kind", "needs-human"]);
  expect(out.join("\n")).toContain("keep");
  expect(out.join("\n")).not.toContain("drop");
});

// A resolved item is invisible by default; `--state all` is how you audit what
// was closed without reopening anything.
test("findings list --state all includes resolved items", async () => {
  seed("needs-human", "closed");
  await run(["findings", "resolve", "needs-human:closed", "done"]);
  out.length = 0;
  await run(["findings", "list"]);
  expect(out.join("\n")).not.toContain("closed");
  out.length = 0;
  await run(["findings", "list", "--state", "all"]);
  expect(out.join("\n")).toContain("closed");
});

// --- `findings add`: filing from a script ----------------------------------
//
// Added 2026-11-04 so a cron job on the brain host can raise and clear an `alert`
// without a Claude session. It is the add_finding write path from a terminal:
// same kind whitelist, same normalizers, no detector sweep.

const stdinOf = (text: string) => {
  vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([text]) as unknown as typeof process.stdin);
};

test("findings add files a row with source cli and does not run detection", async () => {
  expect(await run(["findings", "add", "alert", "mail-down", "mail SMTP down", "--due", "2026-11-04"])).toBe(0);
  expect(out.join("\n")).toContain("created alert:mail-down");
  expect(out.join("\n")).not.toMatch(/findings: \d+ new/);
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("alert:mail-down")).toMatchObject({
    kind: "alert", state: "open", source: "cli", detail: "mail SMTP down", due: "2026-11-04T23:59:59Z",
  });
  check.close();
});

test("findings add refuses a non-appendable kind and writes nothing", async () => {
  expect(await run(["findings", "add", "orphan", "a", "d"])).toBe(1);
  expect(errOut.join("\n")).toContain("not appendable");
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("orphan:a")).toBeUndefined();
  check.close();
});

test("findings add rejects a bad due date and writes nothing", async () => {
  expect(await run(["findings", "add", "alert", "a", "d", "--due", "tomorrow"])).toBe(1);
  expect(errOut.join("\n")).toContain("YYYY-MM-DD");
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("alert:a")).toBeUndefined();
  check.close();
});

// A script pipes the detail so the shell never sees it: the owner's text often holds
// a ';', which unquoted ends the command and files half the detail.
test("findings add with detail '-' reads it from stdin, lines and ';' intact", async () => {
  stdinOf("balance below zero; check it\n\n  ssh brainhost 'ledger balance'\n");
  expect(await run(["findings", "add", "alert", "overdrawn", "-", "--doc", "p4-desk-panel"])).toBe(0);
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("alert:overdrawn")).toMatchObject({
    detail: "balance below zero; check it\n\n  ssh brainhost 'ledger balance'", doc: "p4-desk-panel",
  });
  check.close();
});

test("findings add re-filing the same subject reports times_reported 2", async () => {
  await run(["findings", "add", "alert", "mail-down", "first"]);
  out.length = 0;
  expect(await run(["findings", "add", "alert", "mail-down ", "second"])).toBe(0);
  expect(out.join("\n")).toContain("re-filed alert:mail-down (times_reported 2)");
  const check = openDb(process.env.MACBRAIN_DB!);
  expect(new FindingsStore(check).get("alert:mail-down")).toMatchObject({ detail: "second", times_reported: 2 });
  check.close();
});

test("findings add with too few arguments exits 1 with usage", async () => {
  expect(await run(["findings", "add", "alert", "a"])).toBe(1);
  expect(errOut.join("\n")).toContain("usage: enscribe findings add");
});

// --- `doc`: the pointer, and the read-side check it buys -------------------
//
// A doc naming a page that does not exist is NOT an error at the write path:
// filing the ask before writing the page is the normal order. It is reported
// here instead, which is the whole reason `doc` is a column and not prose.

test("findings show flags a doc pointing at no such page", async () => {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).add(
    { kind: "todo", subject: "dangling", detail: "d", doc: "page-that-does-not-exist" },
    "add_finding", "2026-09-22T00:00:00Z");
  db.close();
  expect(await run(["findings", "show", "todo:dangling"])).toBe(0);
  expect(out.join("\n")).toContain("page-that-does-not-exist");
  expect(out.join("\n")).toContain("NO SUCH PAGE");
});

// Seeded through a real vault sync, not `ingest` — `ingest` is the RECORD
// path and creates no page, so a doc test built on it would pass whether or
// not resolution worked.
test("findings show resolves a doc that does exist", async () => {
  const vaultRoot = join(dir, "vault");
  const cfgPath = join(dir, "vault.json");
  mkdirSync(join(vaultRoot, "wiki/concepts"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ root: vaultRoot, include: ["wiki/concepts"], deny: [] }));
  process.env.MACBRAIN_VAULT_CONFIG = cfgPath;
  try {
    writeFileSync(join(vaultRoot, "wiki/concepts/real-page.md"), "---\ntitle: Real Page\n---\n# Real Page\nbody\n");
    expect(await run(["vault", "sync"])).toBe(0);
    const db = openDb(process.env.MACBRAIN_DB!);
    new FindingsStore(db).add(
      { kind: "todo", subject: "linked", detail: "d", doc: "real-page" },
      "add_finding", "2026-09-22T00:00:00Z");
    db.close();
    out.length = 0;
    await run(["findings", "show", "todo:linked"]);
    expect(out.join("\n")).toContain("doc        real-page  -> real-page");
    expect(out.join("\n")).not.toContain("NO SUCH PAGE");
  } finally {
    delete process.env.MACBRAIN_VAULT_CONFIG;
  }
});

test("findings list shows the doc pointer inline", async () => {
  const db = openDb(process.env.MACBRAIN_DB!);
  new FindingsStore(db).add(
    { kind: "todo", subject: "withdoc", detail: "d", doc: "some-plan" },
    "add_finding", "2026-09-22T00:00:00Z");
  db.close();
  await run(["findings", "list"]);
  expect(out.join("\n")).toContain("doc:some-plan");
});
