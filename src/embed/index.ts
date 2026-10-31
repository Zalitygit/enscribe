import type { Embedder, EmbedderConfig } from "./types.js";
import { OnnxEmbedder } from "./onnx.js";
import { HttpEmbedder } from "./http.js";
import { FakeEmbedder } from "./fake.js";

export type { Embedder, EmbedderConfig } from "./types.js";
export { OnnxEmbedder } from "./onnx.js";
export { HttpEmbedder } from "./http.js";
export { FakeEmbedder } from "./fake.js";

export function createEmbedder(config: EmbedderConfig = {}): Embedder {
  switch (config.backend) {
    case "http":
      if (!config.httpUrl) throw new Error("httpUrl required for http backend");
      return new HttpEmbedder(config.httpUrl, config.httpModel ?? "nomic-embed-text");
    case "fake":
      return new FakeEmbedder();
    case "onnx":
    default:
      return new OnnxEmbedder();
  }
}
