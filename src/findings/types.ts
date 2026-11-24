export type FindingState = "open" | "acknowledged" | "wont_fix" | "resolved";

export interface Finding {
  key: string;
  kind: string;
  subject: string;
  detail: string;
  source: string;
  first_seen: string;
  last_seen: string;
  times_reported: number;
  state: FindingState;
  state_changed_at: string;
  note: string | null;
  due: string | null;
  // Slug of the page holding the assignment, when it is too large or too
  // evolving for `detail`. See migrations/013_finding_doc.sql.
  doc: string | null;
}

// What a detector emits. The key is derived, never supplied, so two detectors
// cannot disagree about the identity of the same condition.
export interface DetectedFinding {
  kind: string;
  subject: string;
  detail: string;
}

// What a caller files directly rather than detecting on a sweep. Same identity
// rule; `due` and `doc` are the fields a detector has no way to supply.
export interface AppendedFinding extends DetectedFinding {
  due?: string | null;
  doc?: string | null;
}

export const findingKey = (kind: string, subject: string): string => `${kind}:${subject}`;

// Kinds MacBrain itself is authoritative for on a reconcile call — every kind
// NOT listed here is left untouched, so this list is a scope boundary, not
// just a feature list. Two different reasons keep it short:
//
// `red-link` and `contradiction` are absent because only the external
// gardener can compute them (a vault-file scan and an LLM probe,
// respectively) — listing them would make the nightly resolve every finding
// the gardener had just reported, since reconcile treats "in scope but not
// re-detected" as resolved.
//
// `rot-future-date` and `rot-stale-todo` are absent because they were
// measured against the real vault (137 files) on
// 2026-08-11 and found unfit to ship: rot-future-date returned 4 findings and
// 0 true positives (all were book-library rows where "Will"/"Next" are parts
// of titles — "Will Robie Series", "You're Next" — sitting beside purchase
// dates, not date-bearing predictions), and rot-stale-todo had zero unchecked
// checkboxes to detect across the whole vault. Enabling either would seed the
// ledger with permanent noise on day one, which is exactly what this ledger
// exists to prevent. Both detectors remain implemented and unit-tested —
// dead but ready — pending a tighter signal.
//
// `unknown-link-type` is listed, unlike the rot detectors, because it cannot
// be noisy on day one: the vault held zero `name::` inline fields when typed
// edges shipped (checked 2026-10-22), so every finding it ever raises is a
// field someone wrote since, and fixing the field resolves it.
//
// `secret` is listed because it was measured before registering: against the
// real vault (195 files) on 2026-10-31 it raised 3 findings, one a real SIP
// password in a raw session note and two truncated fragments of a live token.
// Removing the line resolves it.
//
// `stale` is listed for the same reason as `unknown-link-type`: it fires only
// on a page that declares the OKF `stale_after` or `verified` field, and none
// of the vault's 190 pages did when it shipped (measured 2026-10-31), so it
// cannot be noisy on day one. Re-checking the page and moving the date forward
// resolves it.
//
// Lives here (not in index.ts, where it originates) so callers like
// src/mcp/server.ts that need only the constant don't pull in the detector
// functions and their pages/parse dependency chain.
export const DAEMON_KINDS = ["orphan", "unresolved", "unknown-link-type", "secret", "stale"];

// The whitelist counterpart to DAEMON_KINDS: kinds an external
// findings.report caller (the gardener) is allowed to declare at all.
// DAEMON_KINDS alone is a blacklist — anything NOT in it was silently
// accepted, so a caller could report under an invented kind, or a near-miss
// like "Orphan" or "orphan " (trailing space), and it would render under an
// unrecognised heading, unattributable. Kept explicit and short rather than
// "every kind minus DAEMON_KINDS" so adding a new daemon-owned kind can't
// accidentally open it up to external callers by omission.
export const REPORTABLE_KINDS = ["red-link", "contradiction"];

// Kinds that may be filed one at a time through `add_finding`, which appends
// and never reconciles. Deliberately disjoint from DAEMON_KINDS and
// REPORTABLE_KINDS: a caller that could append an `orphan` would create a row
// the nightly reconcile then resolves (it was not re-detected), and the pair
// would flap open/resolved forever. Only kinds nothing sweeps for belong here.
//
// `todo` is the second such kind. It is a dated item the owner asked for rather
// than one a session hit, and it is here rather than in a markdown page
// because the measurement said so: the checkbox habit has never existed in
// this vault (zero unchecked boxes across 137 files) and Apple Reminders has
// been unused since May, while this ledger is the one surface in the fleet
// with a nag that gets read — the SessionStart hook. Note the name does NOT
// collide with the `rot-stale-todo` detector, which is a dead vault-markdown
// sweep and must stay dead: reviving it would fire on every open item every
// night, which is a duplicate nag, not a second opinion.
//
// `alert` is the third (2026-11-04). It is something happening NOW that the owner
// should see soon: a service down, an account overdrawn, a deadline today.
// That is neither a needs-human (an ask only the owner can carry out) nor a todo (his
// own dated commitment); an alert is a condition, and it closes when the
// condition does. It is raised and cleared both by sessions (`add_finding`)
// and by plain scripts and cron jobs (`enscribe findings add`, then
// `findings resolve`), and a desk panel (wiki page p4-desk-panel, its own
// repo) shows the open ones as a red banner. Whoever raised it is
// responsible for clearing it. Nothing sweeps for it, so it cannot flap.
export const APPENDABLE_KINDS = ["needs-human", "todo", "alert"];
