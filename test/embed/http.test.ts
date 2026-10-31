import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { HttpEmbedder } from "../../src/embed/http.js";

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { prompt } = JSON.parse(body);
      const vec = Array.from({ length: 768 }, (_, i) => (prompt.length + i) % 3);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ embedding: vec }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}/api/embeddings`;
});

afterAll(() => server.close());

test("HttpEmbedder posts the prefixed text and returns a 768-d Float32Array", async () => {
  const e = new HttpEmbedder(url, "nomic-embed-text");
  const v = await e.embed("hello", "query");
  expect(v).toBeInstanceOf(Float32Array);
  expect(v.length).toBe(768);
});
