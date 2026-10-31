import { parse as parseYaml } from "yaml";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

// A leading `---\n ... \n---` YAML frontmatter block; group 1 is the YAML.
// Shared with editPage, which refuses any edit that changes this block. No `g`
// flag: a global regex carries lastIndex state between calls.
export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

// Split a leading frontmatter block from the markdown body.
// No block ⇒ empty frontmatter and the raw text as body.
export function parseFrontmatter(raw: string): ParsedDoc {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(m[1]) ?? {};
  const frontmatter = (typeof parsed === "object" && !Array.isArray(parsed))
    ? (parsed as Record<string, unknown>)
    : {};
  return { frontmatter, body: raw.slice(m[0].length) };
}

// The first ATX level-1 heading in the body, or null.
export function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Frontmatter `aliases:` as a string list, accepting list, scalar, or missing.
export function frontmatterAliases(fm: Record<string, unknown>): string[] {
  const a = fm.aliases;
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
  if (typeof a === "string") return [a];
  return [];
}

// Frontmatter `type:` as a non-empty string, or null. The OKF concept type the
// vault carries on every page (`concept`, `entity`, `source`, `synthesis`,
// `reference`); producers may use any string and consumers must tolerate an
// unknown one, so this validates the SHAPE and never the value. Anything that is
// not a non-empty string — `type: [a, b]`, `type: 3`, an empty scalar — becomes
// null rather than being coerced, since `pages.type` is TEXT and a stringified
// array is a value nothing could ever route on.
export function frontmatterType(fm: Record<string, unknown>): string | null {
  return typeof fm.type === "string" && fm.type.length > 0 ? fm.type : null;
}

// Frontmatter `sources:` as a string list (list, scalar, or missing), with a
// trailing `.md` stripped so a filename source resolves the same as a slug.
export function frontmatterSources(fm: Record<string, unknown>): string[] {
  const s = fm.sources;
  const arr = Array.isArray(s) ? s : typeof s === "string" ? [s] : [];
  return arr
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/\.md$/i, ""))
    .filter((x) => x.length > 0);
}

// The closed typed-edge vocabulary (docs/superpowers/specs/2026-10-22-typed-edges-design.md).
// Every edge reads "this page <type> target". Adding a type is an edit here plus
// a row in the spec's table; a field name not in this list types nothing.
export const LINK_TYPES = [
  "runs-on",
  "depends-on",
  "source-in",
  "replaces",
  "part-of",
  "owned-by",
  "disambiguates",
  "falls-back-to",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

// Every link_type page_links can hold: the authored vocabulary plus the three
// that resolveLinks writes for an untyped wikilink, a relative Markdown link
// and a frontmatter source.
export const EDGE_TYPES = ["wikilink", "mdlink", "source", ...LINK_TYPES] as const;

export interface WikiLink {
  raw: string;
  display: string | null;
  // Set only when the link sits on a `<type>:: ...` inline-field line whose
  // name is in LINK_TYPES. Absent, not null, so an untyped link keeps its shape.
  type?: LinkType;
}

// The name of a Dataview inline field at line start, optionally as a list item:
// `runs-on:: [[hub]]` or `- depends-on:: [[a]], [[b]]`. Mid-line `::` is prose.
// Captured loosely (any case, underscores) so detectUnknownLinkTypes can flag a
// near-miss like `Runs-On::`; only an exact LINK_TYPES name types a link.
export function inlineFieldName(line: string): string | undefined {
  return line.match(/^\s*(?:[-*+]\s+)?([A-Za-z][\w-]*)::\s/)?.[1];
}

export const isLinkType = (name: string): name is LinkType =>
  (LINK_TYPES as readonly string[]).includes(name);

function inlineFieldType(line: string): LinkType | undefined {
  const name = inlineFieldName(line);
  return name !== undefined && isLinkType(name) ? name : undefined;
}

// Lines of `body` that are real prose: fenced code blocks dropped entirely,
// inline code stripped per line. `n` is the 1-based line number in the original
// body, which the rot detectors use to key a finding to a location.
//
// Shared with extractLinks so the fence state machine exists exactly once. A
// second copy would drift, and both callers depend on the same CommonMark
// convention that an unclosed fence extends to end of input.
export function contentLines(body: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  let inFence = false;
  body.split("\n").forEach((raw, i) => {
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    // A wikilink is matched as a unit so inline code inside its target survives;
    // the leftmost match wins, so a wikilink inside inline code is still stripped.
    out.push({ line: raw.replace(/\[\[[^\]]*\]\]|`[^`]*`/g, (m) => (m.startsWith("[[") ? m : "")), n: i + 1 });
  });
  return out;
}

// Extract [[Target]] and [[Target|Display]] wikilinks, ignoring any inside code.
// A rare single line with an odd number of backticks may still drop that line's
// links — an accepted limit vs a full CommonMark tokenizer.
// Reduce a wikilink's inner text to the part that names a PAGE. `raw` is handed
// straight to PagesStore.resolve(), so anything else folded into it becomes part
// of the slug and cannot resolve: [[Design Notes#Typography]] slugified whole to
// "design-notes-typography", which is not a page and never will be. Dropping
// `#...` also covers Obsidian's `#^blockid` block-reference form.
//
// An empty result means the link named no page (a bare same-page `[[#anchor]]`)
// and the caller drops it, rather than recording an unresolved link that no edit
// could ever clear.
//
// PATH QUALIFIERS ARE DELIBERATELY NOT STRIPPED, and the tracked follow-up
// asking for it was wrong for this corpus. Slugs are flat basenames, so
// [[concepts/Struktura]] genuinely cannot resolve — but taking the last `/`
// segment to fix it is a net loss here. Measured against the live vault
// (2026-08-16): zero links carry a path qualifier that stripping would repair,
// while SEVEN carry a slash inside a legitimate TITLE and resolve today —
// one page title of the form "A / B" five times, and an `/invoice` skill
// title twice. Stripping breaks all seven to fix none. The only true
// path-qualified links live in README.md, which is outside the ingest include
// list, so they would stay unresolved either way. If this is ever revisited, the
// fallback belongs in resolve() as a further tier (try the whole string, then
// the basename), not in the parser, which cannot see whether either resolves.
function linkTarget(inner: string): string {
  return inner.split("#")[0]!.trim();
}

export function extractLinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  for (const { line } of contentLines(body)) {
    const type = inlineFieldType(line);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = linkTarget(m[1]);
      if (!raw) continue;
      const link: WikiLink = { raw, display: m[2]?.trim() ?? null };
      if (type) link.type = type;
      links.push(link);
    }
  }
  return links;
}

export interface MdLink {
  href: string;
  display: string;
}

// Extract inline Markdown links to a relative `.md` file: [Text](path.md),
// [Text](path.md#anchor), [Text](<path with spaces.md>), [Text](path.md "Title").
// `href` is still a PATH, relative to the linking file; the caller resolves it
// against stored source paths, because only it knows where the linker lives.
// URLs (any scheme), absolute paths, images and non-.md targets are skipped.
export function extractMdLinks(body: string): MdLink[] {
  const links: MdLink[] = [];
  const re = /(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
  for (const { line } of contentLines(body)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[1]) continue;
      const href = (m[3] ?? m[4])!.split("#")[0]!.trim();
      if (!/\.md$/i.test(href) || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      links.push({ href, display: m[2]!.trim() });
    }
  }
  return links;
}

export interface Chunk {
  ordinal: number;
  heading: string | null;
  text: string;
}

const CHUNK_CAP = 1500;
const CHUNK_OVERLAP = 200;

// Names the current chunking + embedding-input convention, stamped on every
// chunk row. Bump it whenever the convention changes (as migration 004 did when
// the page title started prefixing each chunk). Without a name on the row there
// is no way to tell which chunks predate a change, which is why 004 had to clear
// every content_hash and re-embed the whole vault instead of just the stale part.
export const CHUNK_SCHEME = "heading-window-title-prefixed-v1";

// Heading-aware chunking: split the body into sections at ATX headings (the
// heading line stays with its section), then window any section longer than
// CHUNK_CAP with CHUNK_OVERLAP so long sections stay retrievable without losing
// cross-boundary context. Ordinals are assigned in document order.
export function chunkBody(body: string): Chunk[] {
  const sections: { heading: string | null; text: string }[] = [];
  let cur: { heading: string | null; text: string } = { heading: null, text: "" };
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      if (cur.text.trim() || cur.heading) sections.push(cur);
      cur = { heading: h[1].trim(), text: line + "\n" };
    } else {
      cur.text += line + "\n";
    }
  }
  if (cur.text.trim() || cur.heading) sections.push(cur);

  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const s of sections) {
    const t = s.text.trim();
    if (!t) continue;
    if (t.length <= CHUNK_CAP) {
      chunks.push({ ordinal: ordinal++, heading: s.heading, text: t });
    } else {
      for (let i = 0; i < t.length; i += CHUNK_CAP - CHUNK_OVERLAP) {
        chunks.push({ ordinal: ordinal++, heading: s.heading, text: t.slice(i, i + CHUNK_CAP) });
        // Break AFTER pushing the window that reaches the section end: this window
        // covers the tail, so any further window would slice to the same end and be
        // wholly contained in it (a redundant duplicate).
        if (i + CHUNK_CAP >= t.length) break;
      }
    }
  }
  return chunks;
}

export interface Section {
  heading: string;
  level: number;
  // The heading line through the line before the next heading of the same or
  // a higher level, so an H2's text includes its H3 children.
  text: string;
}

// Heading-delimited sections of `body`, in document order, for get_page's
// `section` argument and the outline it returns for an over-cap page. Fence-
// aware through contentLines (a `## ` inside a code block is not a heading);
// heading text is taken from the original line so inline code survives. Text
// before the first heading is not a section: nothing can name it.
//
// Deliberately NOT chunkBody: that splitter's output is CHUNK_SCHEME, and a
// change there re-embeds the vault.
export function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const heads: { idx: number; level: number; heading: string }[] = [];
  for (const { n } of contentLines(body)) {
    const m = lines[n - 1].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) heads.push({ idx: n - 1, level: m[1].length, heading: m[2] });
  }
  return heads.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) { end = heads[j].idx; break; }
    }
    const text = lines.slice(h.idx, end).join("\n");
    return { heading: h.heading, level: h.level, text: end < lines.length ? text + "\n" : text };
  });
}
