// Demo mode for the page viewer: a scripted tour that shows what a gardener
// pass looks at, page by page. It only reads what the viewer already can
// (the graph and each page's API answer) and writes nothing anywhere. Pure
// functions only, so they can be unit-tested in Node.

// The pages the tour visits, in order: the hub first, then pages with open
// findings (most first), then unlinked authored pages (the likely orphans),
// then a breadth-first walk out from the hub by descending degree. Each page
// once, at most `limit` of them.
export function demoPlan(nodes, adj, home, limit = 24) {
  const out = [];
  const add = (s) => { if (out.length < limit && !out.includes(s)) out.push(s); };
  const list = [...nodes];
  const bySlug = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const deg = (s) => (adj.get(s) ? adj.get(s).size : 0);
  if (home) add(home);
  list.filter((n) => n.findings).sort((a, b) => b.findings - a.findings || bySlug(a.slug, b.slug)).forEach((n) => add(n.slug));
  list.filter((n) => deg(n.slug) === 0 && n.kind !== "raw" && n.kind !== "generated" && !(n.declined || []).includes("orphan"))
    .map((n) => n.slug).sort(bySlug).forEach(add);
  if (home) {
    const seen = new Set([home]);
    const queue = [home];
    while (queue.length && out.length < limit) {
      const s = queue.shift();
      add(s);
      for (const n of [...(adj.get(s) || [])].sort((a, b) => deg(b) - deg(a) || bySlug(a, b))) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
  }
  return out;
}

// What a gardener would note about one page, from the viewer's page API
// answer: links in and out, orphan status, unresolved links, a review date
// that has passed, and open findings. An orphan is an authored page with no
// inbound links outside raw/ and daily/, the rule the nightly orphan detector
// uses (PagesStore.orphans, src/findings/detectors.ts). A check whose finding
// the owner declined (wont_fix, in `p.declined`) is left out entirely: an
// orphan or stale finding by kind, a red link by its target. `today` is
// YYYY-MM-DD. Each line is info, a flag, or the all-clear.
const ORPHAN_EXEMPT = ["raw/", "daily/"];
export function describePage(p, today) {
  const lines = [
    { text: `reading “${p.title}” (${p.kind})`, level: "info" },
    { text: `${p.links.length} links out, ${p.backlinks.length} in`, level: "info" },
  ];
  const flag = (text) => lines.push({ text, level: "flag" });
  const declined = p.declined || [];
  const declinedKind = (kind) => declined.some((d) => d.kind === kind);
  const declinedLink = (u) => declined.some((d) => (d.kind === "unresolved" || d.kind === "red-link") && d.subject === u);
  if (!p.backlinks.length && !declinedKind("orphan")) {
    if (p.kind === "generated") {
      lines.push({ text: "no inbound links (generated pages are exempt)", level: "info" });
    } else if (ORPHAN_EXEMPT.some((x) => (p.source_path || "").startsWith(x))) {
      lines.push({ text: "no inbound links (raw/ and daily/ pages are exempt)", level: "info" });
    } else flag("orphan: no inbound links");
  }
  for (const u of p.unresolved) if (!declinedLink(u)) flag(`red link: [[${u}]]`);
  const due = p.trust && p.trust.stale_after;
  if (typeof due === "string" && due < today && !declinedKind("stale")) flag(`stale: due for review since ${due}`);
  for (const f of p.findings || []) flag(`open finding: ${f.kind}`);
  if (!lines.some((l) => l.level === "flag")) lines.push({ text: "looks healthy", level: "ok" });
  return lines;
}

// The tour speeds and lengths the controls offer.
export const DEMO_SPEEDS = [0.5, 1, 2, 4];
export const DEMO_LENGTHS = [12, 24, 48];

// The tour's pauses at `speed` (2 = twice as fast), in ms: after an info
// line, after a flag, between pages, and the two map animations (the glide to
// the page and the settle around it). The animations keep a floor so the map
// still visibly moves at top speed. A speed that is not a positive finite
// number counts as 1.
const BASE_DELAYS = { line: 350, flag: 650, page: 900, glide: 450, settle: 350 };
const MIN_ANIMATION = 120;
export function demoDelays(speed) {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const d = Object.fromEntries(Object.entries(BASE_DELAYS).map(([k, v]) => [k, Math.round(v / s)]));
  d.glide = Math.max(MIN_ANIMATION, d.glide);
  d.settle = Math.max(MIN_ANIMATION, d.settle);
  return d;
}
