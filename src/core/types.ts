export type RecordType =
  | "fact" | "note" | "document" | "event" | "person" | "project"
  | "decision" | "preference" | "task" | "conversation" | "source";

export const RECORD_TYPES: RecordType[] = [
  "fact", "note", "document", "event", "person", "project",
  "decision", "preference", "task", "conversation", "source",
];

export interface Entity { type: string; id: string; }
export interface Relationship { predicate: string; object: string; }
export interface Source { kind: string; application?: string; }
export interface Provenance { author: string; confidence: number; }

export interface RecordInput {
  type: RecordType;
  subject: string;
  content: string;
  source?: Source;
  entities?: Entity[];
  tags?: string[];
  relationships?: Relationship[];
  provenance?: Provenance;
}

export interface MemoryRecord extends Required<Omit<RecordInput, "relationships">> {
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  supersedes: string | null;
  content_hash: string;
  relationships: Relationship[];
}
