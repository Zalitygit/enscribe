import { basename, extname } from "node:path";

// Canonical key form: lowercase, decompose accents, collapse every run of
// non-alphanumeric characters to a single space, trim. This is the alias-table
// key, so "Full Title", "full-title", and "  full   title! " all map together.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Slug identity: the normalized key with spaces turned into hyphens.
export function slugify(text: string): string {
  return normalize(text).replace(/ /g, "-");
}

// The authoritative slug for a source file: a frontmatter `slug:` override
// wins, else the basename. Every path that decides a page's identity (ingest,
// vault sync's collision pre-scan, put_page's guards, the watcher) derives it
// HERE — a guard computing the slug differently than the write protects a
// different page than the one about to be overwritten.
export function slugFor(sourcePath: string, frontmatter: Record<string, unknown>): string {
  return typeof frontmatter.slug === "string" && frontmatter.slug
    ? slugify(frontmatter.slug)
    : slugify(basename(sourcePath, extname(sourcePath)));
}
