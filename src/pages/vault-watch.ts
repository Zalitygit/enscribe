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
}

// Baseline full-sync, then a debounced watch of the include dirs. add/change ->
// ingest; unlink -> soft-delete by source_path; each debounced batch ends with
// resolveAll(). Resolves once the watcher's initial scan is ready.
export async function watchVault(
  config: VaultConfig,
  service: PageService,
  store: PagesStore,
  opts: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = opts.debounceMs ?? 300;
  const onError = opts.onError ?? ((p: string, e: Error) => console.error(`[vault-watch] ${p}: ${e.message}`));
  await syncVault(config, service, store, (abs) => readFileSync(abs, "utf8"));

  const denies = config.deny.map((d) => d.toLowerCase());
  const roots = config.include.map((rel) => join(config.root, rel));
  const isDenied = (p: string) => relative(config.root, p).split(/[/\\]/).some((s) => denies.includes(s.toLowerCase()));

  const watcher = chokidar.watch(roots, { ignoreInitial: true, ignored: (p: string) => isDenied(p) });

  const pending = new Map<string, "upsert" | "remove">();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    timer = null;
    const batch = [...pending];
    pending.clear();
    for (const [abs, kind] of batch) {
      const rel = relative(config.root, abs);
      try {
        if (kind === "remove") {
          const page = store.getBySourcePath(rel);
          if (page) store.softDelete(page.slug);
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

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, debounceMs);
  };
  const onUpsert = (abs: string) => { if (abs.endsWith(".md")) { pending.set(abs, "upsert"); schedule(); } };
  const onRemove = (abs: string) => { if (abs.endsWith(".md")) { pending.set(abs, "remove"); schedule(); } };

  watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onRemove);
  await new Promise<void>((res) => watcher.once("ready", () => res()));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
