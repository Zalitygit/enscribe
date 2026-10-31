import type { Database } from "../core/db.js";
import { findingKey, type AppendedFinding, type DetectedFinding, type Finding, type FindingState } from "./types.js";

export interface ReconcileResult {
  added: number;
  reopened: number;
  resolved: number;
  unchanged: number;
}

export class FindingsStore {
  constructor(private db: Database) {}

  get(key: string): Finding | undefined {
    return this.db.prepare(`SELECT * FROM findings WHERE key = ?`).get(key) as Finding | undefined;
  }

  list(filter: { state?: FindingState; kind?: string }): Finding[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.state) { where.push("state = ?"); args.push(filter.state); }
    if (filter.kind) { where.push("kind = ?"); args.push(filter.kind); }
    const sql = `SELECT * FROM findings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY key`;
    return this.db.prepare(sql).all(...args) as Finding[];
  }

  // Insert or refresh. Deliberately does NOT touch `state`: re-detection is
  // evidence the condition still holds, never a judgement about it. A wont_fix
  // finding that is re-detected stays wont_fix and stays silent.
  //
  // `detail` IS refreshed, so a finding whose description changes (e.g. an
  // unresolved link gaining another referrer) reports current text.
  upsertDetected(d: DetectedFinding, source: string, now: string): void {
    this.db.prepare(
      `INSERT INTO findings (key, kind, subject, detail, source, first_seen, last_seen,
                             times_reported, state, state_changed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, NULL)
       ON CONFLICT(key) DO UPDATE SET
         detail = excluded.detail,
         last_seen = excluded.last_seen,
         times_reported = findings.times_reported + 1`,
    ).run(findingKey(d.kind, d.subject), d.kind, d.subject, d.detail, source, now, now, now);
  }

  // File one finding directly. The append-only counterpart to reconcile():
  // the caller knows about the item it just found and nothing else, so
  // nothing here may resolve anything. Routing a session's single ask through
  // reconcile(["needs-human"], [item]) would close every other open ask as "no
  // longer detected".
  //
  // Differs from upsertDetected in one way, on purpose: a `resolved` finding
  // filed again is REOPENED. Re-detection is evidence a condition still
  // holds and says nothing about the judgement on it; a caller filing an item
  // a second time is asserting it needs doing again. `wont_fix` is untouched
  // either way — that decision is the human's and outlives any caller.
  //
  // Returns what the write did, so a caller that re-files a subject it did
  // not know was open is told by the write itself rather than having to read
  // the ledger back.
  add(f: AppendedFinding, source: string, now: string): { created: boolean; reopened: boolean; times_reported: number } {
    // IMMEDIATE: reads (get) before it writes. Under WAL a deferred one fails
    // at once with SQLITE_BUSY when another connection holds the write lock
    // (see PageService.writePage); immediate waits on busy_timeout.
    return this.db.transaction(() => {
      const before = this.get(findingKey(f.kind, f.subject));
      this.db.prepare(
        // `doc` follows `detail` and `due`: refreshed on a re-file, including
        // back to NULL. A caller filing the same subject is asserting current
        // truth, so a page that moved must take -- and one whose work came
        // back into `detail` must stop pointing at a page that no longer owns
        // it. `state` is still never touched here.
        `INSERT INTO findings (key, kind, subject, detail, source, first_seen, last_seen,
                               times_reported, state, state_changed_at, note, due, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, NULL, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           detail = excluded.detail,
           due = excluded.due,
           doc = excluded.doc,
           last_seen = excluded.last_seen,
           times_reported = findings.times_reported + 1`,
      ).run(findingKey(f.kind, f.subject), f.kind, f.subject, f.detail, source, now, now, now, f.due ?? null, f.doc ?? null);
      const reopened = before?.state === "resolved";
      if (reopened) this.setState(before.key, "open", before.note, now);
      return { created: before === undefined, reopened, times_reported: (before?.times_reported ?? 0) + 1 };
    }).immediate();
  }

  // Patch the caller-supplied fields of an existing finding, leaving every
  // other column alone.
  //
  // This exists because `add` is "file this item", not "patch this field": it
  // REPLACES detail, due and doc, so re-filing a subject merely to attach a
  // `doc` silently destroys whatever handoff `detail` held. Found the day
  // `doc` shipped, setting the first real one, which required passing 2,576
  // characters of unchanged detail back through the tool to avoid losing it.
  //
  // Three deliberate differences from `add`:
  //   - `times_reported` does NOT move. A patch is not the caller re-asserting
  //     the ask, and "asked 3 times" is a fact the ledger exists to keep honest.
  //   - `last_seen` does NOT move. It records the last time something SAW the
  //     condition; editing a row's text is not a sighting.
  //   - `state`/`note` are untouched, so a wont_fix stays declined. Judgment
  //     belongs to setState alone.
  //
  // `undefined` means "leave it"; an explicit `null` CLEARS the column. Without
  // that distinction there would be no way to unset a doc once set.
  setFields(key: string, fields: { detail?: string; due?: string | null; doc?: string | null }, _now: string): void {
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (fields.detail !== undefined) { sets.push("detail = ?"); args.push(fields.detail); }
    if (fields.due !== undefined) { sets.push("due = ?"); args.push(fields.due); }
    if (fields.doc !== undefined) { sets.push("doc = ?"); args.push(fields.doc); }
    // Nothing to change is a no-op, but the key must still exist -- reporting
    // success for a key that is not there would be the same lie setState
    // refuses to tell.
    if (sets.length === 0) {
      if (this.get(key) === undefined) throw new Error(`setFields: no such finding '${key}'`);
      return;
    }
    const { changes } = this.db.prepare(
      `UPDATE findings SET ${sets.join(", ")} WHERE key = ?`,
    ).run(...args, key);
    if (changes === 0) throw new Error(`setFields: no such finding '${key}'`);
  }

  // Throws on a miss rather than silently no-op'ing: the caller is a human
  // hand-typing a key (via set_finding_state), and a typo or wrong
  // kind-prefix must not report success while doing nothing.
  setState(key: string, state: FindingState, note: string | null, now: string): void {
    const { changes } = this.db.prepare(
      `UPDATE findings SET state = ?, note = ?, state_changed_at = ? WHERE key = ?`,
    ).run(state, note, now, key);
    if (changes === 0) throw new Error(`setState: no such finding '${key}'`);
  }

  // Backfill only. Nothing in the normal detection path rewrites first_seen —
  // it is the anchor the age display is computed from.
  setFirstSeen(key: string, firstSeen: string, timesReported: number): void {
    this.db.prepare(
      `UPDATE findings SET first_seen = ?, times_reported = ? WHERE key = ?`,
    ).run(firstSeen, timesReported, key);
  }

  // Reconcile the ledger against a detection run.
  //
  // `kinds` is the scope: the caller declares which kinds it is authoritative
  // for on THIS call, and findings of every other kind are left alone. This is
  // what lets MacBrain's SQL detectors and the gardener's vault scan / LLM probe
  // share one ledger. Without it, whichever source ran last would resolve
  // everything the other had just detected, and every finding would flap
  // open/resolved nightly.
  //
  // Runs in one transaction: a partial reconcile would resolve some findings
  // without recording the detections that justify keeping the rest.
  // IMMEDIATE, because it reads (get, list) before and between its writes.
  reconcile(kinds: string[], detected: DetectedFinding[], source: string, now: string): ReconcileResult {
    const inScope = detected.filter((d) => kinds.includes(d.kind));
    const result: ReconcileResult = { added: 0, reopened: 0, resolved: 0, unchanged: 0 };

    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const d of inScope) {
        const key = findingKey(d.kind, d.subject);
        seen.add(key);
        const before = this.get(key);
        this.upsertDetected(d, source, now);
        if (!before) result.added++;
        else if (before.state === "resolved") {
          this.setState(key, "open", null, now);
          result.reopened++;
        } else result.unchanged++;
      }

      for (const kind of kinds) {
        for (const f of this.list({ kind })) {
          if (seen.has(f.key) || f.state === "resolved") continue;
          this.setState(f.key, "resolved", f.note, now);
          result.resolved++;
        }
      }
    }).immediate();

    return result;
  }
}
