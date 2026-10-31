import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import type { Embedder } from "../../src/embed/types.js";
import { SearchService, assessConfidence, type UnifiedHit } from "../../src/search/index.js";

let db: Database;
let store: Store;
let pages: PagesStore;
let pageSvc: PageService;
let search: SearchService;

beforeEach(async () => {
  db = openDb(":memory:");
  store = new Store(db);
  pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  pageSvc = new PageService(db, pages, emb);
  search = new SearchService(db, store, emb, pages);
});

test("searchUnified fuses a page hit and a record hit into one ranked list", async () => {
  const rec = store.add({ type: "note", subject: "Nonstop", content: "the base24 switch token zzqqx" });
  await search.index(rec);
  await pageSvc.ingest("switch.md", `---\ntitle: Switch\n---\n# Switch\n\nthe base24 switch token zzqqx\n`);

  const hits = await search.searchUnified("base24 switch token zzqqx");
  expect(hits.some((h) => h.kind === "record" && h.record.id === rec.id)).toBe(true);
  expect(hits.some((h) => h.kind === "page" && h.slug === "switch")).toBe(true);
});

// A page's frontmatter aliases are alternate NAMES for the thing it describes,
// and roughly half of them never appear anywhere in the body (94 of 201 in the
// live vault). Until they were indexed, searching one was a recall zero — the
// same failure migration 004 fixed for the title, from the other direction.
test("a frontmatter alias absent from the body still finds the page", async () => {
  await pageSvc.ingest(
    "concert-os.md",
    `---\ntitle: Concert OS\naliases: ["libct", "ct library"]\n---\n# Concert OS\n\nA cooperative multitasking kernel for embedded work.\n`,
  );
  const hits = await search.searchUnified("libct");
  const hit = hits.find((h) => h.kind === "page" && h.slug === "concert-os");
  expect(hit).toBeDefined();
  // Assert the KEYWORD leg matched. The vector leg is a KNN with no similarity
  // floor, so in a small corpus it returns the page no matter what the query
  // says — asserting only that the page came back would pass vacuously.
  expect(hit?.fts).toBe(true);
});

test("searchUnified page hit carries the best matching chunk", async () => {
  await pageSvc.ingest("p.md", `---\ntitle: P\n---\n# Intro\n\nunique lexical token qwzzx\n`);
  const hits = await search.searchUnified("unique lexical token qwzzx");
  const page = hits.find((h) => h.kind === "page");
  expect(page).toBeDefined();
  if (page && page.kind === "page") {
    expect(page.title).toBe("P");
    expect(page.chunk?.text).toContain("qwzzx");
  }
});

// The compatibility guarantee the whole intent design rests on: a caller that
// sends nothing gets exactly what it got before the parameter existed. Without
// this, adding `intent` to a live tool would silently change every existing
// client's results.
test("omitting intent is identical to intent=factual", async () => {
  await pageSvc.ingest("a.md", `---\ntitle: Alpha\n---\n# Alpha\n\nshared token qzzt here\n`);
  await pageSvc.ingest("b.md", `---\ntitle: Beta\n---\n# Beta\n\nshared token qzzt too\n`);
  const bare = await search.searchUnified("shared token qzzt");
  const factual = await search.searchUnified("shared token qzzt", { intent: "factual" });
  expect(factual.map((h) => (h.kind === "page" ? h.slug : h.record.id)))
    .toEqual(bare.map((h) => (h.kind === "page" ? h.slug : h.record.id)));
  expect(bare.every((h) => h.graph !== true)).toBe(true);
});

// Three pages carry the query token so they occupy the anchor slots, leaving
// `spoke` reachable ONLY by following hub's wikilink. Fewer text matches than
// GRAPH_SEEDS would make spoke an anchor itself, and anchors are excluded from
// their own expansion — the leg adds candidates, it does not re-boost seeds.
async function hubAndSpoke(spokeBody = "totally unrelated prose"): Promise<void> {
  await pageSvc.ingest("hub.md", `---\ntitle: Hub\n---\n# Hub\n\nquery token vvqx. See [[spoke]].\n`);
  await pageSvc.ingest("alt-one.md", `---\ntitle: Alt One\n---\n# Alt One\n\nquery token vvqx again\n`);
  await pageSvc.ingest("alt-two.md", `---\ntitle: Alt Two\n---\n# Alt Two\n\nquery token vvqx once more\n`);
  await pageSvc.ingest("spoke.md", `---\ntitle: Spoke\n---\n# Spoke\n\n${spokeBody}\n`);
  await pageSvc.resolveAll();
}

test("intent=entity reaches a linked page and marks it as graph-reached", async () => {
  await hubAndSpoke();
  const hits = await search.searchUnified("query token vvqx", { intent: "entity" });
  const spoke = hits.find((h) => h.kind === "page" && h.slug === "spoke");
  expect(spoke).toBeDefined();
  expect(spoke?.graph).toBe(true);
  // The anchor is a text match, so it must NOT be attributed to the graph leg.
  expect(hits.find((h) => h.kind === "page" && h.slug === "hub")?.graph).toBe(false);
});

test("a graph-reached page still carries readable chunk content", async () => {
  await hubAndSpoke("distinctive spoke prose");
  const hits = await search.searchUnified("query token vvqx", { intent: "entity" });
  const spoke = hits.find((h) => h.kind === "page" && h.slug === "spoke");
  expect(spoke?.kind === "page" && spoke.chunk?.text).toContain("distinctive spoke prose");
});

// Migration 014: the keyword leg stems, so a query that paraphrases a page
// ("retiring") reaches the word the page actually uses ("retirement").
test("the keyword leg matches a different form of the query word", async () => {
  await pageSvc.ingest("plan.md", `---\ntitle: Plan\n---\n# Plan\n\nthe retirement of zzqqx\n`);
  const hits = await search.searchUnified("retiring");
  const plan = hits.find((h) => h.kind === "page" && h.slug === "plan");
  expect(plan?.fts).toBe(true);
});

// Stemming makes "boxes" match every "box", which on the live index moved the
// entity expansion's anchors and dropped the right page from rank 1 to 9. So
// entity seeds are picked from the EXACT keyword copy, fused with the vector leg:
// here only the exact-match page links to the spoke, and four pages that match
// only by stem would otherwise take all three seed slots.
test("intent=entity picks its seeds from exact keyword matches, not stemmed ones", async () => {
  // FakeEmbedder's hash vectors rank pages arbitrarily and could make the spoke
  // a seed (seeds are excluded from their own expansion). This one puts the
  // spoke far from every query and ties the rest, so only the keyword legs
  // decide the seeds.
  const far: Embedder = {
    model: "far-embed", dim: 768,
    async embed(text) { const v = new Float32Array(768); v[0] = 1; if (text.includes("unrelated")) v[1] = 10; return v; },
  };
  const svc = new PageService(db, pages, far);
  const s = new SearchService(db, store, far, pages);
  await svc.ingest("exact.md", `---\ntitle: Exact\n---\n# Exact\n\nboxes. See [[spoke]].\n`);
  for (const n of [1, 2, 3, 4]) {
    await svc.ingest(`stem-${n}.md`, `---\ntitle: Stem ${n}\n---\n# Stem ${n}\n\nbox box box box box\n`);
  }
  await svc.ingest("spoke.md", `---\ntitle: Spoke\n---\n# Spoke\n\ntotally unrelated prose\n`);
  await svc.resolveAll();
  const hits = await s.searchUnified("boxes", { intent: "entity" });
  const spoke = hits.find((h) => h.kind === "page" && h.slug === "spoke");
  expect(spoke?.graph).toBe(true);
});

// The recency leg is currently disabled (it lost on the benchmark), so this
// holds trivially today. It is kept as the guard on re-enabling it: recency must
// RE-RANK the candidate set, never widen it, or the newest page in the vault
// starts answering every temporal question regardless of what was asked.
test("intent=temporal introduces no page the text legs did not find", async () => {
  await pageSvc.ingest("old.md", `---\ntitle: Old\n---\n# Old\n\nrare token wqzp\n`);
  await pageSvc.ingest("unrelated.md", `---\ntitle: Unrelated\n---\n# Unrelated\n\nnothing in common\n`);

  const bare = await search.searchUnified("rare token wqzp");
  const temporal = await search.searchUnified("rare token wqzp", { intent: "temporal" });
  const slugs = (hs: typeof bare) => new Set(hs.filter((h) => h.kind === "page").map((h) => (h as { slug: string }).slug));
  expect([...slugs(temporal)].every((s) => slugs(bare).has(s))).toBe(true);
});

test("existing record-only search() still works unchanged", async () => {
  const rec = store.add({ type: "note", subject: "Payments", content: "Base24 authorization" });
  await search.index(rec);
  const hits = await search.search("Base24");
  expect(hits[0].record.subject).toBe("Payments");
});

// A 2026-09-09 audit of fleet transcripts found a dated raw/ session narrative
// in the top three of 28 of 68 interactive searches and generator/hub pages in
// 40. Both are labeled relevant in the benchmark often enough (8 grade-3 raw
// labels) that excluding them is wrong; a kind weight, chosen by the benchmark,
// demotes them relative to authored pages with the same text evidence.
const SAME = "the base24 switch token zzqqx and nothing else\n";
async function twoPagesRawFirst() {
  await pageSvc.ingest("raw/2026-01-01-switch-session.md", `---\ntitle: Switch session\n---\n# Switch session\n\n${SAME}`);
  await pageSvc.ingest("wiki/concepts/switch.md", `---\ntitle: Switch\n---\n# Switch\n\n${SAME}`);
}

test("with the default weight a raw page keeps its full score and is labelled raw", async () => {
  await twoPagesRawFirst();
  const hits = await search.searchUnified("base24 switch token zzqqx");
  const raw = hits.find((h) => h.kind === "page" && h.slug === "2026-01-01-switch-session") as Extract<UnifiedHit, { kind: "page" }>;
  const authored = hits.find((h) => h.kind === "page" && h.slug === "switch") as Extract<UnifiedHit, { kind: "page" }>;
  expect(raw.page_kind).toBe("raw");
  expect(authored.page_kind).toBe("authored");
  // Both pages sit in both text legs, so each score is at least 2/(k+pool) and
  // at most 2/(k+1): the raw page cannot be under half the authored one.
  expect(raw.score).toBeGreaterThan(authored.score * 0.5);
});

test("with kindWeight 0.5 the raw score is halved, the authored score untouched, and authored ranks first", async () => {
  await twoPagesRawFirst();
  const control = await search.searchUnified("base24 switch token zzqqx");
  const weighted = new SearchService(db, store, new FakeEmbedder(), pages, { kindWeight: 0.5 });
  const hits = await weighted.searchUnified("base24 switch token zzqqx");
  const pick = (hs: UnifiedHit[], slug: string) => hs.find((h) => h.kind === "page" && h.slug === slug)!;
  expect(pick(hits, "2026-01-01-switch-session").score).toBeCloseTo(pick(control, "2026-01-01-switch-session").score * 0.5, 10);
  expect(pick(hits, "switch").score).toBeCloseTo(pick(control, "switch").score, 10);
  expect(hits.map((h) => h.kind === "page" && h.slug)).toEqual(["switch", "2026-01-01-switch-session"]);
});

test("by default a generated page scores half a raw page with the same text evidence", async () => {
  await twoPagesRawFirst();
  await pageSvc.putGenerated({ slug: "switch-hub", title: "Switch hub", body: `# Switch hub\n\n${SAME}` }, "test-gen");
  const unweighted = new SearchService(db, store, new FakeEmbedder(), pages, { kindWeight: 1 });
  const control = await unweighted.searchUnified("base24 switch token zzqqx");
  const hits = await search.searchUnified("base24 switch token zzqqx");
  const pick = (hs: UnifiedHit[], slug: string) => hs.find((h) => h.kind === "page" && h.slug === slug)!;
  expect(pick(hits, "switch-hub").score).toBeCloseTo(pick(control, "switch-hub").score * 0.5, 10);
  expect(pick(hits, "2026-01-01-switch-session").score).toBeCloseTo(pick(control, "2026-01-01-switch-session").score, 10);
});

test("generatedWeight demotes a generated page and leaves a raw page at full score", async () => {
  await twoPagesRawFirst();
  await pageSvc.putGenerated({ slug: "switch-hub", title: "Switch hub", body: `# Switch hub\n\n${SAME}` }, "test-gen");
  const control = await new SearchService(db, store, new FakeEmbedder(), pages, { kindWeight: 1 }).searchUnified("base24 switch token zzqqx");
  const weighted = new SearchService(db, store, new FakeEmbedder(), pages, { kindWeight: 1, generatedWeight: 0.5 });
  const hits = await weighted.searchUnified("base24 switch token zzqqx");
  const pick = (hs: UnifiedHit[], slug: string) => hs.find((h) => h.kind === "page" && h.slug === slug)!;
  expect((pick(hits, "switch-hub") as Extract<UnifiedHit, { kind: "page" }>).page_kind).toBe("generated");
  expect(pick(hits, "switch-hub").score).toBeCloseTo(pick(control, "switch-hub").score * 0.5, 10);
  expect(pick(hits, "2026-01-01-switch-session").score).toBeCloseTo(pick(control, "2026-01-01-switch-session").score, 10);
  expect(pick(hits, "switch").score).toBeCloseTo(pick(control, "switch").score, 10);
});

test("a page hit carries the retriever readings for its best chunk", async () => {
  await pageSvc.ingest("wiki/concepts/switch.md", `---\ntitle: Switch\n---\n# Switch\n\n${SAME}`);
  const [hit] = await search.searchUnified("base24 switch token zzqqx");
  expect(hit.kind).toBe("page");
  const p = hit as Extract<UnifiedHit, { kind: "page" }>;
  expect(p.fts && p.vector).toBe(true);
  expect(typeof p.bm25).toBe("number");
  expect(typeof p.distance).toBe("number");
});

// Every RRF score sits near the 0.033 ceiling whether the match is exact or the
// query is about cholesterol, so the score alone cannot say "nothing here".
// assessConfidence reads the leg flags and the vector distance instead.
test("assessConfidence: both legs within the distance floor is confident", () => {
  const hit = { kind: "page", slug: "s", title: "S", chunk: null, score: 0.03, fts: true, vector: true, distance: 0.4 } as UnifiedHit;
  expect(assessConfidence([hit], 0.8)).toEqual({ confident: true });
});

test("assessConfidence: one leg only, a far vector, or no hits is not", () => {
  const base = { kind: "page", slug: "s", title: "S", chunk: null, score: 0.03 } as const;
  expect(assessConfidence([{ ...base, fts: true, vector: false } as UnifiedHit], 0.8)).toEqual({ confident: false, reason: "single-leg" });
  expect(assessConfidence([{ ...base, fts: true, vector: true, distance: 0.95 } as UnifiedHit], 0.8)).toEqual({ confident: false, reason: "distance" });
  expect(assessConfidence([], 0.8)).toEqual({ confident: false, reason: "no-hits" });
});

// Found live on 2026-09-09: under intent=entity the graph leg lifted a
// neighbour (distance 0.87) above the exact page (0.72) for "what is
// <overloaded name>", and a rank-1-only rule reported the answerable question as not
// confident. The question is whether a strong text match sits near the top,
// so the rule reads the best both-legs distance in the top three.
test("assessConfidence: a close both-legs hit at rank 2 or 3 makes the result confident", () => {
  const far = { kind: "page", slug: "a", title: "A", chunk: null, score: 0.034, fts: true, vector: true, graph: true, distance: 0.87 } as UnifiedHit;
  const near = { kind: "page", slug: "b", title: "B", chunk: null, score: 0.033, fts: true, vector: true, distance: 0.72 } as UnifiedHit;
  const noise = { kind: "page", slug: "c", title: "C", chunk: null, score: 0.01, fts: false, vector: true, distance: 0.6 } as UnifiedHit;
  expect(assessConfidence([far, near], 0.85)).toEqual({ confident: true });
  expect(assessConfidence([far, noise, noise, near], 0.85)).toEqual({ confident: false, reason: "distance" });
});

// Found live on a second (Ollama-backed) instance 2026-09-10: a self-description RECORD
// matched "purple elephant quantum toaster" on both legs and the result came
// back confident, because a record carried no distance and the rule waved any
// non-page hit through. A record is a vector hit like any other; it reads the
// same floor.
test("assessConfidence: a both-legs record beyond the floor is not confident", () => {
  const rec = { id: "r", type: "note", subject: "S", content: "c" } as any;
  const far = { kind: "record", record: rec, score: 0.03, fts: true, vector: true, distance: 0.95 } as UnifiedHit;
  const near = { kind: "record", record: rec, score: 0.03, fts: true, vector: true, distance: 0.4 } as UnifiedHit;
  expect(assessConfidence([far], 0.8)).toEqual({ confident: false, reason: "distance" });
  expect(assessConfidence([near], 0.8)).toEqual({ confident: true });
});

test("a record hit carries its vector distance", async () => {
  const rec = store.add({ type: "note", subject: "Nonstop", content: "the base24 switch token zzqqx" });
  await search.index(rec);
  const hits = await search.searchUnified("base24 switch token zzqqx");
  const hit = hits.find((h) => h.kind === "record") as Extract<UnifiedHit, { kind: "record" }>;
  expect(hit).toBeDefined();
  expect(hit.vector).toBe(true);
  expect(typeof hit.distance).toBe("number");
});

// The consuming LLM can only reason about "when" if the hit says when the page
// was written. Fails if the field is dropped from the page-hit shape.
test("a page hit carries the page's authored_at", async () => {
  await pageSvc.ingest("dated.md", `---\ntitle: Dated\n---\n# Dated\n\nunique lexical token vvrrk\n`);
  pages.stampAuthoredDates(new Map([["dated.md", "2026-08-07T14:00:00.000Z"]]));
  const hits = await search.searchUnified("unique lexical token vvrrk");
  const page = hits.find((h) => h.kind === "page" && h.slug === "dated") as Extract<UnifiedHit, { kind: "page" }>;
  expect(page).toBeDefined();
  expect(page.authored_at).toBe("2026-08-07T14:00:00.000Z");
});

// null means "no authorship date" (a generated page, or a fresh ingest before
// the sync's stamp pass). Fails if someone coalesces to updated_at, which for
// those rows is a regen/ingest timestamp, not authorship.
test("a page hit with no authored stamp carries authored_at null", async () => {
  await pageSvc.ingest("unstamped.md", `---\ntitle: Unstamped\n---\n# Unstamped\n\nunique lexical token hhssq\n`);
  const hits = await search.searchUnified("unique lexical token hhssq");
  const page = hits.find((h) => h.kind === "page" && h.slug === "unstamped") as Extract<UnifiedHit, { kind: "page" }>;
  expect(page).toBeDefined();
  expect(page.authored_at).toBeNull();
});
