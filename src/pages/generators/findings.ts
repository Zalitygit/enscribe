import type { Generator, GeneratedPage, GeneratorContext } from "./types.js";
import type { Finding } from "../../findings/types.js";
import { dueDate } from "../../findings/due.js";

// NOTE: this body must never contain a [[wikilink]]. runGenerators lints
// generated pages and one unresolved link fails the entire nightly run — and
// this page's whole job is to name unresolved link targets. Backticks only.
//
// NOTE: the body must be deterministic. No timestamps, no run counters, every
// list sorted. A body that differs run to run re-chunks and re-embeds nightly.
const KIND_TITLES: Record<string, string> = {
  orphan: "Orphans",
  unresolved: "Unresolved links",
  "unknown-link-type": "Unknown link types",
  "red-link": "Red links (Obsidian)",
  contradiction: "Contradictions",
  "rot-future-date": "Past-dated future claims",
  "rot-stale-todo": "Stale unchecked items",
};

// first_seen/last_seen/times_reported deliberately do NOT appear in the
// rendered line: times_reported increments and last_seen advances on every
// detection run, so a body that included either would differ night to night
// by construction and never hit content_hash/embed_hash. They remain in the
// ledger and the gardener's digest for anyone who needs them.
//
// detail/note are free text — for `contradiction`, LLM output captured by
// brain-gardener's probe — and must not be trusted to be wikilink-free. A
// `[[Foo]]` here would create an unresolved-link finding about this very
// page, which would render right back into it: permanent, self-sustaining
// noise the vault owner cannot fix by editing anything. Neutralise `[[`
// before it ever reaches the body.
// replaceAll("[[", "[ [") only breaks non-overlapping pairs, so a run of 3+
// "[" (plausible in LLM-authored free text) leaves a residual "[[" that still
// matches parse.ts's wikilink regex and reopens the finding loop above.
// Inserting a space after every "[" followed by another "[" covers any run
// length in one pass, since it looks one character ahead rather than
// consuming a fixed two-character token.
const escape = (s: string): string => s.replace(/\[(?=\[)/g, "[ ");

const line = (f: Finding): string => `- \`${f.subject}\` — ${escape(f.detail)}`;

// A todo renders as ONE markdown list line, so a multi-line detail must not
// reach it: `"line one\n## fake heading"` would otherwise emit a real `##`
// heading mid-section and break the page structure. Collapsing here, not in
// `escape`, because `block()` (needs-human) deliberately keeps multi-line detail
// intact — an ask carries commands and a pass/fail signature, and only the
// one-line renderers (this and `line`) need it flattened.
const collapseNewlines = (s: string): string => s.replace(/\n+/g, " ");

// A todo is a dated item the owner asked for, so it renders as a line with its day
// on it — not the needs-human block, whose whole point is carrying commands and
// a pass/fail signature, and not the bare detector line, which has nowhere to
// put a deadline. The stored value is an end-of-day instant; the day is what
// they typed and what they read. times_reported is deliberately absent: it moves
// when an item is re-filed and this section must stay byte-identical between
// real changes.
// `doc` renders in BACKTICKS, never as a [[wikilink]]. The generator lint
// fails the whole run over one unresolved link in a generated page, and a doc
// may legitimately name a page that does not exist yet — filing the ask before
// writing the page is the normal order. A link here would turn that ordinary
// case into a failed nightly.
const todoLine = (f: Finding): string =>
  `- \`${escape(f.subject)}\`${f.due ? ` (due ${dueDate(f.due)})` : ""}${f.doc ? ` (doc \`${escape(f.doc)}\`)` : ""} — ${collapseNewlines(escape(f.detail))}`;

// needs-human items get a heading and their detail in full, where a detector
// finding gets one line. The difference is what the item is: a detector
// reports a condition ("no inbound links"), an ask carries the commands to
// run and the output that means it worked, and flattening that to a line
// leaves the owner to reconstruct it.
//
// times_reported appears here and nowhere else on this page. On a detector
// finding it advances every nightly sweep whether or not anything changed,
// which would break the body's byte-determinism; nothing sweeps for needs-human,
// so it moves only when a session deliberately files the ask again. That is a
// real content change, and "asked 3 times" is the fact the ledger exists to
// keep.
const block = (f: Finding): string => {
  const meta = [
    f.due ? `due ${f.due}` : null,
    // Backticks, not a wikilink — see todoLine above for why.
    f.doc ? `assignment in \`${escape(f.doc)}\`` : null,
    f.times_reported > 1 ? `asked ${f.times_reported} times` : null,
  ].filter(Boolean).join(", ");
  return `### ${escape(f.subject)}\n${meta ? `\n${meta}\n` : ""}\n${escape(f.detail)}`;
};

// Deadline first, undated last, key as the tiebreak so the order is total and
// the body stays byte-identical run to run.
const byDue = (a: Finding, b: Finding): number =>
  a.due === b.due ? a.key.localeCompare(b.key)
    : a.due === null ? 1
    : b.due === null ? -1
    : a.due.localeCompare(b.due);

export const findingsPage: Generator = {
  name: "findings",
  async run(ctx: GeneratorContext): Promise<GeneratedPage[]> {
    const active = [
      ...ctx.findings.list({ state: "open" }),
      ...ctx.findings.list({ state: "acknowledged" }),
    ].sort((a, b) => a.key.localeCompare(b.key));

    const asks = active.filter((f) => f.kind === "needs-human").sort(byDue);
    const todos = active.filter((f) => f.kind === "todo").sort(byDue);

    const byKind = new Map<string, Finding[]>();
    for (const f of active) {
      if (f.kind === "needs-human" || f.kind === "todo") continue;
      byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
    }

    const sections = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, list]) =>
        `## ${KIND_TITLES[kind] ?? kind} (${list.length})\n\n${list.map(line).join("\n")}`);

    // Todos sit under the asks and above the detectors: an ask carries an
    // external hard deadline and only the owner can clear it, a todo is their own
    // dated commitment, and a detector finding has no deadline at all.
    if (todos.length > 0) {
      sections.unshift(`## Todo (${todos.length})\n\n${todos.map(todoLine).join("\n")}`);
    }

    // Ahead of the detector sections, always: these are the only findings with
    // a deadline and the only ones nobody but the owner can clear.
    if (asks.length > 0) {
      sections.unshift(`## Needs human (${asks.length})\n\n${asks.map(block).join("\n\n")}`);
    }

    const declined = ctx.findings.list({ state: "wont_fix" });
    const declinedSection = declined.length === 0
      ? `## Declined\n\nnone`
      : `## Declined (${declined.length})\n\n` +
        declined.map((f) => `- \`${f.subject}\` — ${escape(f.note ?? "no reason recorded")}`).join("\n");

    const body = `# Brain findings

Needs human holds asks a Claude Code session filed for the owner and cannot clear itself;
Todo holds dated items filed with \`add_finding\`; everything below them is a
condition the nightly detectors or brain-gardener found. Generated; edit nothing
here. Close an ask or a todo with \`enscribe findings resolve <key> "reason"\`.
Page names are in backticks, not wikilinks, on purpose: this page cites missing
targets and a wikilink to one would fail the generator lint.

Declined items stay listed so a dismissal remains auditable, but they are never
reported in the nightly digest again.

${sections.length === 0 ? "## Open\n\nnone" : sections.join("\n\n")}

${declinedSection}
`;

    return [{
      slug: "brain-findings",
      title: "Brain findings",
      body,
      type: "reference",
      tags: ["findings", "maintenance", "gardener"],
    }];
  },
};
