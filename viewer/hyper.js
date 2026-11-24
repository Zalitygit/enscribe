// Poincaré-disk geometry for the page viewer. Points are [x, y] with
// x^2 + y^2 < 1. Pure functions only, so they can be unit-tested in Node.

const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const conj = (a) => [a[0], -a[1]];
export const norm = (a) => Math.hypot(a[0], a[1]);

// The disk isometry that moves `a` to the origin: (z - a) / (1 - conj(a) z).
export function toCenter(z, a) {
  const num = [z[0] - a[0], z[1] - a[1]];
  const ca = mul(conj(a), z);
  return div(num, [1 - ca[0], -ca[1]]);
}

// Its inverse, moving the origin to `a`: (z + a) / (1 + conj(a) z).
export function fromCenter(z, a) {
  const num = [z[0] + a[0], z[1] + a[1]];
  const ca = mul(conj(a), z);
  return div(num, [1 + ca[0], ca[1]]);
}

// The isometry that carries p0 to p1 (a drag), applied to z.
export function drag(z, p0, p1) {
  return fromCenter(toCenter(z, p0), p1);
}

// The point a fraction t along the geodesic from the origin to `a`, so that an
// animated recentre moves at constant hyperbolic speed.
export function along(a, t) {
  const r = norm(a);
  if (r === 0) return [0, 0];
  const s = Math.tanh(t * Math.atanh(Math.min(r, 0.999999))) / r;
  return [a[0] * s, a[1] * s];
}

// Clamp a point just inside the rim, where the maths stays finite.
export function clampDisk(z, max = 0.995) {
  const r = norm(z);
  return r <= max ? z : [z[0] * max / r, z[1] * max / r];
}

// Breadth-first spanning tree of an undirected graph from `root`. Neighbours
// are visited by descending degree, then slug, so the layout is deterministic.
// Nodes the root cannot reach hang off a synthetic UNLINKED child of the root,
// so orphans stay visible as one cluster.
export const UNLINKED = "\u0000unlinked";
export function spanningTree(adj, root) {
  const deg = (s) => (adj.get(s) ? adj.get(s).size : 0);
  const order = (xs) => [...xs].sort((a, b) => deg(b) - deg(a) || (a < b ? -1 : a > b ? 1 : 0));
  const children = new Map([[root, []]]);
  const parent = new Map([[root, null]]);
  const queue = [root];
  while (queue.length) {
    const s = queue.shift();
    for (const n of order(adj.get(s) || [])) {
      if (parent.has(n)) continue;
      parent.set(n, s);
      children.get(s).push(n);
      children.set(n, []);
      queue.push(n);
    }
  }
  const rest = order([...adj.keys()].filter((s) => !parent.has(s)));
  if (rest.length) {
    parent.set(UNLINKED, root);
    children.get(root).push(UNLINKED);
    children.set(UNLINKED, rest);
    for (const s of rest) { parent.set(s, UNLINKED); children.set(s, []); }
  }
  return { parent, children };
}

// A radial tree in the hyperbolic plane: depth d sits at hyperbolic radius
// d * step (disk radius tanh(d * step / 2)), and each subtree gets an angular
// slice of its parent's in proportion to the square root of its size. Plain
// size starved leaves: a hub's many one-page children shared a sliver while a
// few big subtrees took the rest. Hyperbolic circumference grows
// exponentially with radius, which is what keeps siblings apart.
export function layout(tree, root, step = 1.4) {
  const size = new Map();
  const count = (s) => {
    let n = 1;
    for (const c of tree.children.get(s)) n += count(c);
    size.set(s, Math.sqrt(n));
    return n;
  };
  count(root);
  const pos = new Map([[root, [0, 0]]]);
  const place = (s, depth, from, width) => {
    const kids = tree.children.get(s);
    const total = kids.reduce((n, c) => n + size.get(c), 0);
    let at = from;
    for (const c of kids) {
      const w = width * size.get(c) / total;
      const theta = at + w / 2;
      const r = Math.tanh(((depth + 1) * step) / 2);
      pos.set(c, [r * Math.cos(theta), r * Math.sin(theta)]);
      place(c, depth + 1, at, w);
      at += w;
    }
  };
  place(root, 0, -Math.PI / 2, 2 * Math.PI);
  return pos;
}

// A search box query split into its text (sent to the server as is), its
// flags, and its terms. A `/` as the very last character, as in bin/, asks for
// whole-word matches only; with anything after it, even a space, it is text.
// A term is a whitespace-separated run or a "quoted" one, read as its words
// (runs of letters and digits, lowercased); a term of two or more words, like
// needs-human or "git push", is a phrase.
export function parseQuery(query) {
  const word = query.endsWith("/");
  const text = (word ? query.slice(0, -1) : query).split(/\s+/).filter(Boolean).join(" ");
  const terms = [...text.matchAll(/"([^"]*)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2]).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((ws) => ws.length);
  return { text, word, terms };
}

// A term as a pattern: its words in order with only non-word characters
// between them. For whole words the run must start and end on a word boundary;
// without it, it may sit inside a word (the title match has always been a
// substring match).
const SEP = "[^\\p{L}\\p{N}]+", START = "(?<![\\p{L}\\p{N}])", END = "(?![\\p{L}\\p{N}])";
const termSource = (words) => words.join(SEP);

// The pages a search box query picks out: every term must occur,
// case-insensitively, in the title, slug or type; with a final /, as whole words.
// Each field is tested on its own, so a phrase cannot run from the end of a
// title into the slug. A query with no terms picks nothing and returns null,
// meaning "no filter".
export function matchPages(pages, query) {
  const { word, terms } = parseQuery(query);
  if (!terms.length) return null;
  const res = terms.map((ws) => new RegExp(`${word ? START : ""}${termSource(ws)}${word ? END : ""}`, "u"));
  const out = new Set();
  for (const p of pages) {
    const fields = [p.title, p.slug, p.type || ""].map((f) => f.toLowerCase());
    if (res.every((re) => fields.some((f) => re.test(f)))) out.add(p.slug);
  }
  return out;
}

// The graph restricted to `keep`: those pages and only the links among them.
export function subgraph(adj, keep) {
  const out = new Map();
  for (const s of keep) {
    if (!adj.has(s)) continue;
    out.set(s, new Set([...adj.get(s)].filter((n) => keep.has(n))));
  }
  return out;
}

// `text` cut into runs, `hit` on each match of a term of `query`, so the page
// panel can mark them: starting on a word boundary and running to the end of
// the last word (the word-prefix rule the server's text search uses), or with
// whole words ending exactly on a word boundary. A phrase is marked as one run. Words
// are letters and digits only, so none is regex syntax.
export function markSpans(text, query) {
  const { word, terms } = parseQuery(query);
  if (!terms.length) return [{ text, hit: false }];
  const alts = terms.map(termSource).sort((a, b) => b.length - a.length);
  const tail = word ? END : "[\\p{L}\\p{N}]*";
  const re = new RegExp(`${START}(?:${alts.join("|")})${tail}`, "giu");
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length || !out.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

// Inline markdown as tokens: `code`, **bold**, *italic* or _italic_ and
// ~~strikethrough~~ (each parsed again inside, so a wikilink in bold stays a
// link), [[wikilinks]] and http(s) links. Anything else is literal text.
// Italic and strikethrough markers may not touch a space on the inside, so
// `2 * 3 * 4` stays text, and an underscore inside a word is not one, so
// snake_case stays text. The page panel turns these into DOM nodes.
const INLINE = new RegExp([
  /(`[^`]+`)/.source,
  /(\*\*[^*]+\*\*)/.source,
  /(\[\[[^\]]+\]\])/.source,
  /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/.source,
  /(?<!\*)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/.source,
  /(?<![\p{L}\p{N}_])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}_])/.source,
  /~~([^~\s](?:(?:[^~]|~(?!~))*?[^~\s])?)~~/.source,
].join("|"), "gu");
export function inlineTokens(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    if (m[1]) out.push({ t: "code", v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: "strong", kids: inlineTokens(m[2].slice(2, -2)) });
    else if (m[3]) out.push({ t: "wikilink", raw: m[3].slice(2, -2) });
    else if (m[4]) out.push({ t: "link", label: m[5], href: m[6] });
    else if (m[9] !== undefined) out.push({ t: "del", kids: inlineTokens(m[9]) });
    else out.push({ t: "em", kids: inlineTokens(m[7] ?? m[8]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

// A pipe table starting at lines[i]: a header row, then a separator row of
// dashes (colons set alignment), then body rows until a blank line or a line
// with no pipe. Null if lines[i] does not start one. A pipe stays inside its
// cell when escaped (\|, unescaped here) or inside [[...]] or `...`, since
// the vault writes wikilink labels in tables both ways. Rows are padded or
// cut to the header's width.
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
export function tableAt(lines, i) {
  if (!lines[i] || !lines[i].includes("|") || !SEPARATOR.test(lines[i + 1] || "")) return null;
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
  const rows = [];
  let end = i + 2;
  for (; end < lines.length && lines[end].trim() !== "" && lines[end].includes("|"); end++) {
    const cells = splitRow(lines[end]).slice(0, head.length);
    while (cells.length < head.length) cells.push("");
    rows.push(cells);
  }
  return { align, head, rows, end };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cell = "", code = false, link = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") { cell += "|"; k++; continue; }
    if (c === "`") code = !code;
    else if (!code && s.startsWith("[[", k)) { link++; cell += "[["; k++; continue; }
    else if (!code && link && s.startsWith("]]", k)) { link--; cell += "]]"; k++; continue; }
    else if (c === "|" && !code && !link) { cells.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

// A blockquote starting at lines[i]: the run of lines that begin with ">",
// with the marker and one following space taken off, so the panel can render
// `inner` as markdown again. Null if lines[i] does not start one. An Obsidian
// callout header (`> [!type] Title`) becomes `callout` and `title` (the type
// when there is no title) instead of a line of the body.
export function quoteAt(lines, i) {
  const QUOTE = /^\s*> ?/;
  if (!QUOTE.test(lines[i] || "")) return null;
  let end = i;
  const inner = [];
  for (; end < lines.length && QUOTE.test(lines[end]); end++) inner.push(lines[end].replace(QUOTE, ""));
  const head = /^\[!(\w[\w-]*)\][+-]?\s*(.*)$/.exec(inner[0]);
  if (!head) return { callout: null, title: null, inner, end };
  return { callout: head[1].toLowerCase(), title: head[2] || head[1], inner: inner.slice(1), end };
}

// A bullet or numbered list starting at lines[i], as a tree: each item has
// its text and the list nested under it (or null). An item indented deeper
// than the one before it starts a list under that one (a tab counts as four
// spaces); one indented less closes lists until its level, and one landing
// between levels joins the list under the item above. A list is numbered,
// with its first number as `start`, if its first item is. The lines a wrapped
// item continues on (indented or not) are joined to it. A task item
// (`[ ] ` or `[x] `) also carries `task`, true when checked. The list ends at a
// blank line or a line that starts another block (heading, fence, quote,
// table, rule). Null if lines[i] is not an item; `* * *` is a rule, not one.
const ITEM = /^([ \t]*)(?:[-*+]|(\d+)\.)\s+(.*)$/;
export function listAt(lines, i) {
  const first = ITEM.exec(lines[i] || "");
  if (!first || isRule(lines[i])) return null;
  const width = (s) => s.replace(/\t/g, "    ").length;
  const open = (m) => ({ ordered: m[2] !== undefined, start: m[2] !== undefined ? Number(m[2]) : 1, items: [] });
  const root = open(first);
  const stack = [{ indent: width(first[1]), list: root }];
  let last = null;
  let end = i;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (isRule(line)) break;
    const m = ITEM.exec(line);
    if (m) {
      const indent = width(m[1]);
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (indent > top.indent && top.list.items.length) {
        const parent = top.list.items[top.list.items.length - 1];
        parent.list = parent.list || open(m);
        stack.push({ indent, list: parent.list });
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      last = task ? { text: task[2], list: null, task: task[1] !== " " } : { text: m[3], list: null };
      stack[stack.length - 1].list.items.push(last);
      continue;
    }
    if (line.trim() === "" || /^\s*(#{1,6}\s|```|>)/.test(line) || tableAt(lines, end)) break;
    last.text += ` ${line.trim()}`;
  }
  return { ...root, end };
}

// A horizontal rule: three or more of one of -, * or _, optionally spaced,
// indented at most three spaces. A `---` right under paragraph text is a
// setext heading instead (see setextLevel); the panel checks that first.
export function isRule(line) {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

// The heading level a setext underline gives the paragraph above it: 1 for a
// run of =, 2 for a run of -, else 0. Only a line directly under paragraph
// text is one; the panel decides that, and reads a lone --- as a rule.
export function setextLevel(line) {
  return /^ {0,3}=+[ \t]*$/.test(line) ? 1 : /^ {0,3}-+[ \t]*$/.test(line) ? 2 : 0;
}
