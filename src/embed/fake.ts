import { createHash } from "node:crypto";
import type { Embedder } from "./types.js";

// Deterministic pseudo-embedding for unit tests: seed a 768-d vector from a
// hash of the text so identical text yields identical vectors and related
// strings are NOT accidentally equal. Not semantically meaningful.
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embed-v0";
  readonly dim = 768;
  async embed(text: string, _kind: "document" | "query"): Promise<Float32Array> {
    const seed = createHash("sha256").update(text).digest();
    const v = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) v[i] = (seed[i % seed.length] / 255) * 2 - 1;
    return v;
  }
}
