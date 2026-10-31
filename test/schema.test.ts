import { expect, test } from "vitest";
import { recordInputSchema } from "../src/schema.js";

const base = { type: "note", subject: "s", content: "c" };

test("rejects empty subject or content", () => {
  expect(recordInputSchema.safeParse({ ...base, subject: "" }).success).toBe(false);
  expect(recordInputSchema.safeParse({ ...base, content: "" }).success).toBe(false);
  expect(recordInputSchema.safeParse(base).success).toBe(true);
});

test("bounds provenance.confidence to [0,1]", () => {
  expect(recordInputSchema.safeParse({ ...base, provenance: { author: "u", confidence: 2 } }).success).toBe(false);
  expect(recordInputSchema.safeParse({ ...base, provenance: { author: "u", confidence: -0.1 } }).success).toBe(false);
  expect(recordInputSchema.safeParse({ ...base, provenance: { author: "u", confidence: 0.5 } }).success).toBe(true);
});

test("rejects an out-of-set record type", () => {
  expect(recordInputSchema.safeParse({ ...base, type: "not-a-real-type" }).success).toBe(false);
});
