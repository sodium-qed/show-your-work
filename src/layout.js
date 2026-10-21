// Exam layout: groups of problems → positioned items on pages. Pure (no DOM).
// Units are PDF points, origin top-left.

export const PAPER = { letter: [612, 792], a4: [595.28, 841.89] };
const GUTTER = 18;
const DIR_SIZE = 10;
const DIR_GAP = 7;
const GROUP_GAP = 16;
const LINE_H = 20;
const MIN_SPACE = { none: 4, small: 30, medium: 60, large: 120, fill: 24 };
const WEIGHT = { blank: 1, parts: 0.55, polar: 0.3, xy: 0.3, line: 0.12 };

/** Which work aid a set of directions calls for. */
export function aidFor(text = '') {
  const t = text.toLowerCase();
  const parts = [...new Set([...t.matchAll(/\(([a-f])\)/g)].map(m => m[1]))];
  const plot = /\b(plot|graph|sketch|draw)\b/.test(t) && !/\bgraph of\b.*\bfind\b/.test(t);
  let kind = 'blank';
  if (/\bmatch\b/.test(t)) kind = 'line';
  else if (plot && /polar/.test(t) && !/rectangular coordinates of/.test(t)) kind = 'polar';
  else if (plot) kind = 'xy';
  return { kind, parts: parts.length >= 2 ? parts : [] };
}

/** Largest |r| (or coordinate) in a problem's text, to size its grid. */
export function gridExtent(text = '') {
  const nums = [...String(text).replace(/[−–]/g, '-').matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Math.abs(parseFloat(m[0])));
  const first = nums[0];
  return Number.isFinite(first) && first <= 12 ? first : 3;
}

function wrap(text, width, size, measure) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, size) > width) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param groups [{ directions: {text}|{image:{w,h,ref}}|null, figure: {w,h,ref}|null,
 *                  aid: {kind, parts}, problems: [{ id, w, h, ref, extent }] }]
 * @param settings { paper, margin, pages (target sides or 0=auto), columns (0=auto),
 *                   space ('none'|'small'|'medium'|'large'|'fill'), directions (bool), size (0=auto|scale) }
 * @param measure (text, size) => width in points (italic serif)
 */
export function layoutExam(groups, settings = {}, measure = (t, s) => t.length * s * 0.45) {
  const [W, H] = PAPER[settings.paper] || PAPER.letter;
  const margin = settings.margin ?? 36;
  const contentW = W - 2 * margin;
  const capacity = H - 2 * margin;
  const space = settings.space || 'fill';
  const target = Math.max(0, settings.pages | 0);
  const scales = settings.size ? [settings.size] : [1.25, 1.15, 1.05, 1, 0.9, 0.82, 0.75];
  let best = null;
  for (const scale of scales) {
    const blocks = buildBlocks(groups, { ...settings, contentW, capacity, scale, space }, measure);
    const pages = paginate(blocks, capacity, MIN_SPACE[space] ?? 24);
    best = { blocks, pages, scale };
    if (!target || pages.length <= target) break;
  }
  const { blocks, scale } = best;
  let pages = best.pages;
  // Spread over the requested number of sides when there is room to spare.
  if (target && pages.length < target && space === 'fill' && blocks.length >= target) {
    pages = spread(blocks, capacity, MIN_SPACE.fill, target);
  }
  const out = pages.map(page => placePage(page, { margin, capacity, contentW, space }));
  const warnings = [];
  if (target && out.length > target) warnings.push(`Needs ${out.length} pages even at the smallest size. Remove a few problems or choose ${out.length} pages.`);
  return { width: W, height: H, pages: out, scale, warnings };
}

function buildBlocks(groups, s, measure) {
  const blocks = [];
  for (const [gi, g] of groups.entries()) {
    if (!g.problems.length) continue;
    const aid = g.aid || { kind: 'blank', parts: [] };
    const fig = g.figure ? fitBox(g.figure, s.contentW * 0.42, s.capacity * 0.45, s.scale) : null;
    const availW = s.contentW - (fig ? fig.w + GUTTER : 0);
    const probs = g.problems.map(p => ({ ...p, ...fitBox(p, s.contentW, s.capacity * 0.8, s.scale) }));
    const maxW = Math.max(...probs.map(p => p.w));
    const lineExtra = aid.kind === 'line' ? 70 : 0;
    let cols = s.columns || Math.max(1, Math.min(3, Math.floor((availW + GUTTER) / (maxW + lineExtra + GUTTER))));
    if (!s.columns && (aid.kind === 'polar' || aid.kind === 'xy')) cols = Math.min(cols, 3);
    if (!s.columns && aid.parts.length) cols = Math.min(cols, 3);
    cols = Math.max(1, Math.min(cols, probs.length > 0 ? 3 : 1));
    const colW = (availW - (cols - 1) * GUTTER) / cols;
    // Squeeze any problem wider than its column.
    for (const p of probs) if (p.w > colW) { const k = colW / p.w; p.w *= k; p.h *= k; if (p.baseline != null) p.baseline *= k; }
    const gridD = Math.min(colW * 0.86, 165 * Math.min(1.1, s.scale));
    const aidH = (aid.kind === 'polar' || aid.kind === 'xy' ? gridD + 10 : 0) + aid.parts.length * LINE_H + (aid.kind === 'line' && maxW + lineExtra > colW ? LINE_H : 0);
    const rows = [];
    for (let i = 0; i < probs.length; i += cols) {
      const cells = probs.slice(i, i + cols);
      // Line up the problem numbers on one baseline.
      const base = Math.max(0, ...cells.map(c => c.baseline ?? 0));
      for (const c of cells) c.dy = c.baseline != null ? base - c.baseline : 0;
      rows.push({ cells, contentH: Math.max(...cells.map(c => c.dy + c.h)), aidH, extra: 0, weight: WEIGHT[aid.kind] ?? 1 });
    }
    let dir = null;
    if (s.directions !== false && g.directions) {
      if (g.directions.text) {
        const lines = wrap(g.directions.text, s.contentW, DIR_SIZE, measure);
        dir = { kind: 'text', lines, h: lines.length * DIR_SIZE * 1.25 };
      } else if (g.directions.image) {
        const b = fitBox(g.directions.image, s.contentW, 120, Math.min(s.scale, 1.1));
        dir = { kind: 'image', ref: g.directions.image.ref, w: b.w, h: b.h };
      }
    }
    const meta = { gi, aid, cols, colW, gridD, fig, availW };
    if (fig) {
      // A figure floats to the right of the group's first rows; keep it all together.
      blocks.push({ kind: 'group', meta, dir, rows, fixed: (dir ? dir.h + DIR_GAP : 0), minH: (dir ? dir.h + DIR_GAP : 0) + Math.max(fig.h, rows.reduce((a, r) => a + r.contentH + r.aidH, 0)), gap: blocks.length ? GROUP_GAP : 0 });
    } else {
      rows.forEach((r, i) => blocks.push({ kind: 'row', meta, dir: i === 0 ? dir : null, rows: [r], fixed: i === 0 && dir ? dir.h + DIR_GAP : 0, minH: (i === 0 && dir ? dir.h + DIR_GAP : 0) + r.contentH + r.aidH, gap: i === 0 && blocks.length ? GROUP_GAP : 4 }));
    }
  }
  return blocks;
}

function fitBox(b, maxW, maxH, scale) {
  let w = b.w * scale, h = b.h * scale;
  const k = Math.min(1, maxW / w, maxH / h);
  return { ...b, w: w * k, h: h * k, baseline: b.baseline != null ? b.baseline * scale * k : null };
}

const rowsOf = block => block.rows;
const need = (block, minSpace) => block.gap + block.minH + rowsOf(block).length * minSpace;

function paginate(blocks, capacity, minSpace) {
  const pages = [];
  let page = null, used = 0;
  for (const b of blocks) {
    const h = need(b, minSpace);
    if (!page || used + h > capacity + 0.01) { page = []; pages.push(page); used = 0; }
    page.push(b); used += page.length === 1 ? h - b.gap : h;
  }
  return pages;
}

/** Split blocks over exactly `target` pages, balancing the free room. */
function spread(blocks, capacity, minSpace, target) {
  const heights = blocks.map(b => need(b, minSpace));
  // Prefer breaking at group starts: choose breakpoints minimizing the most crowded page.
  const n = blocks.length;
  let bestPages = null, bestScore = Infinity;
  const pageH = (i, j) => heights.slice(i, j).reduce((a, h, k) => a + (k === 0 ? h - blocks[i + k].gap : h), 0);
  const search = (start, left, acc) => {
    if (left === 1) {
      const h = pageH(start, n);
      if (h > capacity) return;
      const pages = [...acc, [start, n]];
      const loads = pages.map(([i, j]) => pageH(i, j) / capacity);
      const breaksMidGroup = pages.slice(1).filter(([i]) => blocks[i].kind === 'row' && !blocks[i].dir).length;
      const score = Math.max(...loads) - Math.min(...loads) + breaksMidGroup * 0.08;
      if (score < bestScore) { bestScore = score; bestPages = pages; }
      return;
    }
    for (let end = start + 1; end <= n - left + 1; end++) {
      if (pageH(start, end) > capacity) break;
      search(end, left - 1, [...acc, [start, end]]);
    }
  };
  if (n <= 60) search(0, target, []);
  if (!bestPages) return paginate(blocks, capacity, minSpace);
  return bestPages.map(([i, j]) => blocks.slice(i, j));
}

function placePage(blocks, { margin, capacity, space }) {
  const minSpace = MIN_SPACE[space] ?? 24;
  const used = blocks.reduce((a, b, i) => a + need(b, minSpace) - (i === 0 ? b.gap : 0), 0);
  const allRows = blocks.flatMap(rowsOf);
  const totalWeight = allRows.reduce((a, r) => a + r.weight, 0) || 1;
  const leftover = space === 'fill' || space === 'large' ? Math.max(0, capacity - used) : 0;
  for (const r of allRows) r.extra = minSpace + leftover * r.weight / totalWeight;
  const items = [];
  let y = margin;
  for (const [bi, b] of blocks.entries()) {
    if (bi > 0) y += b.gap;
    const { meta } = b;
    const x0 = margin;
    if (b.dir) {
      if (b.dir.kind === 'text') {
        b.dir.lines.forEach((line, i) => items.push({ type: 'text', text: line, x: x0, y: y + (i + 0.8) * DIR_SIZE * 1.25, size: DIR_SIZE, italic: true }));
      } else items.push({ type: 'image', ref: b.dir.ref, x: x0, y, w: b.dir.w, h: b.dir.h });
      y += b.dir.h + DIR_GAP;
    }
    const top = y;
    if (meta.fig) items.push({ type: 'image', ref: meta.fig.ref, x: x0 + meta.availW + GUTTER, y: top, w: meta.fig.w, h: meta.fig.h });
    for (const r of b.rows) {
      r.cells.forEach((c, ci) => {
        const cx = x0 + ci * (meta.colW + GUTTER);
        items.push({ type: 'image', ref: c.ref, id: c.id, x: cx, y: y + (c.dy || 0), w: c.w, h: c.h });
        let ay = y + r.contentH + 4;
        if (meta.aid.kind === 'line') {
          if (c.w + 70 <= meta.colW) { const ly = y + (c.dy || 0) + (c.baseline ?? c.h * 0.72); items.push({ type: 'line', x1: cx + c.w + 10, x2: Math.min(cx + meta.colW, cx + c.w + 80), y1: ly, y2: ly }); }
          else { items.push({ type: 'line', x1: cx + 16, x2: cx + Math.min(meta.colW, 110), y1: ay + 12, y2: ay + 12 }); }
        }
        if (meta.aid.kind === 'polar' || meta.aid.kind === 'xy') {
          const d = meta.gridD;
          items.push({ type: meta.aid.kind, x: cx + (meta.colW - d) / 2, y: ay + 4, size: d, extent: c.extent ?? 3 });
          ay += d + 10;
        }
        meta.aid.parts.forEach((p, pi) => {
          const ly = ay + (pi + 1) * LINE_H - 4;
          items.push({ type: 'text', text: `(${p})`, x: cx, y: ly, size: DIR_SIZE, italic: false });
          items.push({ type: 'line', x1: cx + 18, x2: cx + Math.min(meta.colW, 150), y1: ly + 1, y2: ly + 1 });
        });
      });
      y += r.contentH + r.aidH + r.extra;
    }
    if (meta.fig) y = Math.max(y, top + meta.fig.h + minSpace);
  }
  return { items };
}
