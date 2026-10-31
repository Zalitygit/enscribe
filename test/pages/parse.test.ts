import { expect, test } from "vitest";
import { parseFrontmatter, firstH1, frontmatterAliases } from "../../src/pages/parse.js";
import { extractLinks, extractMdLinks } from "../../src/pages/parse.js";
import { chunkBody, splitSections } from "../../src/pages/parse.js";

test("parseFrontmatter splits YAML frontmatter from body", () => {
  const raw = `---\ntitle: Full Title\naliases:\n  - an-alias\ntags: [infra, brain]\n---\n# Full Title\n\nBody text.\n`;
  const { frontmatter, body } = parseFrontmatter(raw);
  expect(frontmatter.title).toBe("Full Title");
  expect(frontmatter.aliases).toEqual(["an-alias"]);
  expect(frontmatter.tags).toEqual(["infra", "brain"]);
  expect(body).toBe("# Full Title\n\nBody text.\n");
});

test("parseFrontmatter with no frontmatter returns empty object and full body", () => {
  const { frontmatter, body } = parseFrontmatter("# Just a heading\n\ntext");
  expect(frontmatter).toEqual({});
  expect(body).toBe("# Just a heading\n\ntext");
});

test("firstH1 extracts the first level-1 heading", () => {
  expect(firstH1("intro\n# The Title\nmore")).toBe("The Title");
  expect(firstH1("## only h2\nno h1")).toBeNull();
});

test("frontmatterAliases normalizes list, scalar, and missing shapes", () => {
  expect(frontmatterAliases({ aliases: ["a", "b"] })).toEqual(["a", "b"]);
  expect(frontmatterAliases({ aliases: "solo" })).toEqual(["solo"]);
  expect(frontmatterAliases({})).toEqual([]);
});

test("extractLinks captures plain and display-piped wikilinks", () => {
  const links = extractLinks("See [[Full Title]] and [[the-slug|its slug]].");
  expect(links).toEqual([
    { raw: "Full Title", display: null },
    { raw: "the-slug", display: "its slug" },
  ]);
});

// `raw` feeds PagesStore.resolve() directly, so anything that is not part of
// the TARGET has to be off it by the time it leaves here. Anchors and path
// prefixes were being folded into the slug, so [[Design Notes#Typography]]
// slugified to "design-notes-typography" and could never resolve. Slugs are
// flat basenames, so a path qualifier is likewise not part of the identity.

test("extractLinks strips a heading anchor from the target", () => {
  expect(extractLinks("See [[Design Notes#Typography]].")).toEqual([
    { raw: "Design Notes", display: null },
  ]);
});

test("extractLinks strips a block-id anchor from the target", () => {
  expect(extractLinks("See [[Design Notes#^a1b2c3]].")).toEqual([
    { raw: "Design Notes", display: null },
  ]);
});

// The regression guard on the half of this fix that was reverted. Titles in
// this vault legitimately contain slashes, and stripping to the basename broke
// seven live links to fix none. See the comment on linkTarget.
test("extractLinks does NOT strip a slash inside a title", () => {
  expect(extractLinks("See [[Voice Bot / Relay Assistant]].")).toEqual([
    { raw: "Voice Bot / Relay Assistant", display: null },
  ]);
});

test("extractLinks strips an anchor while leaving a slashed title intact", () => {
  expect(extractLinks("See [[Voice Bot / Relay Assistant#Setup|the assistant]].")).toEqual([
    { raw: "Voice Bot / Relay Assistant", display: "the assistant" },
  ]);
});

// A same-page anchor names no page. Emitting it would resolve to nothing and
// seed a permanent unresolved-link finding that no edit could clear.
test("extractLinks drops a same-page anchor entirely", () => {
  expect(extractLinks("Jump to [[#Local Heading]] below.")).toEqual([]);
});

test("extractLinks leaves an ordinary target untouched", () => {
  expect(extractLinks("See [[full-title]].")).toEqual([
    { raw: "full-title", display: null },
  ]);
});

test("extractLinks ignores links inside fenced and inline code", () => {
  const body = "real [[Keeper]]\n```\ncode [[Fenced]] here\n```\ninline `[[Inline]]` text";
  const links = extractLinks(body);
  expect(links).toEqual([{ raw: "Keeper", display: null }]);
});

// Obsidian resolves a title containing inline code; stripping the code first
// left "Acme  skill (...)" in wiki/log.md and wiki/index.md.
test("extractLinks keeps inline code that sits inside a wikilink", () => {
  const body = "see [[Acme `/invoice` skill (billing)]] and `[[Inline]]`";
  expect(extractLinks(body)).toEqual([{ raw: "Acme `/invoice` skill (billing)", display: null }]);
});

test("extractLinks: a stray backtick does not swallow links on other lines", () => {
  const body = "Use a ` backtick here\n[[Survivor]] on the next line";
  expect(extractLinks(body)).toEqual([{ raw: "Survivor", display: null }]);
});

test("extractLinks: an unclosed fence suppresses only its block; links before it survive", () => {
  const body = "[[Before]]\n```\n[[InsideUnclosed]]\n[[AlsoInside]]";
  expect(extractLinks(body)).toEqual([{ raw: "Before", display: null }]);
});

test("extractLinks: tilde fences are recognized", () => {
  const body = "[[Keep]]\n~~~\n[[Hidden]]\n~~~\n[[Keep2]]";
  expect(extractLinks(body)).toEqual([{ raw: "Keep", display: null }, { raw: "Keep2", display: null }]);
});

// Typed edges (docs/superpowers/specs/2026-10-22-typed-edges-design.md): a
// Dataview inline field at the start of a line types every link on that line.
test("extractLinks types each link on an inline-field line", () => {
  expect(extractLinks("depends-on:: [[macbrain]], [[eero-mcp-server|eero]]")).toEqual([
    { raw: "macbrain", display: null, type: "depends-on" },
    { raw: "eero-mcp-server", display: "eero", type: "depends-on" },
  ]);
});

test("extractLinks accepts an inline field written as a list item", () => {
  expect(extractLinks("- runs-on:: [[hub]]")).toEqual([{ raw: "hub", display: null, type: "runs-on" }]);
});

test("extractLinks leaves a field outside the vocabulary untyped", () => {
  const [link] = extractLinks("hosted-on:: [[hub]]");
  expect(link).toEqual({ raw: "hub", display: null });
  expect(link.type).toBeUndefined();
});

test("extractLinks only types a field at line start, not prose containing ::", () => {
  const [link] = extractLinks("Note that runs-on:: [[hub]] is the syntax.");
  expect(link.type).toBeUndefined();
});

test("extractLinks ignores an inline field inside a fence", () => {
  expect(extractLinks("```\nruns-on:: [[hub]]\n```")).toEqual([]);
});

test("chunkBody splits on headings and carries the heading", () => {
  const body = "preamble\n# Alpha\naaa\n## Beta\nbbb";
  const chunks = chunkBody(body);
  expect(chunks.map((c) => c.heading)).toEqual([null, "Alpha", "Beta"]);
  expect(chunks[0].ordinal).toBe(0);
  expect(chunks[2].ordinal).toBe(2);
  expect(chunks[1].text).toContain("aaa");
});

test("chunkBody sub-splits an oversized section with overlap", () => {
  const big = "# Big\n" + "x".repeat(4000);
  const chunks = chunkBody(big);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((c) => c.heading === "Big")).toBe(true);
  expect(chunks.every((c) => c.text.length <= 1500)).toBe(true);
});

test("chunkBody returns empty for whitespace-only body", () => {
  expect(chunkBody("   \n  ")).toEqual([]);
});

test("chunkBody windows an oversized section with full coverage and no dropped or duplicate tail", () => {
  const body = "# Big\n" + "x".repeat(4000); // 4006 chars; cap 1500, step 1300
  const chunks = chunkBody(body);
  // Expected windows [0,1500) [1300,2800) [2600,4006) => exactly 3 chunks.
  // A break firing too early drops the tail (2 chunks); a stray extra window
  // past the end adds a redundant duplicate (4 chunks).
  expect(chunks.length).toBe(3);
  // First window starts at the beginning; last window reaches the very end.
  expect(body.startsWith(chunks[0].text)).toBe(true);
  expect(body.endsWith(chunks[chunks.length - 1].text)).toBe(true);
  expect(chunks.every((c) => c.text.length <= 1500)).toBe(true);
});

// splitSections backs get_page's `section` argument and its outline for pages
// over the output cap. It is fence-aware like extractLinks, and deliberately
// separate from chunkBody: changing that splitter changes CHUNK_SCHEME and
// re-embeds the vault.
test("splitSections: a section runs to the next heading of the same or higher level", () => {
  const body = "intro\n\n## Alpha\na\n### Alpha child\nac\n## Beta\nb\n";
  const s = splitSections(body);
  expect(s.map((x) => [x.heading, x.level])).toEqual([["Alpha", 2], ["Alpha child", 3], ["Beta", 2]]);
  expect(s[0].text).toBe("## Alpha\na\n### Alpha child\nac\n");
  expect(s[1].text).toBe("### Alpha child\nac\n");
  expect(s[2].text).toBe("## Beta\nb\n");
});

test("splitSections ignores a heading-shaped line inside a code fence", () => {
  const body = "## Real\n```sh\n## not a heading\n```\n## Also real\n";
  expect(splitSections(body).map((x) => x.heading)).toEqual(["Real", "Also real"]);
  expect(splitSections(body)[0].text).toContain("## not a heading");
});

test("splitSections keeps inline code in the heading text", () => {
  expect(splitSections("## `put_page` and `findings`\nx\n")[0].heading).toBe("`put_page` and `findings`");
});

// Relative Markdown links are page edges too. ~/van/docs/00-index.md links 90+
// pages this way and none of them counted, because wikilinks print literally in
// the rendered PDFs, so the shared docs avoid them.

test("extractMdLinks captures relative .md targets and drops the anchor", () => {
  expect(extractMdLinks("See [Arch](van-architecture-overview.md) and [S](../x/sfh.md#routing).")).toEqual([
    { href: "van-architecture-overview.md", display: "Arch" },
    { href: "../x/sfh.md", display: "S" },
  ]);
});

test("extractMdLinks ignores URLs, absolute paths, non-.md targets and images", () => {
  expect(extractMdLinks(
    "[a](https://h/x.md) [b](/abs/y.md) [c](diagram.png) ![d](z.md) [e](mailto:q.md)",
  )).toEqual([]);
});

test("extractMdLinks ignores links inside code", () => {
  expect(extractMdLinks("```\n[a](a.md)\n```\n`[b](b.md)` [c](c.md)\n")).toEqual([
    { href: "c.md", display: "c" },
  ]);
});

test("extractMdLinks accepts an angle-bracketed target and a link title", () => {
  expect(extractMdLinks('[a](<my doc.md>) [b](b.md "Title")')).toEqual([
    { href: "my doc.md", display: "a" },
    { href: "b.md", display: "b" },
  ]);
});
