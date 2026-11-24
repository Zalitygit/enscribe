// enscribe page viewer: a Poincaré-disk map of the wiki link graph.
// Click a page to bring it to the centre and open it; drag to move around.
// Every element is built with textContent, never innerHTML, so page text can
// never become markup.
import { DEMO_LENGTHS, DEMO_SPEEDS, demoDelays, demoPlan, describePage } from "./demo.js";
import { UNLINKED, along, clampDisk, drag, inlineTokens, isRule, layout, listAt, markSpans, matchPages, norm, parseQuery, quoteAt, setextLevel, spanningTree, subgraph, tableAt, toCenter } from "./hyper.js";

const TOKEN_KEY = "enscribe.view.token";
const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem(TOKEN_KEY);
let nodes = new Map();      // slug -> { slug, title, kind, type, findings }
let adj = new Map();        // slug -> Set(slug), undirected
let home = null;            // most-linked page
let root = null;            // current tree root
let tree = null;
let pos = new Map();        // slug -> [x, y], what is drawn
let selected = null;
let busy = false;
let filter = null;          // Set(slug) the search box picked out, or null for the whole graph
let summary = "";           // the status line when no filter is on
let demo = null;            // { stop } while the demo tour runs
let flagged = new Set();    // pages the demo tour flagged, ringed on the map

// ---------- data ----------

async function api(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { auth: true });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function load() {
  const g = await api("/view/api/graph");
  nodes = new Map(g.nodes.map((n) => [n.slug, n]));
  adj = new Map(g.nodes.map((n) => [n.slug, new Set()]));
  for (const [a, b] of g.links) {
    if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); }
  }
  home = [...adj.keys()].sort((a, b) => adj.get(b).size - adj.get(a).size || (a < b ? -1 : 1))[0] || null;
  const titles = $("titles");
  titles.replaceChildren(...[...nodes.values()].map((n) => {
    const o = document.createElement("option");
    o.value = n.title;
    return o;
  }));
  summary = `${nodes.size} pages, ${g.links.length} links`;
  $("status").textContent = summary;
}

// Client-side wikilink resolution: slug, then title, then a slugified form.
// The server's alias tier is not mirrored, so an alias-only link shows as
// unresolved here while it still works in search.
function resolve(raw) {
  const target = raw.split("|")[0].split("#")[0].trim();
  if (nodes.has(target)) return target;
  const lower = target.toLowerCase();
  for (const n of nodes.values()) if (n.title.toLowerCase() === lower) return n.slug;
  const slug = lower.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return nodes.has(slug) ? slug : null;
}

// ---------- drawing ----------

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

function draw() {
  const svg = $("disk");
  svg.replaceChildren();
  el("circle", { class: "rim", cx: 0, cy: 0, r: 1 }, svg);
  const edges = el("g", {}, svg);
  const dots = el("g", {}, svg);
  const labels = el("g", {}, svg);
  const scale = (z) => 1 - z[0] * z[0] - z[1] * z[1];

  for (const [s, p] of tree.parent) {
    if (!p || !pos.has(s) || !pos.has(p)) continue;
    const a = pos.get(s), b = pos.get(p);
    const w = 0.004 * Math.min(scale(a), scale(b)) + 0.0005;
    el("line", { class: "edge", x1: a[0], y1: a[1], x2: b[0], y2: b[1], "stroke-width": w }, edges);
  }
  // The selected page's links that are not tree edges, highlighted.
  if (selected && pos.has(selected)) {
    const a = pos.get(selected);
    for (const n of adj.get(selected) || []) {
      if (tree.parent.get(n) === selected || tree.parent.get(selected) === n || !pos.has(n)) continue;
      const b = pos.get(n);
      el("line", { class: "edge hot", x1: a[0], y1: a[1], x2: b[0], y2: b[1], "stroke-width": 0.002 }, edges);
    }
  }

  // Labels are placed greedily, biggest node first (the selected page always
  // wins), and a label that would overlap one already placed is skipped. The
  // width is estimated from the character count; exact text metrics would
  // need a layout pass per frame.
  const placed = [];
  const fits = (b) => placed.every((p) => b[2] < p[0] || b[0] > p[2] || b[3] < p[1] || b[1] > p[3]);
  const wanted = [...pos].filter(([, z]) => scale(z) > 0.3)
    .sort(([a, za], [b, zb]) => (b === selected) - (a === selected) || scale(zb) - scale(za));
  for (const [s, z] of wanted) {
    const k = scale(z);
    const text = s === UNLINKED ? "(unlinked)" : nodes.get(s).title;
    const size = 0.05 * k, y = z[1] - 0.04 * k - 0.006, half = text.length * size * 0.29;
    const box = [z[0] - half, y - size, z[0] + half, y + size * 0.25];
    if (!fits(box)) continue;
    placed.push(box);
    const t = el("text", { class: "label", x: z[0], y, "font-size": size, "stroke-width": 0.012 * k }, labels);
    t.textContent = text;
  }

  for (const [s, z] of pos) {
    const k = scale(z);
    if (k < 0.004) continue;
    const n = nodes.get(s);
    const kind = s === UNLINKED ? "unlinked" : n.kind;
    const cls = ["node", kind];
    if (n && n.findings) cls.push("has-findings");
    if (s === selected) cls.push("focus");
    if (flagged.has(s)) el("circle", { class: "ring", cx: z[0], cy: z[1], r: 0.05 * k + 0.004, "stroke-width": 0.006 * k + 0.001 }, dots);
    const c = el("circle", { class: cls.join(" "), cx: z[0], cy: z[1], r: 0.032 * k + 0.002, "stroke-width": 0.006 * k }, dots);
    c.dataset.slug = s;
    const tip = el("title", {}, c);
    tip.textContent = s === UNLINKED ? "Pages no link path reaches (click to list them)" : `${n.title} (${n.slug})${n.findings ? `, ${n.findings} open finding(s)` : ""}`;
  }
}

// ---------- motion ----------

function animate(ms, step) {
  return new Promise((done) => {
    const t0 = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      draw();
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
}

function rebuild(slug) {
  root = slug;
  tree = spanningTree(filter ? subgraph(adj, filter) : adj, root);
  return layout(tree, root);
}

// A query matches a page by its title, slug or type (here) or by its text (the
// server's keyword index, every term as a word prefix, or with a final / as a whole
// unstemmed word; a hyphenated or quoted term as a phrase). If the server
// cannot be reached, the title matches alone are shown. A newer query discards
// the answer to an older one.
let searchSeq = 0;
async function applySearch(query) {
  const seq = ++searchSeq;
  let m = matchPages(nodes.values(), query);
  if (m) {
    const { text, word } = parseQuery(query);
    try {
      const { slugs } = await api(`/view/api/search?q=${encodeURIComponent(text)}${word ? "&word=1" : ""}`);
      for (const s of slugs) if (nodes.has(s)) m.add(s);
    } catch { /* title matches only */ }
  }
  if (seq === searchSeq) showMatches(m);
}

// Show only the pages in `m`, and the links among them, rooted at the
// selected page if it matched, else at the best-linked match. Matches with no
// link path to the root gather in the (unlinked) cluster. null shows the whole
// graph, and so does an empty set, with "No pages match": leaving the previous
// query's matches up would show pages this query does not match.
function showMatches(m) {
  if (busy) { setTimeout(() => showMatches(m), 100); return; }
  const none = m && !m.size;
  if (none) m = null;
  filter = m;
  $("status").textContent = none ? "No pages match" : m ? `${m.size} of ${nodes.size} pages match` : summary;
  let r = selected && (!m || m.has(selected)) ? selected : home;
  if (m && !m.has(r)) {
    const sub = subgraph(adj, m);
    r = [...m].sort((a, b) => sub.get(b).size - sub.get(a).size || (a < b ? -1 : 1))[0];
  }
  pos = rebuild(r);
  draw();
  highlight($("page"), $("find").value);
}

function clearSearch() {
  $("find").value = "";
  filter = null;
  $("status").textContent = summary;
}

// Bring `slug` to the centre along a geodesic, then re-root the tree there and
// ease every page into its new place, so the neighbourhood of the new centre
// unfolds. `glide` and `settle` are the two animations' lengths in ms; the
// demo tour passes its own to change speed.
async function focusOn(slug, { open = true, glide = 450, settle = 350 } = {}) {
  if (!nodes.has(slug) || busy) return;
  if (filter && !filter.has(slug)) clearSearch();
  busy = true;
  selected = slug;
  if (location.hash.slice(1) !== encodeURIComponent(slug)) history.replaceState(null, "", `#${encodeURIComponent(slug)}`);
  const a = pos.get(slug) || [0, 0];
  const start = new Map(pos);
  if (norm(a) > 1e-6) await animate(glide, (t) => {
    const c = along(a, t);
    for (const [s, z] of start) pos.set(s, toCenter(z, c));
  });
  const from = new Map(pos);
  const to = rebuild(slug);
  await animate(settle, (t) => {
    pos = new Map();
    for (const [s, z1] of to) {
      const z0 = from.get(s) || z1;
      pos.set(s, [z0[0] + (z1[0] - z0[0]) * t, z0[1] + (z1[1] - z0[1]) * t]);
    }
  });
  busy = false;
  if (open) return openPage(slug);
}

// ---------- page panel ----------

function h(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function chip(slug) {
  const b = h("button", nodes.get(slug) ? nodes.get(slug).title : slug, "chip");
  b.type = "button";
  b.title = slug;
  b.addEventListener("click", () => focusOn(slug));
  return b;
}

// Inline markdown (see inlineTokens) as DOM nodes.
function inline(parent, text) {
  render(parent, inlineTokens(text));
}

function render(parent, tokens) {
  for (const k of tokens) {
    if (k.t === "text") parent.appendChild(document.createTextNode(k.v));
    else if (k.t === "code") parent.appendChild(h("code", k.v));
    else if (k.t === "strong" || k.t === "em" || k.t === "del") { const s = h(k.t); render(s, k.kids); parent.appendChild(s); }
    else if (k.t === "wikilink") {
      const label = k.raw.includes("|") ? k.raw.split("|").slice(1).join("|") : k.raw;
      const target = resolve(k.raw);
      if (target) {
        const b = h("button", label, "wikilink");
        b.type = "button";
        b.addEventListener("click", () => focusOn(target));
        parent.appendChild(b);
      } else parent.appendChild(h("span", label, "unresolved"));
    } else {
      const a = h("a", k.label);
      a.href = k.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
  }
}

function table(t) {
  const wrap = h("div", undefined, "table");
  const tbl = h("table");
  const row = (cells, tag) => {
    const tr = h("tr");
    cells.forEach((c, i) => {
      const td = h(tag);
      if (t.align[i]) td.style.textAlign = t.align[i];
      inline(td, c);
      tr.appendChild(td);
    });
    return tr;
  };
  const thead = h("thead");
  thead.appendChild(row(t.head, "th"));
  const tbody = h("tbody");
  for (const r of t.rows) tbody.appendChild(row(r, "td"));
  tbl.append(thead, tbody);
  wrap.appendChild(tbl);
  return wrap;
}

// A list tree from listAt as <ol>/<ul>, nested lists inside their item. A
// task item gets a checkbox that shows its state and cannot be changed here.
function list(l) {
  const e = h(l.ordered ? "ol" : "ul");
  if (l.ordered && l.start !== 1) e.start = l.start;
  for (const it of l.items) {
    const li = h("li");
    if (it.task !== undefined) {
      const box = h("input");
      box.type = "checkbox";
      box.checked = it.task;
      box.disabled = true;
      li.className = "task";
      li.appendChild(box);
    }
    inline(li, it.text);
    if (it.list) li.appendChild(list(it.list));
    e.appendChild(li);
  }
  return e;
}

// Block markdown: fenced code, rules, tables, blockquotes (nested) and
// callouts, headings (ATX and setext), numbered, bullet and nested lists,
// paragraphs.
function renderBody(md) {
  const out = h("div", undefined, "body");
  const lines = md.split("\n");
  let para = [];
  const flush = () => {
    if (para.length) { const p = h("p"); inline(p, para.join(" ")); out.appendChild(p); para = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = h("pre");
      pre.appendChild(h("code", code.join("\n")));
      out.appendChild(pre);
      continue;
    }
    const setext = para.length ? setextLevel(line) : 0;
    if (setext) { const e = h(`h${setext + 2}`); inline(e, para.join(" ")); para = []; out.appendChild(e); continue; }
    if (isRule(line)) { flush(); out.appendChild(h("hr")); continue; }
    const tbl = tableAt(lines, i);
    if (tbl) { flush(); out.appendChild(table(tbl)); i = tbl.end - 1; continue; }
    const q = quoteAt(lines, i);
    if (q) {
      flush();
      const bq = h("blockquote", undefined, q.callout ? `callout ${q.callout}` : undefined);
      if (q.title) { const t = h("div", undefined, "callout-title"); inline(t, q.title); bq.appendChild(t); }
      bq.appendChild(renderBody(q.inner.join("\n")));
      out.appendChild(bq);
      i = q.end - 1;
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { flush(); const e = h(`h${Math.min(6, head[1].length + 2)}`); inline(e, head[2]); out.appendChild(e); continue; }
    const l = listAt(lines, i);
    if (l) { flush(); out.appendChild(list(l)); i = l.end - 1; continue; }
    if (line.trim() === "") { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

// Mark the words in `root` that the search box query matches, first taking
// out any marks from an earlier query. Only text nodes are touched, so page
// text still never becomes markup.
function highlight(root, query) {
  for (const m of root.querySelectorAll("mark")) m.replaceWith(m.textContent);
  root.normalize();
  if (!query.trim()) return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walk.nextNode()) texts.push(walk.currentNode);
  for (const t of texts) {
    const spans = markSpans(t.data, query);
    if (spans.length === 1 && !spans[0].hit) continue;
    t.replaceWith(...spans.map((s) => (s.hit ? h("mark", s.text) : document.createTextNode(s.text))));
  }
}

function section(title, items) {
  const frag = document.createDocumentFragment();
  frag.appendChild(h("h4", `${title} (${items.length})`, "section"));
  const box = h("div", undefined, "chips");
  for (const s of items) box.appendChild(chip(s));
  frag.appendChild(box);
  return frag;
}

async function openPage(slug) {
  const panel = $("panel"), page = $("page");
  panel.hidden = false;
  page.replaceChildren(h("p", "Loading…", "meta"));
  let p;
  try { p = await api(`/view/api/page?slug=${encodeURIComponent(slug)}`); }
  catch (e) { page.replaceChildren(h("p", `Could not load ${slug}: ${e.message}`, "meta")); return; }
  if (selected !== slug) return;
  const parts = [h("h2", p.title), h("div", [p.slug, p.kind, p.type, p.source_path].filter(Boolean).join(" · "), "meta")];
  if (Object.keys(p.trust).length) {
    const t = h("div", undefined, "trust");
    for (const [k, v] of Object.entries(p.trust)) t.appendChild(h("div", `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
    parts.push(t);
  }
  if (p.findings && p.findings.length) {
    const f = h("div", undefined, "findings");
    for (const x of p.findings) f.appendChild(h("div", `${x.kind}: ${x.detail}`));
    parts.push(f);
  }
  parts.push(section("Links", p.links), section("Backlinks", p.backlinks));
  if (p.unresolved.length) parts.push(h("div", `Unresolved: ${p.unresolved.join(", ")}`, "meta"));
  parts.push(renderBody(p.body));
  page.replaceChildren(...parts);
  highlight(page, $("find").value);
  const first = page.querySelector(".body mark");
  if (first) first.scrollIntoView({ block: "center" }); else panel.scrollTop = 0;
  return p;
}

// The (unlinked) cluster in the panel: every page the current root has no
// link path to, in the tree's order (best-linked first, so islands come
// before loners), each a chip that opens it.
function openUnlinked() {
  const panel = $("panel"), page = $("page");
  const rest = (tree && tree.children.get(UNLINKED)) || [];
  selected = null;
  panel.hidden = false;
  page.replaceChildren(
    h("h2", "(unlinked)"),
    h("div", `Pages no link path from ${nodes.get(root) ? nodes.get(root).title : root} reaches${filter ? ", among the search matches" : ""}`, "meta"),
    section("Pages", rest));
  panel.scrollTop = 0;
}

// ---------- demo ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The tour's speed and length, from the header controls, kept in this
// browser. Speed is read at every pause, so a change applies mid-tour.
const SPEED_KEY = "enscribe.view.demo-speed", LENGTH_KEY = "enscribe.view.demo-length";
const demoSpeed = () => Number($("demo-speed").value);

function wireDemoControls() {
  const fill = (id, values, key, fallback, label) => {
    const sel = $(id);
    sel.replaceChildren(...values.map((v) => { const o = h("option", label(v)); o.value = String(v); return o; }));
    const saved = Number(localStorage.getItem(key));
    sel.value = String(values.includes(saved) ? saved : fallback);
    sel.addEventListener("change", () => { localStorage.setItem(key, sel.value); sel.blur(); });
  };
  fill("demo-speed", DEMO_SPEEDS, SPEED_KEY, 1, (v) => (v === 0.5 ? "½×" : `${v}×`));
  fill("demo-length", DEMO_LENGTHS, LENGTH_KEY, 24, (v) => `${v} pages`);
}

// Wait `ms` of tour time: time spent paused does not count, and a stop or a
// skip ends the wait at once.
async function pace(run, ms) {
  let left = ms;
  while (left > 0 && !run.stop && !run.skip) {
    await sleep(Math.min(50, left));
    if (!run.paused) left -= 50;
  }
}

// A read-only gardener pass to watch: the tour from demoPlan, each page
// opened on the map and its checks narrated from its own data. It reads what
// a click would and writes nothing; the parts of a real pass that need a
// model are named as skipped. Space pauses and resumes, the right arrow skips
// to the next page, and the button or Escape stops it.
async function runDemo() {
  if (demo) { demo.stop = true; return; }
  const run = demo = { stop: false, skip: false, paused: false };
  $("demo").textContent = "Stop";
  $("demo").blur(); // so Space pauses the tour instead of pressing the button
  clearSearch();
  flagged = new Set();
  const log = $("demo-log");
  log.replaceChildren();
  log.hidden = false;
  const say = (text, level = "info") => {
    log.appendChild(h("li", text, level));
    while (log.children.length > 10) log.firstChild.remove();
  };
  run.say = say;
  const today = new Date().toLocaleDateString("en-CA");
  const plan = demoPlan(nodes.values(), adj, home, Number($("demo-length").value));
  say(`read-only gardener pass over ${plan.length} of ${nodes.size} pages: no LLM, nothing written`);
  say("skipped: the contradiction probe and the digest, which need a model");
  let read = 0, flags = 0;
  for (const slug of plan) {
    while ((busy || run.paused) && !run.stop) await sleep(50);
    if (run.stop) break;
    run.skip = false;
    const { glide, settle } = demoDelays(demoSpeed());
    const p = await focusOn(slug, { glide, settle });
    if (run.stop) break;
    if (!p) { say(`could not read ${slug}`, "flag"); continue; }
    read++;
    const lines = describePage(p, today);
    if (lines.some((l) => l.level === "flag")) { flagged.add(slug); flags++; draw(); }
    for (const l of lines) {
      if (run.stop || run.skip) break;
      say(l.text, l.level);
      const d = demoDelays(demoSpeed());
      await pace(run, l.level === "info" ? d.line : d.flag);
    }
    await pace(run, demoDelays(demoSpeed()).page);
  }
  say(run.stop ? `stopped after ${read} pages, ${flags} flagged` : `done: ${read} pages read, ${flags} flagged`, "ok");
  demo = null;
  $("demo").textContent = "Watch the gardener";
}

// ---------- input ----------

function toDisk(evt) {
  const svg = $("disk");
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return clampDisk([p.x, p.y], 0.98);
}

function wireDrag() {
  const svg = $("disk");
  // The pressed node is read at pointerdown: pointer capture retargets pointerup
  // to the svg itself.
  let p0 = null, start = null, moved = false, pressed = null;
  svg.addEventListener("pointerdown", (e) => {
    if (busy) return;
    p0 = toDisk(e); start = new Map(pos); moved = false;
    pressed = e.target && e.target.dataset ? e.target.dataset.slug : null;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!p0) return;
    const p1 = toDisk(e);
    if (!moved && norm([p1[0] - p0[0], p1[1] - p0[1]]) < 0.01) return;
    moved = true;
    svg.classList.add("dragging");
    for (const [s, z] of start) pos.set(s, clampDisk(drag(z, p0, p1), 0.9999));
    draw();
  });
  svg.addEventListener("pointerup", (e) => {
    svg.classList.remove("dragging");
    const wasDrag = moved;
    p0 = null;
    if (wasDrag) return;
    const slug = pressed;
    if (slug === UNLINKED) openUnlinked();
    else if (slug) focusOn(slug);
  });
}

function wireControls() {
  let typing = null;
  $("find").addEventListener("input", (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => applySearch(e.target.value), 150);
  });
  // Enter, or picking a title from the list, opens that page, or else the best
  // match (the root of the filtered view). A change fired by leaving the box
  // does nothing, so a click on the map is not overtaken by a jump.
  $("find").addEventListener("change", async (e) => {
    if (document.activeElement !== e.target) return;
    clearTimeout(typing);
    await applySearch(e.target.value);
    const target = resolve(parseQuery(e.target.value).text) || (filter ? root : null);
    if (target) focusOn(target);
  });
  $("find").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { clearTimeout(typing); e.target.value = ""; applySearch(""); }
  });
  $("home").addEventListener("click", () => home && focusOn(home, { open: false }));
  $("demo").addEventListener("click", runDemo);
  $("close").addEventListener("click", () => { $("panel").hidden = true; });
  $("forget").addEventListener("click", () => { localStorage.removeItem(TOKEN_KEY); location.reload(); });
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "Escape") { $("panel").hidden = true; if (demo) demo.stop = true; }
    if (demo && e.key === " ") {
      e.preventDefault();
      demo.paused = !demo.paused;
      demo.say(demo.paused ? "paused (Space resumes)" : "resumed", "ok");
    }
    if (demo && e.key === "ArrowRight") { e.preventDefault(); demo.skip = true; }
    if (e.key === "h" && home) focusOn(home, { open: false });
  });
  window.addEventListener("hashchange", () => {
    const s = decodeURIComponent(location.hash.slice(1));
    if (s && s !== selected) focusOn(s);
  });
}

function askToken(message) {
  const dlg = $("login");
  $("login-error").textContent = message || "";
  $("login-form").onsubmit = () => {
    token = $("token").value.trim();
    localStorage.setItem(TOKEN_KEY, token);
    start();
  };
  dlg.showModal();
}

async function start() {
  if (!token) return askToken();
  try { await load(); }
  catch (e) {
    if (e.auth) { localStorage.removeItem(TOKEN_KEY); token = null; return askToken(e.message); }
    $("status").textContent = `Could not load the graph: ${e.message}`;
    return;
  }
  const wanted = decodeURIComponent(location.hash.slice(1));
  const first = nodes.has(wanted) ? wanted : home;
  if (!first) { $("status").textContent = "No pages."; return; }
  pos = rebuild(first);
  selected = nodes.has(wanted) ? wanted : null;
  draw();
  if (selected) openPage(selected);
}

wireDrag();
wireControls();
wireDemoControls();
start();
