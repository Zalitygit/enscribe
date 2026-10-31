import { z } from "zod";
import { RECORD_TYPES } from "./core/types.js";

// Single source of truth for record validation, shared by the MCP server (tool
// input schemas) and the CLI (ingest) so both boundaries validate the same shape
// before a record reaches the store.
export const typeEnum = z.enum(RECORD_TYPES as [string, ...string[]]);

export const recordShape = {
  type: typeEnum,
  subject: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
  relationships: z.array(z.object({ predicate: z.string(), object: z.string() })).optional(),
  source: z.object({ kind: z.string(), application: z.string().optional() }).optional(),
  provenance: z.object({ author: z.string(), confidence: z.number().min(0).max(1) }).optional(),
};

export const recordInputSchema = z.object(recordShape);
