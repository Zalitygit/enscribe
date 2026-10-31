import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embedder } from "./types.js";

const MODEL = "nomic-ai/nomic-embed-text-v1.5";
const PREFIX = { document: "search_document: ", query: "search_query: " } as const;

// In-process ONNX embeddings. First run downloads the model to the HF cache;
// subsequent runs are offline. Mean-pooled + L2-normalized, 768-d.
export class OnnxEmbedder implements Embedder {
  readonly model = MODEL;
  readonly dim = 768;
  private extractor: Promise<FeatureExtractionPipeline> | null = null;

  private get pipe(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      console.error("[enscribe] loading embedding model nomic-embed-text-v1.5 (downloads ~100MB if not cached)...");
      // `pipeline`'s generic overload resolves to a union type too complex for
      // tsc to represent here (TS2590); the `any` cast sidesteps inference,
      // the `as Promise<...>` below restores the real return type.
      this.extractor = (pipeline as any)("feature-extraction", MODEL) as Promise<FeatureExtractionPipeline>;
    }
    return this.extractor;
  }

  async embed(text: string, kind: "document" | "query"): Promise<Float32Array> {
    const extractor = await this.pipe;
    const out = await extractor(PREFIX[kind] + text, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data as Float32Array);
  }
}
