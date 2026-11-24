import type { PagesStore } from "../pages/store.js";
import type { DetectedFinding } from "./types.js";
import { contentLines, extractLinks, inlineFieldName, isLinkType } from "../pages/parse.js";
import { findSecrets } from "../pages/secret-guard.js";

// Dated session logs and daily notes are orphans by design, not gaps: nothing is
// expected to link to them. The gardener already excludes them in prose every
// night; doing it here keeps ten permanent non-findings out of the ledger.
const ORPHAN_EXCLUDED_PREFIXES = ["raw/", "daily/"];

export function detectOrphans(store: PagesStore): DetectedFinding[] {
  return store.orphans()
    .filter((slug) => {
      const path = store.getPage(slug)?.source_path ?? "";
      return !ORPHAN_EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
    })
    .map((slug) => ({ kind: "orphan", subject: slug, detail: "no inbound links" }));
}

export function detectUnresolved(store: PagesStore): DetectedFinding[] {
  const byTarget = new Map<string, string[]>();
  for (const row of store.listUnresolved()) {
    const list = byTarget.get(row.raw_text) ?? [];
    list.push(row.from_slug);
    byTarget.set(row.raw_text, list);
  }
  return [...byTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, from]) => ({
      kind: "unresolved",
      subject: target,
      detail: `linked from ${[...from].sort().join(", ")}`,
    }));
}

// A link-bearing inline field whose name is not in LINK_TYPES. Its links were
// stored as plain wikilinks, so without this a typo'd type degrades silently.
// Keyed on page + field name, not line number: lines move on every edit and the
// finding would flap. A field with no link (`status:: done`) is not an attempt
// at a link type and is left alone.
export function detectUnknownLinkTypes(store: PagesStore): DetectedFinding[] {
  const out: DetectedFinding[] = [];
  for (const page of store.listAuthoredWithRecency()) {
    for (const [name, lines] of unknownLinkFields(page.body)) {
      const where = lines.length === 1 ? `: ${lines[0]}` : ` on ${lines.length} lines, first: ${lines[0]}`;
      out.push({
        kind: "unknown-link-type",
        subject: `${page.slug}:${name}`,
        detail: `\`${name}::\` is not a link type; stored as a plain wikilink${where}`,
      });
    }
  }
  return out;
}

// Field name -> the trimmed lines using it, for every link-bearing inline field
// in `body` whose name is not a link type. Shared with `macbrain check`, so the
// write-time hook and the nightly sweep cannot disagree about what is wrong.
export function unknownLinkFields(body: string): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const { line } of contentLines(body)) {
    const name = inlineFieldName(line);
    if (name === undefined || isLinkType(name) || extractLinks(line).length === 0) continue;
    byName.set(name, [...(byName.get(name) ?? []), line.trim()]);
  }
  return byName;
}

// A credential-shaped line in a live authored page. One finding per page, so
// moving a line does not churn the key; the detail names rules and body line
// numbers, never the matched text, because findings are shown in the
// SessionStart hook and over every connector. Removing the line resolves it;
// a token that was ever committed still needs rotating, which no sweep sees.
export function detectSecrets(store: PagesStore): DetectedFinding[] {
  const out: DetectedFinding[] = [];
  for (const page of store.listAuthoredWithRecency()) {
    const hits = findSecrets(page.body);
    if (hits.length === 0) continue;
    out.push({
      kind: "secret",
      subject: page.slug,
      detail: `possible secret, remove it and rotate if real: ${hits.map((h) => `${h.rule} body line ${h.line}`).join(", ")}`,
    });
  }
  return out;
}

// R1: a line asserting something WILL happen on a date that has since passed.
// Both signals must be on the same line. Markdown here is line-oriented
// (bullets, table rows) and sentence segmentation would be a second thing to get
// wrong.
const FUTURE_MARKER = /\b(will|scheduled for|planned for|upcoming|next)\b/i;
// ISO only. The vault dates in ISO consistently, and a looser date pattern is
// the same precision risk that got R3 deferred.
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

// R2: an unchecked box on a page nobody has touched in this long.
const STALE_TODO_DAYS = 90;
const UNCHECKED_BOX = /^\s*[-*]\s+\[ \]\s+/;

export function detectRot(store: PagesStore, now: Date): DetectedFinding[] {
  const out: DetectedFinding[] = [];
  const today = now.toISOString().slice(0, 10);
  const staleBefore = new Date(now.getTime() - STALE_TODO_DAYS * 86400000).toISOString();

  for (const page of store.listAuthoredWithRecency()) {
    const lines = contentLines(page.body);

    for (const { line, n } of lines) {
      if (!FUTURE_MARKER.test(line)) continue;
      const m = ISO_DATE.exec(line);
      if (!m || m[1] >= today) continue;
      out.push({
        kind: "rot-future-date",
        subject: `${page.slug}#${n}`,
        detail: line.trim(),
      });
    }

    if (page.recency < staleBefore) {
      const boxes = lines.filter(({ line }) => UNCHECKED_BOX.test(line));
      if (boxes.length > 0) {
        out.push({
          kind: "rot-stale-todo",
          subject: page.slug,
          detail: `${boxes.length} unchecked item(s), untouched since ${page.recency.slice(0, 10)}; first: ${boxes[0].line.trim()}`,
        });
      }
    }
  }
  return out;
}

// Staleness from the OKF v0.2 trust fields the vault already uses (spec/okf.md
// §5.2, §5.5). Declared, not inferred: inferring it from page content was tried
// (R1/R2 above) and found nothing real, so a page with neither field is never
// stale.
//   - `stale_after: YYYY-MM-DD`: stale when today >= that date. When present
//     it decides alone, so an author can vouch for a page past the limit.
//   - otherwise `verified` ({ by, at } or a list of them): stale when the
//     latest `at` is more than `maxAgeDays` before today.
// Details name dates and the limit but never an age, so they do not change
// from night to night (the findings page must stay byte-deterministic). A
// malformed field is reported, since a typo would otherwise switch the check
// off silently.
export const DEFAULT_STALE_DAYS = 180;
const DAY_MS = 86_400_000;
const BAD_VERIFIED = "`verified` entries need a by and a valid ISO 8601 at (spec/okf.md §5.2)";

export function detectStale(store: PagesStore, now: Date, maxAgeDays: number): DetectedFinding[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: DetectedFinding[] = [];
  const flag = (subject: string, detail: string) => out.push({ kind: "stale", subject, detail });
  for (const page of store.listPages()) {
    if (page.generator !== null) continue;
    const fm = page.frontmatter;
    if ("stale_after" in fm) {
      const value = dayString(fm.stale_after);
      const at = isoDay(value);
      if (at === null) flag(page.slug, `\`stale_after\` is not a YYYY-MM-DD date: ${value.slice(0, 40)}`);
      else if (today >= at) flag(page.slug, `stale_after ${value} has passed; re-check the page and move stale_after or verified forward`);
    } else if ("verified" in fm) {
      const latest = latestVerified(fm.verified);
      if (latest === null) flag(page.slug, BAD_VERIFIED);
      else if ((today - latest) / DAY_MS > maxAgeDays) {
        flag(page.slug, `last verified ${new Date(latest).toISOString().slice(0, 10)}, older than ${maxAgeDays} days; re-check the page and add a verified entry`);
      }
    }
  }
  return out;
}

// Midnight UTC of the latest `at` across the entries, or null if any entry is
// not a mapping with a non-empty `by` and a valid ISO 8601 `at`. A bare mapping
// is a one-element list, as OKF requires.
function latestVerified(v: unknown): number | null {
  const entries = Array.isArray(v) ? v : [v];
  if (entries.length === 0) return null;
  let latest = -Infinity;
  for (const e of entries) {
    if (typeof e !== "object" || e === null) return null;
    const { by, at } = e as { by?: unknown; at?: unknown };
    if (typeof by !== "string" || by.trim() === "") return null;
    const day = isoDay(dayString(at).slice(0, 10));
    if (day === null || (typeof at === "string" && Number.isNaN(Date.parse(at)))) return null;
    latest = Math.max(latest, day);
  }
  return latest;
}

// YAML may hand back a Date for an unquoted timestamp; everything else as text.
function dayString(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
}

// Midnight UTC of a real calendar date written as YYYY-MM-DD, else null.
function isoDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}
