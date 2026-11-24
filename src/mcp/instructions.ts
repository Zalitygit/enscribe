// The MCP `instructions` string sent on initialize. A client that never loads
// the project's own agent docs (a chat app, a phone assistant, another vendor's
// model) learns how to use the brain only from this and the tool descriptions.
// It names only tools this client can call, so a read-only token is never told
// to write. Kept short: it rides in every session's context.

// A live page answering to this alias is named as the long-form guide.
export const USAGE_GUIDE_ALIAS = "usage-guide";

export function serverInstructions(opts: {
  can: (tool: string) => boolean;
  hasPages: boolean;
  hasFindings: boolean;
  guideSlug: string | null;
  hasHistory?: boolean;
}): string {
  const { can, hasPages, hasFindings, guideSlug, hasHistory } = opts;
  const lines = [
    "A personal knowledge brain: one owner's infrastructure, projects, decisions and history.",
    "- Search here first when a question turns on a proper noun (a host, project, person, tool or domain). Names are often personal: assume the owner's meaning before the public one.",
  ];
  if (hasPages && can("search")) {
    lines.push(
      "- `search` is the entry point; `get_page` once you know the slug (a title or alias also resolves). Treat `confident: false` as nothing found unless a hit plainly answers. `confident: true` means the query matched, not that the page states the answer.",
      "- Pass a page hit's `section` (or `vector_heading`) to `get_page` to read just that section; pages run to 50 KB. Read the whole page only when the section does not answer it.",
    );
    if (can("get_pages")) lines.push("- To read several hits, send them in one `get_pages` call (each with its `section`).");
  } else if (can("search_memory")) {
    lines.push("- `search_memory` is the entry point; `get_record` fetches one record in full.");
  }
  if (hasPages && hasHistory && can("page_history")) {
    lines.push("- For when something was written down or changed, `page_history` lists a page's commits; search cannot see git history.");
  }
  lines.push(
    "- Say which page an answer came from (its slug). If the brain returned nothing, say so, and label general knowledge as such.",
    "- Pages can be stale. When you can check the live system, the check wins over the page.",
  );
  if (hasPages && can("edit_page")) {
    lines.push(
      "- To correct or extend a page use `edit_page` (one exact replacement); `put_page` replaces the whole file. Write only facts you verified, with the date. Generated pages cannot be edited.",
    );
  }
  if (hasFindings && can("findings")) {
    lines.push("- `findings` lists open items as summaries; pass `key` for one in full.");
  }
  if (hasFindings && can("add_finding")) {
    lines.push(
      "- Before `add_finding`, call `findings` and reuse an existing subject. Re-filing replaces detail, due and doc.",
    );
  }
  if (guideSlug && hasPages && can("get_page")) {
    lines.push(`- get_page ${guideSlug} for the long form: why each rule exists, and the traps.`);
  }
  return lines.join("\n");
}
