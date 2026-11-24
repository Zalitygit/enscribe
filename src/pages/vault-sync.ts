import type { PageService } from "./service.js";
import { LAST_VAULT_SYNC, type PagesStore } from "./store.js";
import type { VaultConfig } from "./vault-config.js";
import { walkVault, fsLister, type FileLister } from "./vault.js";
import { gitCommitTimes } from "./vault-git.js";
import { slugFor } from "./slug.js";
import { parseFrontmatter } from "./parse.js";

export interface SyncSummary {
  ingested: number;
  unchanged: number;
  pruned: number;
  unresolvedLinks: number;
  authoredStamped: number;
  collisions: { slug: string; paths: string[] }[];
  // Files whose frontmatter would not parse. Quarantined like a collision, and
  // reported for the same reason: the sync is knowingly incomplete and the
  // operator has to know which file to fix.
  unparseable: { path: string; error: string }[];
  ambiguousAliases: { alias: string; slugs: string[] }[];
  // Include dirs that failed to enumerate.
  failedDirs: string[];
  // Why the prune was skipped, or null if it ran. Never skip silently: a
  // skipped prune leaves tombstones un-made, which is safe but is still a
  // knowingly incomplete sync the operator has to know about.
  pruneSkipped: "failed-dirs" | null;
}

// Full idempotent sync of the vault into the pages index: ingest every included
// file, soft-delete pages whose file vanished, then re-resolve all links (so
// forward refs resolve and inbound links to pruned pages fall to unresolved).
export async function syncVault(
  config: VaultConfig,
  service: PageService,
  store: PagesStore,
  readFile: (absPath: string) => string,
  lister: FileLister = fsLister,
  commitTimes: (root: string) => Map<string, string> = gitCommitTimes,
): Promise<SyncSummary> {
  const { files, failedDirs } = walkVault(config, lister);

  // Authoritative slug per file — frontmatter `slug:` override, else basename,
  // exactly as PageService.ingest derives it. Two files claiming one slug would
  // silently overwrite each other in the index (slug is the PK), so the
  // colliding files are QUARANTINED: they are not ingested, but they stay in
  // `present` so the contested page is not pruned either, and the rest of the
  // vault syncs normally. (Aborting wholesale meant one duplicate basename
  // froze ingest, prune, alias rebuild and link resolution vault-wide.)
  // A malformed YAML block is quarantined the same way, and for the same
  // reason. `parseFrontmatter` throws on bad YAML, and this pre-scan touches
  // EVERY file, so one bad block used to throw out of syncVault entirely and
  // take ingest, prune, alias rebuild and link resolution down with it — over a
  // file the operator could fix in ten seconds, if anything had named it. Note
  // the file still counts as `present` below, so its existing page is not
  // pruned for a fault that is not a deletion.
  const contents = files.map((f) => ({ f, raw: readFile(f.absPath) }));
  const unparseable: { path: string; error: string }[] = [];
  const bySlug = new Map<string, string[]>();
  for (const { f, raw } of contents) {
    let slug: string;
    try {
      slug = slugFor(f.relPath, parseFrontmatter(raw).frontmatter);
    } catch (e) {
      unparseable.push({ path: f.relPath, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const arr = bySlug.get(slug);
    if (arr) arr.push(f.relPath);
    else bySlug.set(slug, [f.relPath]);
  }
  const collisions = [...bySlug.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([slug, paths]) => ({ slug, paths }));
  const quarantined = new Set([
    ...collisions.flatMap((c) => c.paths),
    ...unparseable.map((u) => u.path),
  ]);

  let ingested = 0;
  let unchanged = 0;
  for (const { f, raw } of contents) {
    if (quarantined.has(f.relPath)) continue;
    const { changed } = await service.ingest(f.relPath, raw);
    if (changed) ingested++;
    else unchanged++;
  }

  // Prune only when the walk is a COMPLETE view of the vault. An include dir
  // that failed to enumerate means the file list describes a broken disk rather
  // than a user's deletions — pruning on it would tombstone the whole index and
  // still exit 0, which is the bug this guard was written for (2026-07-31).
  //
  // It deliberately does NOT also refuse an empty-but-clean walk. Every genuine
  // breakage the guard exists for — unmounted root, typo'd `root`, bad
  // permissions — makes readdirSync THROW, so walkVault records it in
  // `failedDirs` and the check below already catches it. A walk that enumerated
  // every include dir without error and found nothing is reporting the truth:
  // the user deleted their last page. Refusing that case treated a small vault's
  // real state as a fault, left the deleted pages live and searchable, and — on
  // the scheduled sync the per-owner instances run — failed the unit on every
  // run with no path back to success short of re-creating a file.
  //
  // The asymmetry that justified the stricter reading does not hold either:
  // pruning is a SOFT delete against a git-canonical vault, so an index emptied
  // in error is restored by the next successful sync (test: "a prune from an
  // empty walk is reversible on the next sync"). A mass prune is still loud —
  // the CLI prints the pruned count — it is just no longer fatal.
  //
  // A page is also stale when its file is still present but now derives a
  // different slug (a frontmatter `slug:` added or dropped): ingest wrote the
  // new slug, and the old row would otherwise stay live as an orphan duplicate.
  // Quarantined paths are left alone, as above: their last good page stands.
  const present = new Set(files.map((f) => f.relPath));
  const slugOfPath = new Map<string, string>();
  for (const [slug, paths] of bySlug) if (paths.length === 1) slugOfPath.set(paths[0]!, slug);
  const sourceBacked = store.listPages().filter((p) => p.source_path);
  const pruneSkipped = failedDirs.length > 0 ? "failed-dirs" as const : null;
  let pruned = 0;
  if (pruneSkipped === null) {
    for (const page of sourceBacked) {
      const path = page.source_path!;
      const renamed = !quarantined.has(path) && slugOfPath.has(path) && slugOfPath.get(path) !== page.slug;
      if (!present.has(path) || renamed) {
        // A vanished file also cancels any ingest of it in flight elsewhere
        // (serve's put_page, a watcher), so a late embedding cannot revive it.
        if (!present.has(path)) store.cancelIngests(path);
        store.softDelete(page.slug);
        pruned++;
      }
    }
  }

  // Deterministic alias table across the whole vault (heals stolen/dropped
  // aliases regardless of per-file change short-circuits), then re-resolve
  // links against it.
  const ambiguousAliases = service.rebuildAllAliases();
  await service.resolveAll();

  // Stamp change-event recency from source git history (one git-log map for the
  // whole vault). Off the per-file ingest path; git failure yields an empty map
  // and leaves authored_at null (recency falls back to ingest time).
  const authoredStamped = store.stampAuthoredDates(commitTimes(config.root));
  // Freshness signal for `doctor`. Stamped only on a run that got here, so a
  // sync that threw leaves the previous (older) time standing rather than
  // claiming a success it did not have.
  store.setMeta(LAST_VAULT_SYNC, new Date().toISOString());

  return { ingested, unchanged, pruned, unresolvedLinks: store.unresolvedCount(), authoredStamped, collisions, unparseable, ambiguousAliases, failedDirs, pruneSkipped };
}
