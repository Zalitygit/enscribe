export interface Embedder {
  readonly model: string;
  readonly dim: number;
  // `kind` selects the task prefix nomic-style models require.
  embed(text: string, kind: "document" | "query"): Promise<Float32Array>;
}

export interface EmbedderConfig {
  backend?: "onnx" | "http" | "fake";
  httpUrl?: string;   // e.g. http://localhost:11434/api/embeddings
  httpModel?: string; // e.g. nomic-embed-text
}
