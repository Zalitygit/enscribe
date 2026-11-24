export function demoPlan(
  nodes: Iterable<{ slug: string; kind?: string; findings?: number; declined?: string[] }>,
  adj: Map<string, Set<string>>,
  home: string | null,
  limit?: number,
): string[];
export type DemoLine = { text: string; level: "info" | "flag" | "ok" };
export function describePage(
  p: { title: string; kind: string; source_path?: string | null; links: string[]; backlinks: string[]; unresolved: string[]; trust: Record<string, unknown>; findings?: { kind: string }[]; declined?: { kind: string; subject: string }[] },
  today: string,
): DemoLine[];
export const DEMO_SPEEDS: number[];
export const DEMO_LENGTHS: number[];
export function demoDelays(speed: number): { line: number; flag: number; page: number; glide: number; settle: number };
