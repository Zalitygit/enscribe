import type { PageService } from "../service.js";
import type { PagesStore } from "../store.js";
import type { Generator, GeneratorContext, RunResult } from "./types.js";

// Run each generator, upsert its produced pages (generator-owned), soft-delete
// generator-owned pages it no longer produces, then re-resolve all links and lint
// (any generated page left with an unresolved link is a loud failure).
export async function runGenerators(
  service: PageService,
  store: PagesStore,
  ctx: GeneratorContext,
  generators: Generator[],
): Promise<RunResult> {
  let generated = 0;
  let pruned = 0;
  const skipped: RunResult["skipped"] = [];
  for (const gen of generators) {
    const pages = await gen.run(ctx);
    const produced = new Set<string>();
    for (const p of pages) {
      const r = await service.putGenerated(p, gen.name);
      produced.add(p.slug);
      // A slug an authored vault file already owns is reported, not written —
      // authored-wins, see PageService.putGenerated.
      if (r.skipped) skipped.push({ slug: p.slug, generator: gen.name, sourcePath: r.skipped });
      else generated++;
    }
    for (const slug of store.listGeneratedBy(gen.name)) {
      if (!produced.has(slug)) {
        store.softDelete(slug);
        pruned++;
      }
    }
  }
  // Rebuild the whole alias table before resolving: a pruned generated page's
  // alias rows survive its tombstone (softDelete keeps them), so without this a
  // dead slug keeps shadowing a live page that claims the same alias — and the
  // full rebuild only otherwise runs in `vault sync`, which the nightly job
  // never calls.
  service.rebuildAllAliases();
  await service.resolveAll();
  return { generated, pruned, skipped, lintErrors: store.generatedUnresolvedLinks() };
}
