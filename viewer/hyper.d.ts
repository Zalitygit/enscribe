export type Point = [number, number];
export type Tree = { parent: Map<string, string | null>; children: Map<string, string[]> };
export const UNLINKED: string;
export function norm(a: Point): number;
export function toCenter(z: Point, a: Point): Point;
export function fromCenter(z: Point, a: Point): Point;
export function drag(z: Point, p0: Point, p1: Point): Point;
export function along(a: Point, t: number): Point;
export function clampDisk(z: Point, max?: number): Point;
export function spanningTree(adj: Map<string, Set<string>>, root: string): Tree;
export function layout(tree: Tree, root: string, step?: number): Map<string, Point>;
export function matchPages(pages: Iterable<{ slug: string; title: string; type?: string | null }>, query: string): Set<string> | null;
export function subgraph(adj: Map<string, Set<string>>, keep: Set<string>): Map<string, Set<string>>;
export function markSpans(text: string, query: string): { text: string; hit: boolean }[];
export type InlineToken =
  | { t: "text" | "code"; v: string }
  | { t: "strong" | "em" | "del"; kids: InlineToken[] }
  | { t: "wikilink"; raw: string }
  | { t: "link"; label: string; href: string };
export function inlineTokens(text: string): InlineToken[];
export function tableAt(lines: string[], i: number): { align: ("left" | "center" | "right" | null)[]; head: string[]; rows: string[][]; end: number } | null;
export function quoteAt(lines: string[], i: number): { callout: string | null; title: string | null; inner: string[]; end: number } | null;
export type List = { ordered: boolean; start: number; items: { text: string; list: List | null; task?: boolean }[] };
export function listAt(lines: string[], i: number): (List & { end: number }) | null;
export function isRule(line: string): boolean;
export function setextLevel(line: string): 0 | 1 | 2;
export function parseQuery(query: string): { text: string; word: boolean; terms: string[][] };
