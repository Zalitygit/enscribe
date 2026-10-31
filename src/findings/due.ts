// Due dates are compared as TEXT. The needs-human hook decides overdue with
// `due < strftime('%Y-%m-%dT%H:%M:%SZ','now')`, so a stored value must be a
// lexicographically-comparable UTC ISO-8601 string or the answer is silently
// wrong rather than an error.
//
// The trap this closes: a bare `2026-09-01` sorts BEFORE every instant on
// 2026-09-01, so an item due today reads OVERDUE from the moment it is
// filed. Todos carry bare dates almost always, so without this the nag is
// wrong every day of its life.
//
// End of day is 23:59:59 UTC, not 23:59:59 Eastern, and that is a decision
// rather than an oversight. Eastern end-of-day stores a todo due Sep 1 as
// 2026-09-02T03:59:59Z, which forces every reader — the page generator, the
// bash hook, anything added later — to re-implement named-zone conversion
// just to print the date back, and the hook also runs on Macs where BSD
// `date` has no `-d`. With a Z end-of-day, display is the first ten
// characters everywhere. The price is a known 4-hour skew: an item due today
// goes overdue at 20:00 Eastern rather than midnight. Early on the right day,
// not wrong about the day.
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// An instant ending in Z, the one shape that is both a real ISO-8601 instant
// and lexicographically comparable to the hook's `strftime(...,'now')`
// output. A non-Z offset (e.g. `-04:00`) is a real instant too but sorts
// wrong against those UTC strings, so it is rejected alongside garbage
// rather than silently accepted.
const ISO_INSTANT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Validates and normalizes in one place: the write path (add_finding) is the
// only caller, and this is the only place the accepted shapes are named, so
// the rule and its error message can never drift apart. Anything that is
// neither a bare date nor a Z instant is stored nowhere — a `due` the hook
// can't compare (`"next tuesday"`) or one that mis-compares silently (a
// non-Z offset) is worse than an error at file time.
export const normalizeDue = (due: string | null | undefined): string | null => {
  if (!due) return null;
  if (BARE_DATE.test(due)) return `${due}T23:59:59Z`;
  if (ISO_INSTANT_UTC.test(due)) return due;
  throw new Error(
    `add_finding: due '${due}' is not a recognised shape — pass either a bare date (YYYY-MM-DD) ` +
    `or an ISO-8601 instant ending in Z (YYYY-MM-DDTHH:MM:SSZ)`,
  );
};

// The inverse, for display. Deliberately a slice and not a Date parse: the
// stored value is already the instant we chose, and re-parsing it would
// reintroduce a local-timezone reading of it on whatever host renders.
export const dueDate = (due: string): string => due.slice(0, 10);

// `subject` is the row's identity (findingKey = `${kind}:${subject}`), and
// two readers depend on its shape: the needs-human bash hook splits
// its query output on `|` and reads it line by line, so a literal `|` or
// newline corrupts the block; the design spec also requires identity to be
// the NORMALIZED subject, so cosmetic whitespace (a trailing space) must not
// mint a second row for what is really the same item. Collapsing runs of
// spaces/tabs (not newlines — those are rejected outright, not hidden by
// being turned into a space) happens before the reject check so a subject
// that is ONLY whitespace-different from an existing one still matches it.
const SPACE_OR_TAB_RUN = /[ \t]+/g;
const NEWLINE_OR_PIPE = /[\n|]/;

export const normalizeSubject = (subject: string): string => {
  const collapsed = subject.trim().replace(SPACE_OR_TAB_RUN, " ");
  if (NEWLINE_OR_PIPE.test(collapsed)) {
    throw new Error(
      `add_finding: subject ${JSON.stringify(subject)} must not contain a newline or '|' ` +
      `(the bash reader splits on '|' and reads line by line)`,
    );
  }
  return collapsed;
};
