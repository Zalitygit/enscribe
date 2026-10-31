// Below this many words, content is checked against the signatures below.
// The threshold is not an optimization: it is what keeps a long legitimate page
// ABOUT Cloudflare or HTTP errors writable. The guard fires on signatures in
// short content, never on brevity itself, so stub pages stay legal.
export const GUARD_WORD_LIMIT = 50;

// Fetched-a-failure signatures. Borrowed from a sibling project's vault.py,
// which calls this "a secondary defense if garbage bypasses the fetcher".
// Deliberately narrow: this is a systems engineer's personal vault, and short
// notes like "log in to the router with the default creds" or "502 Bad
// Gateway, restart nginx" are exactly the kind of legitimate content it holds.
// A "please log in" or generic 4xx/5xx signature refused those, so only the
// high-precision fetch-failure markers below survive — phrasing that
// essentially never appears in an authored note.
const ERROR_SIGNATURES: RegExp[] = [
  /cloudflare ray id/i,
  /checking your browser/i,
  /enable javascript/i,
];

// Never-meant-to-be-saved signatures.
const PLACEHOLDER_SIGNATURES: RegExp[] = [
  /lorem ipsum/i,
  /^\s*test\.?\s*$/i,
  /^(?:\s*chunk \d+\.\s*)+$/i,
];

// Returns an error string when the body looks like a fetch failure or a
// placeholder, or null when it is acceptable. Pure; callers decide what to do.
export function checkContent(body: string): string | null {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words >= GUARD_WORD_LIMIT) return null;

  for (const re of ERROR_SIGNATURES) {
    if (re.test(body)) return `content looks like a fetched error page (matched ${re})`;
  }
  for (const re of PLACEHOLDER_SIGNATURES) {
    if (re.test(body)) return `content looks like placeholder text (matched ${re})`;
  }
  return null;
}
