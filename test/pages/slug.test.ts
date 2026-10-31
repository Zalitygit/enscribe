import { expect, test } from "vitest";
import { normalize, slugify } from "../../src/pages/slug.js";

test("normalize is the shared key for title, alias, and slug variants", () => {
  expect(normalize("Full Title")).toBe("full title");
  expect(normalize("full-title")).toBe("full title");
  expect(normalize("  Full   Title!  ")).toBe("full title");
});

test("slugify produces a hyphenated slug", () => {
  expect(slugify("Full Title")).toBe("full-title");
  expect(slugify("full-title")).toBe("full-title");
  expect(slugify("Acme: Self-Hosted Infra")).toBe("acme-self-hosted-infra");
});

test("empty / punctuation-only input yields empty string", () => {
  expect(normalize("  ??? ")).toBe("");
  expect(slugify("!!!")).toBe("");
});

test("normalize strips mid-word diacritics (combining marks)", () => {
  expect(normalize("señor")).toBe("senor");
  expect(normalize("naïve")).toBe("naive");
  expect(normalize("café")).toBe("cafe");
});

test("slugify handles accented names", () => {
  expect(slugify("José García")).toBe("jose-garcia");
});
