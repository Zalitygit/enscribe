import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

const textOf = (r: any) => JSON.parse(r.content[0].text);

async function findingsClient(scopes?: string[]) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const search = new SearchService(db, store, emb, pages);
  const findings = new FindingsStore(db);
  const server = buildServer({ store, search, pages, findings }, scopes ? new Set(scopes) : undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, findings };
}

// The gardener holds findings.report so its vault scan and LLM probe can record
// what only it can see. It must never be able to judge its own findings —
// set_finding_state is not even registered for it.
test("a findings.report token cannot change a finding's state", async () => {
  const { client, findings } = await findingsClient(["pages.read", "findings.read", "findings.report"]);
  findings.upsertDetected({ kind: "red-link", subject: "a", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("set_finding_state");
  const denied = (await client.callTool({
    name: "set_finding_state", arguments: { key: "red-link:a", state: "wont_fix" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");
  expect(findings.get("red-link:a")!.state).toBe("open");
});

test("report_findings reconciles only the kinds it declares", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "keep", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "red-link", subject: "drop", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  await client.callTool({ name: "report_findings", arguments: { kinds: ["red-link"], findings: [] } });
  expect(findings.get("orphan:keep")!.state).toBe("open");
  expect(findings.get("red-link:drop")!.state).toBe("resolved");
});

test("set_finding_state records the note", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  await client.callTool({
    name: "set_finding_state", arguments: { key: "orphan:a", state: "wont_fix", note: "placeholder" },
  });
  expect(findings.get("orphan:a")).toMatchObject({ state: "wont_fix", note: "placeholder" });
});

// The triage step is a human hand-typing a key. A typo must be reported as
// a miss, not silently accepted, or the finding just reappears next night
// looking like the tool is broken.
test("set_finding_state on a nonexistent key reports the miss", async () => {
  const { client } = await findingsClient();
  const missed = (await client.callTool({
    name: "set_finding_state", arguments: { key: "orphan:does-not-exist", state: "wont_fix" },
  })) as any;
  expect(missed.isError).toBe(true);
});

test("findings returns rows for a read-scoped client", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  expect(textOf(await client.callTool({ name: "findings", arguments: { state: "open" } })).findings)
    .toHaveLength(1);
});

// Regression for the exploit: a findings.report client could enumerate every
// kind via `findings` then claim it in `report_findings` with an empty
// payload, resolving daemon-owned findings (e.g. `orphan`) it has no
// authority over. All-or-nothing: rejecting must not partially reconcile —
// the contradiction (a kind the gardener DOES own) must stay untouched too.
test("report_findings refuses a daemon-owned kind and reconciles nothing", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "contradiction", subject: "b", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  const denied = (await client.callTool({
    name: "report_findings", arguments: { kinds: ["orphan", "contradiction"], findings: [] },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.get("orphan:a")!.state).toBe("open");
  expect(findings.get("contradiction:b")!.state).toBe("open");
});

// The blacklist (DAEMON_KINDS) only rejected daemon-owned kinds, so any
// other string — an invented kind, or a near-miss like "Orphan" with a typo
// or trailing space — was silently accepted and written under an
// unattributable, unrecognised heading. report_findings must reject any
// declared kind that isn't on the explicit reportable whitelist.
test("report_findings refuses an invented kind not on the reportable whitelist", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "report_findings",
    arguments: { kinds: ["not-a-real-kind"], findings: [{ kind: "not-a-real-kind", subject: "a", detail: "d" }] },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.get("not-a-real-kind:a")).toBeUndefined();
});

test("report_findings still resolves a gardener-owned kind (contradiction) it declares", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "contradiction", subject: "b", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  await client.callTool({ name: "report_findings", arguments: { kinds: ["contradiction"], findings: [] } });
  expect(findings.get("orphan:a")!.state).toBe("open");
  expect(findings.get("contradiction:b")!.state).toBe("resolved");
});

test("add_finding files a needs-human item with its due date", async () => {
  const { client, findings } = await findingsClient();
  await client.callTool({
    name: "add_finding",
    arguments: { kind: "needs-human", subject: "codex-reauth", detail: "token expires", due: "2026-08-20T20:39:00Z" },
  });
  expect(findings.get("needs-human:codex-reauth")).toMatchObject({
    state: "open", due: "2026-08-20T20:39:00Z", source: "add_finding",
  });
});

// The whole reason this is a separate tool from report_findings: a session
// files the one ask it just found and must not close the four it never saw.
test("add_finding leaves every other open item alone", async () => {
  const { client, findings } = await findingsClient();
  findings.add({ kind: "needs-human", subject: "mailrc", detail: "d" }, "session", "2026-08-01T00:00:00Z");
  await client.callTool({
    name: "add_finding", arguments: { kind: "needs-human", subject: "codex-reauth", detail: "d" },
  });
  expect(findings.get("needs-human:mailrc")!.state).toBe("open");
  expect(findings.get("needs-human:codex-reauth")!.state).toBe("open");
});

// A caller that could append a daemon-owned kind would create a row the
// nightly reconcile immediately resolves (it was never detected), and the two
// would flap open/resolved against each other every night.
test("add_finding refuses a kind the nightly reconcile owns", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "orphan", subject: "a", detail: "d" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("appendable");
  expect(findings.get("orphan:a")).toBeUndefined();
});

test("add_finding needs findings.report, and a read-only client is refused", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("add_finding");
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "needs-human", subject: "a", detail: "d" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");
  expect(findings.get("needs-human:a")).toBeUndefined();
});

test("report_findings succeeds for a client scoped exactly like the gardener", async () => {
  const { client, findings } = await findingsClient(["pages.read", "findings.read", "findings.report"]);
  findings.upsertDetected({ kind: "contradiction", subject: "b", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  const r = (await client.callTool({
    name: "report_findings", arguments: { kinds: ["contradiction"], findings: [] },
  })) as any;
  expect(r.isError ?? false).toBe(false);
  expect(findings.get("contradiction:b")!.state).toBe("resolved");
});

test("add_finding files a todo and normalizes its bare due date", async () => {
  const { client, findings } = await findingsClient();
  await client.callTool({
    name: "add_finding",
    arguments: { kind: "todo", subject: "git-web-app", detail: "Create a git web application", due: "2026-09-01" },
  });
  expect(findings.get("todo:git-web-app")).toMatchObject({
    kind: "todo", state: "open", due: "2026-09-01T23:59:59Z", source: "add_finding",
  });
});

// The point of normalizing at the write path: the hook's overdue test is a
// string compare, and a bare date loses it on the item's own due day.
test("a todo due today is not yet overdue by the hook's comparison", async () => {
  const { client, findings } = await findingsClient();
  await client.callTool({
    name: "add_finding",
    arguments: { kind: "todo", subject: "today", detail: "d", due: "2026-09-01" },
  });
  const noonThatDay = "2026-09-01T12:00:00Z";
  expect(findings.get("todo:today")!.due! < noonThatDay).toBe(false);
});

test("add_finding leaves an explicit instant alone", async () => {
  const { client, findings } = await findingsClient();
  await client.callTool({
    name: "add_finding",
    arguments: { kind: "needs-human", subject: "codex", detail: "d", due: "2026-08-20T20:39:00Z" },
  });
  expect(findings.get("needs-human:codex")!.due).toBe("2026-08-20T20:39:00Z");
});

// Appending a kind the nightly reconcile owns would create a row the very
// next detection run resolves. The guard predates todo; this pins that
// adding todo did not widen it.
test("add_finding still refuses a reconciled kind", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "orphan", subject: "a", detail: "d" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.get("orphan:a")).toBeUndefined();
});

// Finding 1: an unrecognised due used to be stored verbatim. The write path
// is the only place that can reject it before it reaches the ledger.
test("add_finding rejects a due it cannot parse, and writes nothing", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "todo", subject: "a", detail: "d", due: "next tuesday" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.get("todo:a")).toBeUndefined();
});

// A non-Z offset looks plausible but would silently mis-compare against the
// UTC instants the rest of the ledger uses.
test("add_finding rejects a due with a non-Z offset, and writes nothing", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding",
    arguments: { kind: "todo", subject: "b", detail: "d", due: "2026-08-18T23:59:59-04:00" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.get("todo:b")).toBeUndefined();
});

// Finding 2: subject is the row's identity. A trailing space must not create
// a second row for what is really the same item.
test("add_finding normalizes a subject's identity, trimming whitespace", async () => {
  const { client, findings } = await findingsClient();
  await client.callTool({
    name: "add_finding", arguments: { kind: "todo", subject: "git-web-app ", detail: "d" },
  });
  expect(findings.get("todo:git-web-app")).toMatchObject({ subject: "git-web-app" });
});

// The bash reader splits its query output on `|` and reads it line by line;
// a literal `|` or newline in a subject corrupts the block downstream.
test("add_finding rejects a subject containing a pipe, and writes nothing", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "todo", subject: "pipe|in|subject", detail: "d" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.list({ kind: "todo" })).toHaveLength(0);
});

test("add_finding rejects a subject containing a newline, and writes nothing", async () => {
  const { client, findings } = await findingsClient();
  const denied = (await client.callTool({
    name: "add_finding", arguments: { kind: "todo", subject: "line one\nline two", detail: "d" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(findings.list({ kind: "todo" })).toHaveLength(0);
});

// The `needs-human` detail is a whole handoff — commands, traps, expected output —
// and 29 of them ran to 61 KB. Measured 2026-09-09 across the fleet's
// transcripts: `findings(kind="needs-human")` hit the tool-output cap in 13 of its
// last 19 calls, which made common.md's "call findings before add_finding"
// dedupe rule unenforceable. The list is therefore a summary; detail is
// fetched per key.
function seedLedger(findings: FindingsStore) {
  findings.add({ kind: "needs-human", subject: "open-one", detail: "long handoff text", due: null }, "add_finding", "2026-09-01T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "closed-one", detail: "closed handoff", due: null }, "add_finding", "2026-09-01T00:00:00Z");
  findings.setState("needs-human:closed-one", "resolved", "done", "2026-09-02T00:00:00Z");
}

test("findings defaults to open items rendered as summaries without detail", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  seedLedger(findings);
  const rows = textOf(await client.callTool({ name: "findings", arguments: {} })).findings;
  expect(rows).toEqual([
    { key: "needs-human:open-one", kind: "needs-human", subject: "open-one", state: "open", due: null,
      summary: "long handoff text", first_seen: "2026-09-01T00:00:00Z", times_reported: 1, doc: null },
  ]);
});

// A proactive agent (Claude Duet, 2026-10-29) nags from the list alone: with
// only slugs it would need one key call per item to say anything. The first
// line of detail is written to be the whole ask, so the summary carries it,
// capped where the session-start hook caps it.
test("findings summaries carry the first line of detail, capped at 96 characters", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  findings.add({ kind: "needs-human", subject: "short", detail: "\nRenew example.com before it lapses.\nlonger handoff", due: null, doc: "domains" }, "add_finding", "2026-09-01T00:00:00Z");
  findings.add({ kind: "needs-human", subject: "long", detail: "x".repeat(120), due: null }, "add_finding", "2026-09-01T00:00:00Z");
  const rows = textOf(await client.callTool({ name: "findings", arguments: {} })).findings;
  const by = Object.fromEntries(rows.map((r: any) => [r.subject, r]));
  expect(by.short).toMatchObject({ summary: "Renew example.com before it lapses.", doc: "domains" });
  expect(by.long.summary).toBe("x".repeat(95) + "…");
});

test("findings with a key returns that one full row", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  seedLedger(findings);
  const rows = textOf(await client.callTool({ name: "findings", arguments: { key: "needs-human:closed-one" } })).findings;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ key: "needs-human:closed-one", state: "resolved", detail: "closed handoff", note: "done" });
  expect(textOf(await client.callTool({ name: "findings", arguments: { key: "needs-human:nope" } })).findings).toEqual([]);
});

// The gardener's digest classifies resolved-today and reopened-today rows and
// prints detail, so it asks for everything explicitly.
test("findings state=all with full=true returns every state with detail", async () => {
  const { client, findings } = await findingsClient(["findings.read"]);
  seedLedger(findings);
  const rows = textOf(await client.callTool({ name: "findings", arguments: { state: "all", full: true } })).findings;
  expect(rows.map((r: any) => r.key).sort()).toEqual(["needs-human:closed-one", "needs-human:open-one"]);
  for (const r of rows) expect(r).toHaveProperty("detail");
  expect(rows.find((r: any) => r.key === "needs-human:closed-one")).toMatchObject({ first_seen: "2026-09-01T00:00:00Z", state_changed_at: "2026-09-02T00:00:00Z" });
});

// The dedupe rule ("call findings first, reuse the subject") lives in prose
// and a transcript audit found it skipped: the same ask filed under two slugs
// in two sessions. The write now says what it did — created, re-filed or
// reopened — and names open items of the same kind whose subject shares a
// word with the new one, so a near-duplicate is visible at the moment it is
// cheapest to fix.
test("add_finding says whether it created or re-filed, and names similar open subjects", async () => {
  const { client } = await findingsClient();
  const call = async (subject: string) => JSON.parse(((await client.callTool({
    name: "add_finding", arguments: { kind: "needs-human", subject, detail: "d" },
  })) as any).content[0].text);
  const first = await call("codex-reauth");
  expect(first).toMatchObject({ ok: true, created: true, reopened: false, times_reported: 1, similar: [] });
  const again = await call("codex-reauth");
  expect(again).toMatchObject({ created: false, times_reported: 2, similar: [] });
  const near = await call("codex-token-reauth");
  expect(near).toMatchObject({ created: true, similar: ["needs-human:codex-reauth"] });
  // A different kind is a different list: a todo about codex is not a duplicate of a needs-human ask.
  const todo = JSON.parse(((await client.callTool({
    name: "add_finding", arguments: { kind: "todo", subject: "codex-writeup", detail: "d" },
  })) as any).content[0].text);
  expect(todo.similar).toEqual([]);
});

// --- set_finding_field: patch one field without re-filing -------------------

test("set_finding_field changes only what is passed", async () => {
  const { client, findings } = await findingsClient();
  findings.add({ kind: "todo", subject: "p", detail: "the long handoff", due: "2026-10-01T23:59:59Z" },
    "add_finding", "2026-09-22T00:00:00Z");
  const r = textOf(await client.callTool({
    name: "set_finding_field", arguments: { key: "todo:p", doc: "some-page" },
  }));
  expect(r.ok).toBe(true);
  expect(r.changed).toEqual(["doc"]);
  const f = findings.get("todo:p")!;
  expect(f.doc).toBe("some-page");
  expect(f.detail).toBe("the long handoff");
  expect(f.due).toBe("2026-10-01T23:59:59Z");
  expect(f.times_reported).toBe(1);
});

// A bare YYYY-MM-DD must go through the same normalizer add_finding uses, or
// it would read OVERDUE on its own due day.
test("set_finding_field normalizes a bare due date", async () => {
  const { client, findings } = await findingsClient();
  findings.add({ kind: "todo", subject: "p", detail: "d" }, "add_finding", "2026-09-22T00:00:00Z");
  await client.callTool({ name: "set_finding_field", arguments: { key: "todo:p", due: "2026-10-05" } });
  expect(findings.get("todo:p")!.due).toBe("2026-10-05T23:59:59Z");
});

test("set_finding_field clears a field on explicit null", async () => {
  const { client, findings } = await findingsClient();
  findings.add({ kind: "todo", subject: "p", detail: "d", doc: "page" }, "add_finding", "2026-09-22T00:00:00Z");
  await client.callTool({ name: "set_finding_field", arguments: { key: "todo:p", doc: null } });
  expect(findings.get("todo:p")!.doc).toBeNull();
});

// The guard that matters: a detector rewrites `detail` every sweep, so an edit
// to one would vanish by morning with nothing to show it happened.
test("set_finding_field refuses to patch detail on a detector-owned kind", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "no inbound links" },
    "macbrain", "2026-09-22T00:00:00Z");
  const denied = (await client.callTool({
    name: "set_finding_field", arguments: { key: "orphan:a", detail: "hand-written" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("rewritten by its detector");
  // And the refusal wrote nothing.
  expect(findings.get("orphan:a")!.detail).toBe("no inbound links");
});

// ...but doc/due are safe on any kind, because no detector writes them.
test("set_finding_field allows doc on a detector-owned kind", async () => {
  const { client, findings } = await findingsClient();
  findings.upsertDetected({ kind: "orphan", subject: "a", detail: "no inbound links" },
    "macbrain", "2026-09-22T00:00:00Z");
  const r = textOf(await client.callTool({
    name: "set_finding_field", arguments: { key: "orphan:a", doc: "why-this-is-ok" },
  }));
  expect(r.ok).toBe(true);
  expect(findings.get("orphan:a")!.doc).toBe("why-this-is-ok");
});

test("set_finding_field on an unknown key errors", async () => {
  const { client } = await findingsClient();
  const missed = (await client.callTool({
    name: "set_finding_field", arguments: { key: "todo:nope", doc: "x" },
  })) as any;
  expect(missed.isError).toBe(true);
  expect(JSON.stringify(missed.content)).toContain("no such finding");
});

// Same trust boundary as set_finding_state: the gardener reports, it does not
// edit. The tool must not even be registered for a findings.report token.
test("set_finding_field is not registered for a gardener-scoped client", async () => {
  const { client } = await findingsClient(["pages.read", "findings.read", "findings.report"]);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("set_finding_field");
});
