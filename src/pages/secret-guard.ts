// Credential-shaped text in a vault page. The vault is canonical git and every
// page is served to every connector, so a token written into a page is a leak
// the moment it is committed, and rotating it is the only real fix. This
// refuses such writes and lets the nightly detector flag what is already there.
//
// Detect and refuse, never rewrite: silently redacting a canonical file would
// change the source of truth behind the writer's back. Hits carry the rule and
// line, never the matched text, so a refusal or a finding cannot itself leak.
//
// Prefix rules are adapted from Pratiyush/llm-wiki (MIT, llmwiki/convert.py
// _DEFAULT_TOKEN_PATTERNS) plus the shapes this fleet's secrets store holds.
// Most of the store is opaque hex or base64 (every MCP bearer is), which no
// prefix rule can see, so the last three rules key on context instead: a
// Bearer header, a token URL parameter, and a NAME_TOKEN=value assignment.
// Their keyword set deliberately requires `:` or `=` after the name, because a
// whitespace separator matches prose ("token expiration") and a false positive
// here refuses a legitimate write.

export interface SecretHit {
  rule: string;
  line: number;
}

const PREFIX_RULES: [string, RegExp][] = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  // Before sk-key, which would also match it.
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  // OpenAI, OpenRouter (sk-or-v1-), MiniMax and the rest of the sk- family.
  ["sk-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  // Live keys only: pk_ is publishable and sk_test_ is harmless.
  ["stripe-key", /\b[sr]k_live_[0-9a-zA-Z]{24,}/],
  // ElevenLabs and similar.
  ["sk-underscore-key", /\bsk_[A-Za-z0-9]{32,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["digitalocean-token", /\bdo[por]_v1_[a-f0-9]{64}\b/],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["telnyx-key", /\bKEY[0-9A-F]{32}_[A-Za-z0-9]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // The BEGIN line alone: a key cut short is still a leaked key.
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
];

const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i;
const URL_TOKEN = /[?&](?:token|access_token|api_?key|key|auth)=[A-Za-z0-9._~%-]{16,}/i;
const ASSIGNMENT = /\b[A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pass|api_?key|_key|bearer)[A-Za-z0-9_]*\s*[:=]\s*['"]?([^\s'"`]{8,})/gi;

// A value that is a reference, not a credential: a path, a shell expansion, a
// placeholder, or the name of a key in the store. A key name always has an
// underscore; requiring one keeps all-caps keys (Alpaca's) from passing as names.
const isReference = (v: string): boolean => /^[~/$<{.[(]/.test(v) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/.test(v);

// Short values must carry a digit, so `token: optional` is prose while
// `password=hunter12x` (the shape of a real leak found in the vault) is not.
function assignmentHit(line: string): boolean {
  for (const m of line.matchAll(ASSIGNMENT)) {
    const v = m[1];
    if (!isReference(v) && (v.length >= 16 || /\d/.test(v))) return true;
  }
  return false;
}

// One hit per line, first rule wins (rules run specific to generic).
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  text.split("\n").forEach((line, i) => {
    let rule = PREFIX_RULES.find(([, re]) => re.test(line))?.[0];
    if (!rule && BEARER.test(line)) rule = "bearer-header";
    if (!rule && URL_TOKEN.test(line)) rule = "url-token";
    if (!rule && assignmentHit(line)) rule = "secret-assignment";
    if (rule) hits.push({ rule, line: i + 1 });
  });
  return hits;
}

export const describeHits = (hits: SecretHit[]): string =>
  hits.map((h) => `${h.rule} line ${h.line}`).join(", ");

// Returns an error string when the text holds something credential-shaped, or
// null. Pure; callers decide what to do. Run it over the whole file, frontmatter
// included: a token in frontmatter is served just the same.
export function checkSecrets(text: string): string | null {
  const hits = findSecrets(text);
  if (hits.length === 0) return null;
  return `content looks like it holds a secret (${describeHits(hits)}); keep secrets in the secrets store and reference the key name instead`;
}
