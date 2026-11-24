import { expect, test } from "vitest";
import { UNLINKED, along, clampDisk, drag, fromCenter, inlineTokens, isRule, layout, listAt, markSpans, matchPages, norm, parseQuery, quoteAt, setextLevel, spanningTree, subgraph, tableAt, toCenter } from "../../viewer/hyper.js";

const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

test("toCenter moves a to the origin, fromCenter undoes it, and both keep points in the disk", () => {
  const a: [number, number] = [0.6, -0.3];
  close(toCenter(a, a), [0, 0]);
  close(fromCenter([0, 0], a), a);
  for (const z of [[0.1, 0.2], [-0.9, 0.05], [0.7, 0.7]] as [number, number][]) {
    close(fromCenter(toCenter(z, a), a), z);
    expect(norm(toCenter(z, a))).toBeLessThan(1);
  }
});

test("drag carries p0 exactly to p1", () => {
  close(drag([0.2, 0.4], [0.2, 0.4], [-0.5, 0.1]), [-0.5, 0.1]);
});

test("along runs the geodesic from the origin to a, at t=0 and t=1", () => {
  close(along([0.8, 0], 0), [0, 0]);
  close(along([0.8, 0], 1), [0.8, 0]);
  const mid = along([0.8, 0], 0.5);
  expect(mid[1]).toBe(0);
  expect(mid[0]).toBeGreaterThan(0.4); // hyperbolic midpoint lies past the Euclidean one
  expect(clampDisk([2, 0], 0.9)).toEqual([0.9, 0]);
});

test("spanningTree is breadth-first by degree and hangs unreachable pages off UNLINKED", () => {
  const adj = new Map<string, Set<string>>([
    ["hub", new Set(["a", "b"])], ["a", new Set(["hub", "b", "c"])], ["b", new Set(["hub", "a"])],
    ["c", new Set(["a"])], ["lonely", new Set()],
  ]);
  const t = spanningTree(adj, "hub");
  expect(t.children.get("hub")).toEqual(["a", "b", UNLINKED]);
  expect(t.children.get("a")).toEqual(["c"]);
  expect(t.children.get(UNLINKED)).toEqual(["lonely"]);
  expect(t.parent.get("c")).toBe("a");
});

test("layout puts the root at the centre and each depth on its own circle inside the disk", () => {
  const adj = new Map<string, Set<string>>([
    ["r", new Set(["x", "y"])], ["x", new Set(["r", "z"])], ["y", new Set(["r"])], ["z", new Set(["x"])],
  ]);
  const pos = layout(spanningTree(adj, "r"), "r", 1.4);
  close(pos.get("r")!, [0, 0]);
  expect(norm(pos.get("x")!)).toBeCloseTo(Math.tanh(0.7), 9);
  expect(norm(pos.get("y")!)).toBeCloseTo(Math.tanh(0.7), 9);
  expect(norm(pos.get("z")!)).toBeCloseTo(Math.tanh(1.4), 9);
  expect(norm(pos.get("z")!)).toBeLessThan(1);
});

test("matchPages keeps pages whose title, slug or type contain every term, and returns null for a blank query", () => {
  const pages = [
    { slug: "fleet-inventory", title: "Fleet inventory", type: "reference" },
    { slug: "home-network", title: "Home network", type: null },
    { slug: "2026-10-31-fleet-session", title: "Fleet session", type: "session" },
  ];
  expect(matchPages(pages, "  ")).toBeNull();
  expect([...matchPages(pages, "FLEET")!]).toEqual(["fleet-inventory", "2026-10-31-fleet-session"]);
  expect([...matchPages(pages, "fleet ref")!]).toEqual(["fleet-inventory"]);
  expect([...matchPages(pages, "2026-10")!]).toEqual(["2026-10-31-fleet-session"]);
  expect(matchPages(pages, "nothing")!.size).toBe(0);
});

test("subgraph keeps only the chosen pages and the links between them", () => {
  const adj = new Map<string, Set<string>>([
    ["a", new Set(["b", "c"])], ["b", new Set(["a"])], ["c", new Set(["a"])],
  ]);
  const sub = subgraph(adj, new Set(["a", "b"]));
  expect([...sub.keys()]).toEqual(["a", "b"]);
  expect([...sub.get("a")!]).toEqual(["b"]);
  expect(adj.get("a")!.size).toBe(2); // the full graph is untouched
});

test("markSpans marks each whole word that starts with a query term, case-insensitively", () => {
  expect(markSpans("WireGuard on the wire, rewired", "wire")).toEqual([
    { text: "WireGuard", hit: true }, { text: " on the ", hit: false },
    { text: "wire", hit: true }, { text: ", rewired", hit: false },
  ]);
  expect(markSpans("Fleet inventory", "inv fl")).toEqual([
    { text: "Fleet", hit: true }, { text: " ", hit: false }, { text: "inventory", hit: true },
  ]);
  expect(markSpans("plain text", "")).toEqual([{ text: "plain text", hit: false }]);
  expect(markSpans("a.b", ".*")).toEqual([{ text: "a.b", hit: false }]); // no terms, no regex syntax
});

test("inlineTokens parses code, bold, wikilinks and links, and parses inside bold", () => {
  expect(inlineTokens("**[[widget|Widget]]** — `x` see [docs](https://e.com/a)")).toEqual([
    { t: "strong", kids: [{ t: "wikilink", raw: "widget|Widget" }] },
    { t: "text", v: " — " },
    { t: "code", v: "x" },
    { t: "text", v: " see " },
    { t: "link", label: "docs", href: "https://e.com/a" },
  ]);
  expect(inlineTokens("**Decommissioned (the owner):** gone")).toEqual([
    { t: "strong", kids: [{ t: "text", v: "Decommissioned (the owner):" }] },
    { t: "text", v: " gone" },
  ]);
  expect(inlineTokens("`**not bold**`")).toEqual([{ t: "code", v: "**not bold**" }]);
  expect(inlineTokens("[bad](javascript:alert(1))")).toEqual([{ t: "text", v: "[bad](javascript:alert(1))" }]);
});

test("inlineTokens parses *italic* and _italic_, but not snake_case, a * b * c, or inside code", () => {
  expect(inlineTokens("*turning on* and _Historical:_ x")).toEqual([
    { t: "em", kids: [{ t: "text", v: "turning on" }] },
    { t: "text", v: " and " },
    { t: "em", kids: [{ t: "text", v: "Historical:" }] },
    { t: "text", v: " x" },
  ]);
  expect(inlineTokens("**bold** *[[a|B]]*")).toEqual([
    { t: "strong", kids: [{ t: "text", v: "bold" }] },
    { t: "text", v: " " },
    { t: "em", kids: [{ t: "wikilink", raw: "a|B" }] },
  ]);
  expect(inlineTokens("snake_case_name and 2 * 3 * 4")).toEqual([{ t: "text", v: "snake_case_name and 2 * 3 * 4" }]);
  expect(inlineTokens("`_OceanofPDF.com_`")).toEqual([{ t: "code", v: "_OceanofPDF.com_" }]);
});

test("tableAt reads a pipe table, keeping pipes escaped or inside wikilinks and code in their cell", () => {
  const lines = [
    "intro",
    "| Name | Where | Note |",
    "|:-----|:-----:|-----:|",
    "| a | [[build-box\\|box]] over ssh | `x|y` |",
    "| b | [[home-network|Home]] |",
    "after",
  ];
  expect(tableAt(lines, 0)).toBeNull();
  expect(tableAt(lines, 1)).toEqual({
    align: ["left", "center", "right"],
    head: ["Name", "Where", "Note"],
    rows: [["a", "[[build-box|box]] over ssh", "`x|y`"], ["b", "[[home-network|Home]]", ""]],
    end: 5,
  });
  expect(tableAt(["| just a line |", "not a separator"], 0)).toBeNull();
});

test("quoteAt collects a run of > lines, and reads an Obsidian callout header", () => {
  const lines = ["para", "> **Not running** as of", "> today.", ">", "> - a list", "after"];
  expect(quoteAt(lines, 0)).toBeNull();
  expect(quoteAt(lines, 1)).toEqual({ callout: null, title: null, inner: ["**Not running** as of", "today.", "", "- a list"], end: 5 });
  expect(quoteAt(["> [!warning] Rewritten 2026-08-16", "> body"], 0))
    .toEqual({ callout: "warning", title: "Rewritten 2026-08-16", inner: ["body"], end: 2 });
  expect(quoteAt(["> [!note]", "> body"], 0)).toEqual({ callout: "note", title: "note", inner: ["body"], end: 2 });
});

test("listAt joins a wrapped item's continuation lines, indented or not, and stops at a blank line or a new block", () => {
  const lines = [
    "- **Bug 1:** STILL PRESENT. `applyAliasHop` is",
    "  byte-identical across the range.",
    "- Bug 2: the",
    "hash short-circuit is fine.",
    "  1. nested item",
    "## Heading",
    "- after the heading",
    "",
    "para",
  ];
  expect(listAt(lines, 0)).toEqual({
    ordered: false, start: 1, end: 5,
    items: [
      { text: "**Bug 1:** STILL PRESENT. `applyAliasHop` is byte-identical across the range.", list: null },
      { text: "Bug 2: the hash short-circuit is fine.", list: { ordered: true, start: 1, items: [{ text: "nested item", list: null }] } },
    ],
  });
  expect(listAt(lines, 5)).toBeNull();
  expect(listAt(lines, 6)).toEqual({ ordered: false, start: 1, end: 7, items: [{ text: "after the heading", list: null }] });
  expect(listAt(["- a", "> quote", "```", "| x |", "|---|"], 0)!.end).toBe(1);
  expect(listAt(["- a", "| x |", "|---|"], 0)!.end).toBe(1);
});

test("listAt reads numbered lists with their start, and nests by indentation", () => {
  const leaf = (text: string) => ({ text, list: null });
  expect(listAt(["3. third", "4. fourth"], 0)).toEqual({ ordered: true, start: 3, end: 2, items: [leaf("third"), leaf("fourth")] });
  expect(listAt([
    "- top",
    "    - deep",          // four spaces
    "\t- tab deep",        // a tab counts as four
    "  - back to two",     // between levels: a sibling list under the same item
    "- second top",
    "  1. one",
    "     wrapped",
  ], 0)).toEqual({
    ordered: false, start: 1, end: 7,
    items: [
      { text: "top", list: { ordered: false, start: 1, items: [leaf("deep"), leaf("tab deep"), leaf("back to two")] } },
      { text: "second top", list: { ordered: true, start: 1, items: [leaf("one wrapped")] } },
    ],
  });
});

test("isRule reads ---, ***, ___ and spaced forms, and nothing that is text, a list or a table", () => {
  for (const r of ["---", "***", "___", "- - -", "* * *", "  -----  "]) expect(isRule(r)).toBe(true);
  for (const r of ["--", "-- -x", "- a", "|---|", "    ---", "-*-"]) expect(isRule(r)).toBe(false);
  // A rule is not a list item, and ends a list rather than joining an item.
  expect(listAt(["* * *"], 0)).toBeNull();
  expect(listAt(["- a", "---", "- b"], 0)!.end).toBe(1);
});

test("quoteAt nests: the inside of a quote can start another quote", () => {
  const outer = quoteAt(["> outer", "> > inner", "> > more"], 0)!;
  expect(outer.inner).toEqual(["outer", "> inner", "> more"]);
  expect(quoteAt(outer.inner, 1)).toEqual({ callout: null, title: null, inner: ["inner", "more"], end: 3 });
});

test("setextLevel reads === as level 1 and --- as level 2, contiguous only", () => {
  expect(setextLevel("===")).toBe(1);
  expect(setextLevel("  =")).toBe(1);
  expect(setextLevel("---")).toBe(2);
  expect(setextLevel("-")).toBe(2);
  for (const l of ["- - -", "***", "=== x", "    ===", "", "=-="]) expect(setextLevel(l)).toBe(0);
});

test("inlineTokens parses ~~strikethrough~~, with markdown inside it", () => {
  expect(inlineTokens("~~**box lacks `ccrypt`**~~ fixed")).toEqual([
    { t: "del", kids: [{ t: "strong", kids: [{ t: "text", v: "box lacks " }, { t: "code", v: "ccrypt" }] }] },
    { t: "text", v: " fixed" },
  ]);
  expect(inlineTokens("a ~~ b ~~ c and ~one~")).toEqual([{ t: "text", v: "a ~~ b ~~ c and ~one~" }]);
});

test("listAt marks task items [ ] and [x], and leaves other items alone", () => {
  expect(listAt(["- [ ] open one", "- [x] done one", "- [X] done too", "- plain", "- [link](https://e.com)"], 0)!.items).toEqual([
    { text: "open one", list: null, task: false },
    { text: "done one", list: null, task: true },
    { text: "done too", list: null, task: true },
    { text: "plain", list: null },
    { text: "[link](https://e.com)", list: null },
  ]);
});

test("strikethrough may hold a single ~, as in a home-directory path", () => {
  expect(inlineTokens("~~**gstack** at `~/.claude/skills/gstack`~~ — removed")).toEqual([
    { t: "del", kids: [{ t: "strong", kids: [{ t: "text", v: "gstack" }] }, { t: "text", v: " at " }, { t: "code", v: "~/.claude/skills/gstack" }] },
    { t: "text", v: " — removed" },
  ]);
});

test("a / ending the query makes it match whole words only, in titles and slugs", () => {
  const pages = [
    { slug: "bin-toolbelt-repo", title: "./bin — shared personal toolbelt", type: null },
    { slug: "binary-formats", title: "Binary formats", type: null },
    { slug: "sbin-notes", title: "sbin notes", type: null },
  ];
  expect([...matchPages(pages, "bin")!]).toEqual(["bin-toolbelt-repo", "binary-formats", "sbin-notes"]);
  expect([...matchPages(pages, "bin/")!]).toEqual(["bin-toolbelt-repo"]);
  expect(matchPages(pages, "/")).toBeNull();                                  // a / alone is no query
  expect(parseQuery("bin  tools/")).toMatchObject({ text: "bin tools", word: true });
  // Only a / that is the very last character counts; anything after it, even a space, makes it text.
  expect(parseQuery("bin/ ")).toMatchObject({ text: "bin/", word: false });
  expect(parseQuery("bin/ tools")).toMatchObject({ text: "bin/ tools", word: false });
  expect(parseQuery("bin/tools")).toMatchObject({ text: "bin/tools", word: false });
  expect(parseQuery("-w bin")).toMatchObject({ text: "-w bin", word: false });   // -w is no longer a flag
});

test("a whole-word query marks only whole-word matches", () => {
  expect(markSpans("bin binary ./bin sbin", "bin/").filter((s) => s.hit).map((s) => s.text)).toEqual(["bin", "bin"]);
  expect(markSpans("bin binary", "bin").filter((s) => s.hit).map((s) => s.text)).toEqual(["bin", "binary"]);
});

test("a hyphenated or quoted term is a phrase: its words in order, next to each other", () => {
  expect(parseQuery('needs-x2 "git push"/').terms).toEqual([["needs", "x2"], ["git", "push"]]);
  expect(parseQuery("bin ./bin").terms).toEqual([["bin"], ["bin"]]);
  const pages = [
    { slug: "2026-08-18-needs-x2-hardening-session", title: "needs-x2 hardening", type: null },
    { slug: "x2-needs-list", title: "What x2 needs", type: null },
    { slug: "git-push-hooks", title: "Hooks", type: null },
    { slug: "push-git", title: "Push to git", type: null },
  ];
  expect([...matchPages(pages, "needs-x2")!]).toEqual(["2026-08-18-needs-x2-hardening-session"]);
  expect([...matchPages(pages, '"git push"')!]).toEqual(["git-push-hooks"]);
  expect([...matchPages(pages, "needs-x")!]).toEqual(["2026-08-18-needs-x2-hardening-session"]); // last word may be a prefix
  expect([...matchPages(pages, "needs-x/")!]).toEqual([]);                                         // not as a whole word
});

test("highlighting marks a phrase as one run, and not its words apart", () => {
  const hits = (text: string, q: string) => markSpans(text, q).filter((s) => s.hit).map((s) => s.text);
  expect(hits("needs-x2 here, but x2 needs that", "needs-x2")).toEqual(["needs-x2"]);
  expect(hits("run git push, then push to git", '"git push"')).toEqual(["git push"]);
  expect(hits("needs-x2 and needs-x2s", "needs-x2/")).toEqual(["needs-x2"]);
});
