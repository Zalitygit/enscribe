import { expect, test } from "vitest";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { OnnxEmbedder } from "../../src/embed/onnx.js";
import { SearchService } from "../../src/search/index.js";

// Downloads the model on first run; the 30s testTimeout covers it.
test("semantic search retrieves a record via a paraphrase sharing few exact words", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new OnnxEmbedder());

  const rec = store.add({
    type: "fact",
    subject: "Payments switch",
    content: "The Base24 system authorized credit card transactions for the bank.",
  });
  await search.index(rec);

  const hits = await search.search("card payment authorization platform");
  const hit = hits.find((h) => h.record.id === rec.id);
  expect(hit).toBeDefined();
  expect(hit?.vector).toBe(true);
});
