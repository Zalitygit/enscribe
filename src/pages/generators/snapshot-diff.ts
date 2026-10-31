import type { SnapshotRow, UnresolvedSnapshotRow } from "../store.js";

export interface LinkDelta {
  slug: string;
  from: number;
  to: number;
}

export interface Transitions {
  added: string[];
  tombstoned: string[];
  restored: string[];
  becameOrphaned: string[];
  noLongerOrphaned: string[];
  inboundChanged: LinkDelta[];
  outboundChanged: LinkDelta[];
  edited: string[];
  unresolvedNew: UnresolvedSnapshotRow[];
  unresolvedCleared: UnresolvedSnapshotRow[];
}

// NUL separates the two fields because it cannot occur in either, so key
// identity depends on nothing outside this line. A space is also collision-free
// today, but only because from_slug is always slugify() output (see
// src/pages/slug.ts), which can never contain a space — that makes an unrelated
// invariant in another module load-bearing here. raw_text is arbitrary wikilink
// text and constrains nothing either way.
const key = (u: UnresolvedSnapshotRow): string => `${u.from_slug}\0${u.raw_text}`;

// Pure diff of two snapshots into the transitions the digest reports. Every
// output list is sorted, because the digest body must be byte-stable for an
// unchanged brain (see the determinism note on the generator).
export function diffSnapshots(
  prev: SnapshotRow[],
  cur: SnapshotRow[],
  prevUnresolved: UnresolvedSnapshotRow[],
  curUnresolved: UnresolvedSnapshotRow[],
): Transitions {
  const before = new Map(prev.map((r) => [r.slug, r]));
  const t: Transitions = {
    added: [], tombstoned: [], restored: [], becameOrphaned: [], noLongerOrphaned: [],
    inboundChanged: [], outboundChanged: [], edited: [],
    unresolvedNew: [], unresolvedCleared: [],
  };

  for (const now of cur) {
    const was = before.get(now.slug);

    if (!was) {
      // Absent before. A row that arrives already tombstoned is not an "added"
      // page — it is a page created and pruned between two runs, and reporting
      // it as new would be a lie.
      if (now.deleted === 0) t.added.push(now.slug);
      continue;
    }

    if (was.deleted === 0 && now.deleted === 1) {
      // A tombstoning subsumes every other transition on that page: its links
      // are pruned by softDelete, so it would otherwise also register as
      // becameOrphaned and as an outbound loss. One event, reported once.
      t.tombstoned.push(now.slug);
      continue;
    }
    if (was.deleted === 1 && now.deleted === 0) {
      // Restored: previously tombstoned, now live again. softDelete never
      // touches content_hash, so a page deleted and restored with identical
      // content would otherwise fall through into the comparisons below and
      // produce NO transition at all — silence about a page reappearing in
      // the graph, from a generator whose whole job is reporting change.
      // Mirrors the tombstone branch: subsumes edited/link-count noise, one
      // event, reported once.
      t.restored.push(now.slug);
      continue;
    }
    if (now.deleted === 1) continue; // still tombstoned, nothing new to say

    // An inbound count dropping to zero is deliberately reported twice — once
    // here as becameOrphaned (names the event) and again below in
    // inboundChanged (gives the magnitude, e.g. 3 -> 0). Unlike the
    // tombstone/orphan dedup above, both readings are useful, so this
    // duplication is intentional; do not fold it into a single event.
    if (was.inbound > 0 && now.inbound === 0) t.becameOrphaned.push(now.slug);
    if (was.inbound === 0 && now.inbound > 0) t.noLongerOrphaned.push(now.slug);
    if (was.inbound !== now.inbound) {
      t.inboundChanged.push({ slug: now.slug, from: was.inbound, to: now.inbound });
    }
    if (was.outbound !== now.outbound) {
      t.outboundChanged.push({ slug: now.slug, from: was.outbound, to: now.outbound });
    }
    if (was.content_hash !== now.content_hash) t.edited.push(now.slug);
  }

  const wasUnresolved = new Set(prevUnresolved.map(key));
  const isUnresolved = new Set(curUnresolved.map(key));
  t.unresolvedNew = curUnresolved.filter((u) => !wasUnresolved.has(key(u)));
  t.unresolvedCleared = prevUnresolved.filter((u) => !isUnresolved.has(key(u)));

  const bySlug = (a: string, b: string): number => a.localeCompare(b);
  const byDelta = (a: LinkDelta, b: LinkDelta): number => bySlug(a.slug, b.slug);
  const byUnresolved = (a: UnresolvedSnapshotRow, b: UnresolvedSnapshotRow): number =>
    bySlug(a.from_slug, b.from_slug) || bySlug(a.raw_text, b.raw_text);

  t.added.sort(bySlug);
  t.tombstoned.sort(bySlug);
  t.restored.sort(bySlug);
  t.becameOrphaned.sort(bySlug);
  t.noLongerOrphaned.sort(bySlug);
  t.edited.sort(bySlug);
  t.inboundChanged.sort(byDelta);
  t.outboundChanged.sort(byDelta);
  t.unresolvedNew.sort(byUnresolved);
  t.unresolvedCleared.sort(byUnresolved);
  return t;
}
