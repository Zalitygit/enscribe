import { expect, test } from "vitest";
import { DEMO_LENGTHS, DEMO_SPEEDS, demoDelays, demoPlan, describePage } from "../../viewer/demo.js";

const adj = new Map<string, Set<string>>([
  ["hub", new Set(["a", "b", "c"])],
  ["a", new Set(["hub", "b"])],
  ["b", new Set(["hub", "a"])],
  ["c", new Set(["hub"])],
  ["lonely", new Set()],
  ["alone", new Set()],
  ["session", new Set()],
  ["digest", new Set()],
]);
const nodes = [
  { slug: "hub", title: "Hub" }, { slug: "a", title: "A" }, { slug: "b", title: "B", findings: 1 },
  { slug: "c", title: "C", findings: 3 }, { slug: "lonely", title: "Lonely" }, { slug: "alone", title: "Alone" },
  { slug: "session", title: "Session", kind: "raw" }, { slug: "digest", title: "Digest", kind: "generated" },
];

test("demoPlan starts at the hub, then pages with findings (most first), then unlinked authored pages, then a walk out from the hub", () => {
  expect(demoPlan(nodes, adj, "hub")).toEqual(["hub", "c", "b", "alone", "lonely", "a"]);
  expect(demoPlan(nodes, adj, "hub", 3)).toEqual(["hub", "c", "b"]);
  expect(demoPlan([], new Map(), null)).toEqual([]);
});

const page = (over: Record<string, unknown> = {}) => ({
  slug: "x", title: "X", kind: "authored", source_path: "wiki/concepts/x.md", trust: {},
  links: ["a", "b"], backlinks: ["c"], unresolved: [], ...over,
});

test("describePage narrates the checks from the page's own data", () => {
  expect(describePage(page(), "2026-11-02")).toEqual([
    { text: "reading “X” (authored)", level: "info" },
    { text: "2 links out, 1 in", level: "info" },
    { text: "looks healthy", level: "ok" },
  ]);
  const flagged = describePage(page({
    backlinks: [], unresolved: ["Nowhere", "Gone"],
    trust: { stale_after: "2026-01-01", verified: "2025-12-01" },
    findings: [{ kind: "stale", detail: "d" }],
  }), "2026-11-02");
  expect(flagged.map((l) => l.text)).toEqual([
    "reading “X” (authored)",
    "2 links out, 0 in",
    "orphan: no inbound links",
    "red link: [[Nowhere]]",
    "red link: [[Gone]]",
    "stale: due for review since 2026-01-01",
    "open finding: stale",
  ]);
  expect(flagged.slice(2).every((l) => l.level === "flag")).toBe(true);
  expect(describePage(page({ trust: { stale_after: "2027-01-01" } }), "2026-11-02").at(-1))
    .toEqual({ text: "looks healthy", level: "ok" });
});

test("describePage follows the orphan detector: raw/ and daily/ pages with no inbound links are not flagged", () => {
  for (const source_path of ["raw/2026-07-11-x-session.md", "daily/2026-05-26.md"]) {
    expect(describePage(page({ source_path, links: [], backlinks: [] }), "2026-11-02").slice(2)).toEqual([
      { text: "no inbound links (raw/ and daily/ pages are exempt)", level: "info" },
      { text: "looks healthy", level: "ok" },
    ]);
  }
});

test("describePage, like PagesStore.orphans, never calls a generated page an orphan", () => {
  expect(describePage(page({ kind: "generated", source_path: null, links: [], backlinks: [] }), "2026-11-02").slice(2)).toEqual([
    { text: "no inbound links (generated pages are exempt)", level: "info" },
    { text: "looks healthy", level: "ok" },
  ]);
});

test("describePage hides checks the owner declined (wont_fix): orphan, stale, a red link by its target", () => {
  const lines = describePage(page({
    backlinks: [], unresolved: ["Nowhere", "Gone"], trust: { stale_after: "2026-01-01" },
    declined: [{ kind: "orphan", subject: "x" }, { kind: "stale", subject: "x" }, { kind: "unresolved", subject: "Gone" }],
  }), "2026-11-02");
  expect(lines.map((l) => l.text)).toEqual(["reading “X” (authored)", "2 links out, 0 in", "red link: [[Nowhere]]"]);
  // A gardener red-link finding declines the same way.
  expect(describePage(page({ unresolved: ["Gone"], declined: [{ kind: "red-link", subject: "Gone" }] }), "2026-11-02").at(-1))
    .toEqual({ text: "looks healthy", level: "ok" });
});

test("demoPlan does not pick an unlinked page whose orphan finding was declined", () => {
  const withDeclined = nodes.map((n) => (n.slug === "alone" ? { ...n, declined: ["orphan"] } : n));
  expect(demoPlan(withDeclined, adj, "hub")).toEqual(["hub", "c", "b", "lonely", "a"]);
});

test("demoDelays scales every pause by the speed, with a floor under the map animations", () => {
  expect(demoDelays(1)).toEqual({ line: 350, flag: 650, page: 900, glide: 450, settle: 350 });
  expect(demoDelays(0.5)).toEqual({ line: 700, flag: 1300, page: 1800, glide: 900, settle: 700 });
  expect(demoDelays(4)).toEqual({ line: 88, flag: 163, page: 225, glide: 120, settle: 120 });
  for (const bad of [0, -2, Number.NaN, Infinity]) expect(demoDelays(bad)).toEqual(demoDelays(1));
});

test("the speed and tour-length choices are the ones the controls offer", () => {
  expect(DEMO_SPEEDS).toEqual([0.5, 1, 2, 4]);
  expect(DEMO_LENGTHS).toEqual([12, 24, 48]);
});
