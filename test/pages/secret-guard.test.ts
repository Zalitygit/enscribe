import { expect, test } from "vitest";
import { checkSecrets, findSecrets } from "../../src/pages/secret-guard.js";

// Fake credentials are assembled at run time so this file never holds a
// token-shaped literal: a scanner on the repo, or GitHub push protection on
// the mirror, would otherwise flag the test that pins the scanner.
const rep = (c: string, n: number) => c.repeat(n);
const HEX64 = rep("a1", 32);

const POSITIVES: [string, string][] = [
  ["github-token", "gh" + "p_" + rep("A", 36)],
  ["github-token", "github" + "_pat_" + rep("B", 60)],
  ["aws-access-key", "AK" + "IA" + rep("Q", 16)],
  ["slack-token", "xo" + "xb-" + rep("1", 12) + "-" + rep("x", 12)],
  ["anthropic-key", "sk-" + "ant-api03-" + rep("z", 40)],
  ["sk-key", "sk-" + "or-v1-" + HEX64],
  ["sk-underscore-key", "sk" + "_" + rep("f", 48)],
  ["stripe-key", "sk" + "_live_" + rep("9", 24)],
  ["google-api-key", "AI" + "za" + rep("S", 35)],
  ["huggingface-token", "h" + "f_" + rep("H", 34)],
  ["gitlab-token", "gl" + "pat-" + rep("g", 20)],
  ["digitalocean-token", "do" + "p_v1_" + HEX64],
  ["sendgrid-key", "S" + "G." + rep("s", 22) + "." + rep("t", 43)],
  ["npm-token", "np" + "m_" + rep("n", 36)],
  ["telnyx-key", "K" + "EY" + rep("0", 32) + "_" + rep("T", 22)],
  ["jwt", "ey" + "J" + rep("h", 20) + ".ey" + "J" + rep("p", 20) + "." + rep("s", 20)],
  ["private-key", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"],
  ["bearer-header", "Authorization: Bear" + "er " + HEX64],
  ["url-token", "https://x.example/mcp?to" + "ken=" + HEX64],
  ["secret-assignment", "AUCTION_MCP_BEAR" + "ER=" + HEX64],
  ["secret-assignment", "SMTP_PA" + "SS='" + "s3cretPassw0rd;'"],
  ["secret-assignment", "api_" + "key: \"" + rep("k", 24) + "\""],
  // All-caps keys are not key names; a `_KEY` suffix counts without `API`.
  ["secret-assignment", "ALPACA_API_" + "KEY=PK" + rep("Q7", 9)],
  ["secret-assignment", "GODADDY_" + "KEY=" + HEX64],
  // The shape of a real Asterisk SIP password found in a vault session note.
  ["secret-assignment", "- `pass" + "word=" + "abcdefgh123` on both endpoints."],
];

for (const [rule, token] of POSITIVES) {
  test(`${rule} fires on ${token.slice(0, 12)}…`, () => {
    const hits = findSecrets(`# Page\n\nSome prose.\n${token}\n`);
    expect(hits).toEqual([{ rule, line: 4 }]);
  });
}

// Each of these is what a vault page about credentials legitimately says.
// A false positive refuses a write, so every one is pinned.
const NEGATIVES: string[] = [
  "Rotate the bearer token in tokens.json, then restart macbrain-serve.",
  "Authorization: Bearer <token>",
  "curl -H 'Authorization: Bearer $API_BEARER' https://api.example.com/mcp",
  "MACBRAIN_TOKENS=~/.macbrain/tokens.json",
  "SMTP_PASS='s3cret;'", // too short to be anything but an example
  "password: ${SMTP_PASS}",
  "TOKEN=$(secret env AUCTION_MCP_BEARER)",
  "token expiration and password management are separate concerns",
  "Commit a65f35d0c1e2b3a4f5d6e7c8b9a0f1e2d3c4b5a6 landed the change.", // git SHA
  "sha256: " + HEX64, // a digest is not a secret
  "Keys look like sk-ant-api03-... and live in the store.",
  "pk" + "_live_" + rep("9", 24), // publishable, not secret
  "sk" + "_test_" + rep("9", 24), // test-mode, harmless
  "-----BEGIN PUBLIC KEY-----",
  "The `api_key:` field takes the KEY NAME, e.g. api_key: ANTHROPIC_API_KEY",
  "token: optional; password: required",
  "sort_key: created_at",
];

for (const text of NEGATIVES) {
  test(`no hit: ${text.slice(0, 50)}`, () => {
    expect(findSecrets(text)).toEqual([]);
  });
}

test("reports one hit per line, first rule wins, never the matched text", () => {
  const anth = "sk-" + "ant-api03-" + rep("z", 40); // also matches the generic sk- rule
  const hits = findSecrets(`a\n${anth}\nb\nAuthorization: Bear` + "er " + HEX64 + "\n");
  expect(hits).toEqual([{ rule: "anthropic-key", line: 2 }, { rule: "bearer-header", line: 4 }]);
  expect(JSON.stringify(hits)).not.toContain("zzzz");
});

test("checkSecrets names the rule and line but not the secret", () => {
  const err = checkSecrets("# x\n\nAUCTION_MCP_BEAR" + "ER=" + HEX64 + "\n");
  expect(err).toContain("secret-assignment");
  expect(err).toContain("line 3");
  expect(err).not.toContain(HEX64);
});

test("checkSecrets is null on clean content", () => {
  expect(checkSecrets("# Redis\n\nIn-memory store.\n")).toBeNull();
});
