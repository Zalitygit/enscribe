import { expect, test } from "vitest";
import { OnnxEmbedder } from "../../src/embed/onnx.js";

// Downloads the model on first run; the 30s testTimeout covers it.
test("OnnxEmbedder returns a normalized 768-d vector, deterministic per input", async () => {
  const e = new OnnxEmbedder();
  const a = await e.embed("MacBrain stores memory in SQLite", "document");
  const b = await e.embed("MacBrain stores memory in SQLite", "document");
  expect(a.length).toBe(768);
  expect(Array.from(a)).toEqual(Array.from(b));
  const norm = Math.sqrt(Array.from(a).reduce((s, x) => s + x * x, 0));
  expect(norm).toBeCloseTo(1, 1); // L2-normalized
});
