export const SCOPES = {
  search_memory: "memory.search",
  get_record: "memory.read",
  add_memory: "memory.append",
  update_memory: "memory.modify",
  link_records: "memory.modify",
  list_recent: "memory.read",
  forget_record: "memory.delete",
  summarize_context: "memory.read",
  search: "pages.read",
  get_page: "pages.read",
  list_pages: "pages.read",
  get_links: "pages.read",
  get_backlinks: "pages.read",
  resolve_slug: "pages.read",
  doctor: "pages.read",
  orphans: "pages.read",
  recent_pages: "pages.read",
  put_page: "pages.write",
  edit_page: "pages.write",
  findings: "findings.read",
  report_findings: "findings.report",
  add_finding: "findings.report",
  set_finding_state: "findings.write",
  set_finding_field: "findings.write",
  current_context: "context.read",
} as const;

export type ToolName = keyof typeof SCOPES;

// The full set of permission scopes a client token may hold. A token granting
// "*" is expanded to this set.
export const ALL_SCOPES = [
  "memory.read",
  "memory.search",
  "memory.append",
  "memory.modify",
  "memory.delete",
  "memory.private",
  "pages.read",
  "pages.write",
  "findings.read",
  "findings.report",
  "findings.write",
  "context.read",
] as const;
