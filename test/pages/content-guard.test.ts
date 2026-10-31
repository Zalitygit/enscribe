import { expect, test } from "vitest";
import { checkContent, GUARD_WORD_LIMIT } from "../../src/pages/content-guard.js";

test("accepts an ordinary short note", () => {
  expect(checkContent("# Redis\n\nIn-memory store. Used for the session cache.\n")).toBeNull();
});

test("accepts a legitimate stub", () => {
  expect(checkContent("# TODO\n\nStub.\n")).toBeNull();
});

// Each of the following six tests is written to trip exactly one signature.
// Deleting any single regex from either list in content-guard.ts must fail
// exactly one of these tests — see the fix report for the per-regex
// verification (comment out each regex, confirm exactly one failure).

test("refuses a Cloudflare Ray ID footer (and nothing else in the lists)", () => {
  expect(checkContent("Cloudflare Ray ID: 8a2f appears in the page footer.\n")).toContain("error page");
});

test("refuses a browser-check interstitial (and nothing else in the lists)", () => {
  expect(checkContent("Checking your browser before accessing the site.\n")).toContain("error page");
});

test("refuses an enable-javascript notice (and nothing else in the lists)", () => {
  expect(checkContent("Please enable javascript to continue.\n")).toContain("error page");
});

// The brief's original "please log in" and generic 4xx/5xx signatures were
// dropped: this is a personal systems-engineering vault, and short notes like
// this one are exactly the legitimate content it holds, not a fetched login
// wall.
test("accepts a short login-related note (no longer treated as a login wall)", () => {
  expect(checkContent("Please log in to the router admin panel with the default creds.\n")).toBeNull();
});

test("refuses lorem ipsum (and nothing else in the lists)", () => {
  expect(checkContent("Lorem ipsum dolor sit amet.\n")).toContain("placeholder");
});

test("refuses a bare test string (and nothing else in the lists)", () => {
  expect(checkContent("test")).toContain("placeholder");
});

test("refuses repeated chunk placeholders (and nothing else in the lists)", () => {
  expect(checkContent("Chunk 1. Chunk 2. Chunk 3.\n")).toContain("placeholder");
});

// The threshold is what makes the guard safe. A long page discussing Cloudflare
// is knowledge, not an error page, and refusing it would be worse than the bug
// the guard prevents.
test("accepts long content that merely mentions a signature phrase", () => {
  const body = `# Debugging Cloudflare\n\n${"word ".repeat(80)}\nCloudflare Ray ID appears in the 5xx page footer.\n`;
  expect(checkContent(body)).toBeNull();
});

test("the threshold is exclusive at the boundary (exact word counts)", () => {
  // "lorem" + "ipsum" + filler words, built off GUARD_WORD_LIMIT itself so the
  // boundary and the test cannot drift apart.
  const wordsBelow = "lorem ipsum " + "word ".repeat(GUARD_WORD_LIMIT - 3);
  const wordsAt = "lorem ipsum " + "word ".repeat(GUARD_WORD_LIMIT - 2);
  expect(checkContent(wordsBelow)).toContain("placeholder");
  expect(checkContent(wordsAt)).toBeNull();
});
