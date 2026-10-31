import { expect, test } from "vitest";
import { pageContentHash, pageEmbedHash } from "../../src/core/hash.js";

// pageEmbedHash covers exactly what feeds the chunk embeddings (title + body),
// so frontmatter churn — an added alias, a bumped `updated:` — does not force a
// re-embed. pageContentHash still covers frontmatter, because an alias edit DOES
// change the page.
test("pageEmbedHash ignores frontmatter, pageContentHash does not", () => {
  const a = { title: "T", updated: "2026-08-01" };
  const b = { title: "T", updated: "2026-08-02", aliases: ["extra"] };
  expect(pageEmbedHash("T", "body")).toBe(pageEmbedHash("T", "body"));
  expect(pageContentHash("T", a, "body")).not.toBe(pageContentHash("T", b, "body"));
});

test("pageEmbedHash changes when the title or the body changes", () => {
  const base = pageEmbedHash("T", "body");
  expect(pageEmbedHash("Other", "body")).not.toBe(base);
  expect(pageEmbedHash("T", "other body")).not.toBe(base);
});
