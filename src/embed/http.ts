import type { Embedder } from "./types.js";

const PREFIX = { document: "search_document: ", query: "search_query: " } as const;

// Ollama-compatible embeddings endpoint (POST { model, prompt } -> { embedding }).
export class HttpEmbedder implements Embedder {
  readonly model: string;
  readonly dim = 768;
  constructor(private url: string, model: string) { this.model = model; }
  async embed(text: string, kind: "document" | "query"): Promise<Float32Array> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: PREFIX[kind] + text }),
    });
    if (!res.ok) throw new Error(`embed http ${res.status}`);
    const json = (await res.json()) as { embedding: number[] };
    if (json.embedding.length !== this.dim) {
      throw new Error(`expected ${this.dim}-d, got ${json.embedding.length}`);
    }
    return Float32Array.from(json.embedding);
  }
}
