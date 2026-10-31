import { createHash } from "node:crypto";
import type { RecordInput } from "./types.js";

// Hash the canonical content fields only (not timestamps/ids), so an identical
// memory has a stable hash across devices — the basis for future dedup/sync.
export function contentHash(input: RecordInput): string {
  const canonical = JSON.stringify({
    type: input.type,
    subject: input.subject,
    content: input.content,
    entities: input.entities ?? [],
    tags: input.tags ?? [],
    relationships: input.relationships ?? [],
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

// Hash a page's canonical content (title + frontmatter + body), not derived
// fields or timestamps — an identical page yields a stable hash, the basis for
// idempotent re-ingest and future sync.
export function pageContentHash(
  title: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const canonical = JSON.stringify({ title, frontmatter, body });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

// Hash ONLY what feeds the chunk embeddings (title + body — see
// PageService.embedChunks, which prefixes every chunk with the title). Split out
// from pageContentHash so frontmatter churn (an added alias, a bumped
// `updated:`) updates the page without re-chunking and re-embedding it: the
// chunk inputs are byte-identical, so the vectors would be too.
//
// Aliases are deliberately NOT covered here even though 009 indexes them,
// because they reach only the FTS column and never the embedding input. That was
// measured, not assumed: feeding aliases to the embedder cost nDCG@5 0.746 ->
// 0.699 on the relational benchmark by diluting every chunk vector with the
// page's other names. An alias edit therefore updates the keyword index in place
// (PagesStore.updateChunkAliases) and leaves the vectors alone.
export function pageEmbedHash(title: string, body: string): string {
  const canonical = JSON.stringify({ title, body });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}
