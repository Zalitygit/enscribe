import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import chokidar from "chokidar";
import type { PageService } from "./service.js";
import type { PagesStore } from "./store.js";
import type { VaultConfig } from "./vault-config.js";
import { syncVault } from "./vault-sync.js";
import { slugFor } from "./slug.js";
import { parseFrontmatter } from "./parse.js";

export interface WatchHandle {
  close(): Promise<void>;
}

export interface WatchOptions {
  debounceMs?: number;
  onError?: (path: string, err: Error) => void;
  read?: (absPath: string) => string;
}

// A debounced watch of the include dirs plus a baseline full sync. add/change ->
// ingest; unlink -> retire by source_path; each debounced batch ends with
// resolveAll(), and batches run one at a time. Resolves once the baseline sync
// is done.
//
// The watcher starts BEFORE the sync and holds its events until the sync is
// done, then processes them. Sync-then-watch missed any edit landing after the
// sync listed the vault and before the watcher was up: with ignoreInitial the
// watcher's scan took the file as already present, so it stayed stale until
// the next full sync. A held event for a file the sync already ingested is a
// no-op re-ingest. Residual: on macOS `ready` precedes the OS watch going live
// by tens of ms (measured 2026-10-31), so an edit the sync has already read,
// made inside that window, can still be missed. Closing that needs a probe
// write in every watched directory, which a live vault should not get.
export async function watchVault(
  config: VaultConfig,
  service: PageService,
  store: PagesStore,
  opts: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = opts.debounceMs ?? 300;
  const onError = opts.onError ?? ((p: string, e: Error) => console.error(`[vault-watch] ${p}: ${e.message}`));

  const denies = config.deny.map((d) => d.toLowerCase());
  const roots = config.include.map((rel) => join(config.root, rel));
  const isDenied = (p: string) => relative(config.root, p).split(/[/\\]/).some((s) => denies.includes(s.toLowerCase()));

  const watcher = chokidar.watch(roots, { ignoreInitial: true, ignored: (p: string) => isDenied(p) });

  const pending = new Map<string, "upsert" | "remove">();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // One batch at a time. Events that arrive while a batch is awaiting an
  // embedding wait in `pending` for the next one: a second batch running
  // alongside could let the first one's stale remove undo the second's add.
  let active: Promise<void> | null = null;
  const drain = async (): Promise<void> => {
    while (pending.size) await flush();
  };
  const kick = () => {
    timer = null;
    if (!active) active = drain().finally(() => { active = null; });
  };

  const flush = async (): Promise<void> => {
    const batch = [...pending];
    pending.clear();
    for (const [abs, kind] of batch) {
      const rel = relative(config.root, abs);
      try {
        if (kind === "remove") {
          service.retire(rel);
        } else {
          const raw = readFileSync(abs, "utf8");
          // Single-file mirror of the full sync's collision quarantine. Slug is
          // the page PK and basename-derived, so a second file claiming a live
          // page's slug would overwrite its body and repoint source_path — and
          // the next full sync would then quarantine BOTH. Refuse instead, via
          // the same per-file error path as any other bad file.
          const owner = store.getPage(slugFor(rel, parseFrontmatter(raw).frontmatter));
          if (owner && owner.deleted_at === null && owner.source_path && owner.source_path !== rel) {
            throw new Error(`slug '${owner.slug}' already belongs to ${owner.source_path}`);
          }
          await service.ingest(rel, raw);
        }
      } catch (err) {
        // A transient failure (file removed mid-window, malformed YAML from an
        // editor autosave) must not kill the watcher; skip and continue.
        onError(rel, err as Error);
      }
    }
    try {
      await service.resolveAll();
    } catch (err) {
      onError("<resolveAll>", err as Error);
    }
  };

  // Held until the baseline sync finishes, so a flush never runs beside it.
  let holding = true;
  const schedule = () => {
    if (holding) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(kick, debounceMs);
  };
  const onUpsert = (abs: string) => { if (abs.endsWith(".md")) { pending.set(abs, "upsert"); schedule(); } };
  const onRemove = (abs: string) => { if (abs.endsWith(".md")) { pending.set(abs, "remove"); schedule(); } };

  watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onRemove);
  await new Promise<void>((res) => watcher.once("ready", () => res()));

  try {
    await syncVault(config, service, store, opts.read ?? ((abs) => readFileSync(abs, "utf8")));
  } catch (err) {
    await watcher.close();
    throw err;
  }
  holding = false;
  if (pending.size) schedule();

  return {
    // Stops new events, then drains: the batch in progress and any events
    // still pending are applied before close resolves.
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      if (pending.size) kick();
      await active;
    },
  };
}
