import { expect, test } from "vitest";
import { parseTokens, authenticate } from "../../src/mcp/auth.js";

test("parseTokens builds clients; '*' expands to all scopes", () => {
  const t = parseTokens({
    admin: { name: "admin", scopes: ["*"] },
    reader: { name: "reader", scopes: ["memory.read", "memory.search"] },
  });
  expect(t.get("admin")!.scopes.has("memory.delete")).toBe(true);
  expect(t.get("admin")!.scopes.has("memory.private")).toBe(true);
  expect(t.get("reader")!.scopes.has("memory.read")).toBe(true);
  expect(t.get("reader")!.scopes.has("memory.delete")).toBe(false);
});

test("authenticate resolves a valid bearer and rejects missing/invalid", () => {
  const t = parseTokens({ tok: { name: "c", scopes: ["memory.read"] } });
  expect(authenticate(t, "Bearer tok")?.name).toBe("c");
  expect(authenticate(t, "bearer tok")?.name).toBe("c"); // scheme is case-insensitive
  expect(authenticate(t, "Bearer nope")).toBeNull();
  expect(authenticate(t, "tok")).toBeNull(); // no Bearer scheme
  expect(authenticate(t, undefined)).toBeNull();
});
