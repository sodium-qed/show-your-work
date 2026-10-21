// Pixel analysis on ImageData-like objects ({ data, width, height }).
// `scale` is pixels per page unit (point). No DOM needed, so it is unit-testable.

export const HUES = [
  ['red', 0, 14], ['orange', 14, 42], ['yellow', 42, 68], ['green', 68, 165],
  ['blue', 165, 255], ['purple', 255, 290], ['pink', 290, 345], ['red', 345, 361],
];
export const hueName = h => (HUES.find(([, lo, hi]) => h >= lo && h < hi) || HUES[0])[0];

function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

/** Ink = dark or strongly colored mid-tone pixels. Light highlighter colors are not ink. */
export function isInk(r, g, b) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  if (l < 150) return true;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max > 0 && (max - min) / max > 0.5 && max < 205 && l < 185;
}

/** Highlighter-like: light and clearly colored. */
export function isMarker(r, g, b) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  if (l < 145) return false; // highlighters are light; colored print (red numbers, cyan arrows) is not
  const [, s, v] = hsv(r, g, b);
  return s >= 0.16 && v >= 0.6;
}

/** Block-reduce a predicate over the image into a coarse grid (cell = `step` pixels). */
function grid(img, step, predicate, minShare = 0) {
  const gw = Math.ceil(img.width / step), gh = Math.ceil(img.height / step);
  const out = new Uint8Array(gw * gh);
  const counts = minShare ? new Uint16Array(gw * gh) : null;
  const { data, width, height } = img;
  for (let y = 0; y < height; y++) {
    const gy = (y / step) | 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (predicate(data[i], data[i + 1], data[i + 2])) {
        const k = gy * gw + ((x / step) | 0);
        if (counts) counts[k]++; else out[k] = 1;
      }
    }
  }
  if (counts) {
    const need = Math.max(1, minShare * step * step);
    for (let k = 0; k < out.length; k++) out[k] = counts[k] >= need ? 1 : 0;
  }
  return { mask: out, gw, gh };
}

function dilate(mask, gw, gh, r) {
  if (r <= 0) return mask;
  // Separable max filter.
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < gh; y++) {
    let run = -1e9;
    for (let x = 0; x < gw; x++) { if (mask[y * gw + x]) run = x; if (x - run <= r) tmp[y * gw + x] = 1; }
    run = 1e9;
    for (let x = gw - 1; x >= 0; x--) { if (mask[y * gw + x]) run = x; if (run - x <= r) tmp[y * gw + x] = 1; }
  }
  for (let x = 0; x < gw; x++) {
    let run = -1e9;
    for (let y = 0; y < gh; y++) { if (tmp[y * gw + x]) run = y; if (y - run <= r) out[y * gw + x] = 1; }
    run = 1e9;
    for (let y = gh - 1; y >= 0; y--) { if (tmp[y * gw + x]) run = y; if (run - y <= r) out[y * gw + x] = 1; }
  }
  return out;
}

function erode(mask, gw, gh, r) {
  const inv = mask.map(v => 1 - v);
  return dilate(inv, gw, gh, r).map(v => 1 - v);
}

function components(mask, gw, gh) {
  const label = new Int32Array(mask.length).fill(-1);
  const comps = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const c = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, cells: [] };
    label[start] = comps.length; stack.push(start);
    while (stack.length) {
      const k = stack.pop();
      const x = k % gw, y = (k / gw) | 0;
      c.area++; c.cells.push(k);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const n of [k - 1, k + 1, k - gw, k + gw]) {
        if (n < 0 || n >= mask.length || label[n] >= 0 || !mask[n]) continue;
        if ((n === k - 1 && x === 0) || (n === k + 1 && x === gw - 1)) continue;
        label[n] = comps.length; stack.push(n);
      }
    }
    comps.push(c);
  }
  return { comps, label };
}

/**
 * Colored highlight marks (highlighter strokes, circles, boxes).
 * Returns [{ x0, y0, x1, y1 (page units), color, rgb, area }].
 */
export function findMarks(img, scale, bodySize = 10) {
  const step = Math.max(1, Math.round(scale)); // ~1 page unit per cell
  const unit = step / scale;
  const { mask, gw, gh } = grid(img, step, isMarker, 0.3);
  // Close (fill text holes inside a highlight), then open (drop thin colored text and rules).
  const closeR = Math.max(1, Math.round(1.5 / unit));
  const openR = Math.max(1, Math.round(1.6 / unit));
  let m = erode(dilate(mask, gw, gh, closeR), gw, gh, closeR);
  m = dilate(erode(m, gw, gh, openR), gw, gh, openR);
  const { comps } = components(m, gw, gh);
  const marks = [];
  const pageArea = gw * gh;
  for (const c of comps) {
    const w = (c.x1 - c.x0 + 1) * unit, h = (c.y1 - c.y0 + 1) * unit;
    if (Math.min(w, h) < 0.5 * bodySize || c.area * unit * unit < 0.6 * bodySize * bodySize) continue;
    if (c.area > 0.2 * pageArea) continue;
    // Mostly highlighter pixels before closing; colored text closes into a blob but is sparse.
    let raw = 0;
    for (const k of c.cells) raw += mask[k];
    if (raw / c.area < 0.55) continue;
    // Dominant color, measured on marker pixels inside the component.
    const hist = new Float64Array(36);
    let sr = 0, sg = 0, sb = 0, n = 0;
    const { data, width } = img;
    for (const k of c.cells) {
      const gx = k % gw, gy = (k / gw) | 0;
      for (let y = gy * step; y < Math.min(img.height, gy * step + step); y++) {
        for (let x = gx * step; x < Math.min(width, gx * step + step); x++) {
          const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
          if (!isMarker(r, g, b)) continue;
          hist[Math.floor(hsv(r, g, b)[0] / 10) % 36]++;
          sr += r; sg += g; sb += b; n++;
        }
      }
    }
    if (!n) continue;
    let peak = 0;
    for (let i = 1; i < 36; i++) if (hist[i] > hist[peak]) peak = i;
    const near = hist[peak] + hist[(peak + 1) % 36] + hist[(peak + 35) % 36] + hist[(peak + 2) % 36] + hist[(peak + 34) % 36];
    const uniformity = near / n;
    // Photos and illustrations are multi-colored; highlighters are one color.
    if (uniformity < 0.75) continue;
    if (c.area * unit * unit > 40 * bodySize * bodySize && uniformity < 0.9) continue;
    // Name the color by the dominant hue (a neighbouring pencil icon must not tint it).
    let pr = 0, pg = 0, pb = 0, pn = 0;
    for (const k of c.cells) {
      const gx = k % gw, gy = (k / gw) | 0;
      for (let y = gy * step; y < Math.min(img.height, gy * step + step); y++) {
        for (let x = gx * step; x < Math.min(width, gx * step + step); x++) {
          const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
          if (!isMarker(r, g, b)) continue;
          const bin = Math.floor(hsv(r, g, b)[0] / 10) % 36;
          if (Math.min((bin - peak + 36) % 36, (peak - bin + 36) % 36) > 2) continue;
          pr += r; pg += g; pb += b; pn++;
        }
      }
    }
    const rgb = [pr / pn, pg / pn, pb / pn].map(Math.round);
    const hue = hsv(...rgb)[0];
    marks.push({ x0: c.x0 * unit, y0: c.y0 * unit, x1: (c.x1 + 1) * unit, y1: (c.y1 + 1) * unit, color: hueName(hue), hue, rgb, area: c.area * unit * unit });
  }
  return marks;
}

/**
 * Figures: ink that is not covered by any text word, grouped into blocks
 * big enough to be a graph or diagram.
 */
export function findFigures(img, scale, words, bodySize = 10) {
  const step = Math.max(1, Math.round(scale));
  const unit = step / scale;
  const { mask, gw, gh } = grid(img, step, isInk);
  const pad = 0.6 / unit;
  for (const w of words) {
    const x0 = Math.max(0, Math.floor(w.x0 / unit - pad)), x1 = Math.min(gw - 1, Math.ceil(w.x1 / unit + pad));
    const y0 = Math.max(0, Math.floor(w.y0 / unit - pad)), y1 = Math.min(gh - 1, Math.ceil(w.y1 / unit + pad));
    for (let y = y0; y <= y1; y++) mask.fill(0, y * gw + x0, y * gw + x1 + 1);
  }
  const r = Math.max(1, Math.round(0.35 * bodySize / unit));
  const { comps } = components(dilate(mask, gw, gh, r), gw, gh);
  const min = 2.6 * bodySize;
  return comps
    .map(c => ({ x0: (c.x0 + r) * unit, y0: (c.y0 + r) * unit, x1: (c.x1 + 1 - r) * unit, y1: (c.y1 + 1 - r) * unit }))
    .filter(f => (f.x1 - f.x0 >= min && f.y1 - f.y0 >= min) || ((f.x1 - f.x0) * (f.y1 - f.y0) >= 12 * min * min / 4 && Math.min(f.x1 - f.x0, f.y1 - f.y0) > bodySize));
}

/**
 * Grow `rect` to include ink touching it, without leaving `limit`; then trim to ink.
 * Rects are page units.
 */
export function fitToInk(img, scale, rect, limit, skip = []) {
  const L = {
    x0: Math.max(0, Math.floor(limit.x0 * scale)), y0: Math.max(0, Math.floor(limit.y0 * scale)),
    x1: Math.min(img.width, Math.ceil(limit.x1 * scale)), y1: Math.min(img.height, Math.ceil(limit.y1 * scale)),
  };
  const step = Math.max(1, Math.round(scale / 2)); // ~0.5 unit cells
  const gw = Math.max(1, Math.ceil((L.x1 - L.x0) / step)), gh = Math.max(1, Math.ceil((L.y1 - L.y0) / step));
  const mask = new Uint8Array(gw * gh);
  const { data, width } = img;
  const skipPx = skip.map(s => ({ x0: s.x0 * scale, y0: s.y0 * scale, x1: s.x1 * scale, y1: s.y1 * scale }));
  for (let y = L.y0; y < L.y1; y++) {
    for (let x = L.x0; x < L.x1; x++) {
      const i = (y * width + x) * 4;
      if (!isInk(data[i], data[i + 1], data[i + 2])) continue;
      if (skipPx.length && skipPx.some(s => x >= s.x0 && x < s.x1 && y >= s.y0 && y < s.y1)) continue;
      mask[((y - L.y0) / step | 0) * gw + ((x - L.x0) / step | 0)] = 1;
    }
  }
  // Join glyph pieces so a fraction bar or radical touching the text comes along.
  const joined = dilate(mask, gw, gh, 1);
  const { comps } = components(joined, gw, gh);
  const toCell = v => ({ x0: (v.x0 * scale - L.x0) / step, y0: (v.y0 * scale - L.y0) / step, x1: (v.x1 * scale - L.x0) / step, y1: (v.y1 * scale - L.y0) / step });
  const R = toCell(rect);
  // Take ink touching the text box, plus ink on the same lines (text the reader missed),
  // repeating so pieces touching what was just added come along too.
  let box = null;
  const taken = new Set();
  for (let pass = 0; pass < 3; pass++) {
    const ref = box ? { x0: Math.min(R.x0, box.x0), y0: Math.min(R.y0, box.y0), x1: Math.max(R.x1, box.x1), y1: Math.max(R.y1, box.y1) } : R;
    let grew = false;
    for (const [i, c] of comps.entries()) {
      if (taken.has(i)) continue;
      // Pieces cut off by the cell edge belong to the neighbouring line, not this one.
      if ((c.y1 >= gh - 1 && c.y0 >= R.y1 - 1) || (c.y0 <= 0 && c.y1 <= R.y0 + 1)) continue;
      const touches = !(c.x1 < ref.x0 - 1 || c.x0 > ref.x1 + 1 || c.y1 < ref.y0 - 1 || c.y0 > ref.y1 + 1);
      // Only rightward: icons and marks in the margin left of a number stay out.
      const sameLine = c.x0 >= R.x0 - 1 && Math.min(c.y1, R.y1) - Math.max(c.y0, R.y0) >= 0.5 * (c.y1 - c.y0 + 1);
      if (!touches && !sameLine) continue;
      taken.add(i); grew = true;
      box = box ? { x0: Math.min(box.x0, c.x0), y0: Math.min(box.y0, c.y0), x1: Math.max(box.x1, c.x1), y1: Math.max(box.y1, c.y1) } : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
    }
    if (!grew) break;
  }
  if (!box) return rect;
  const back = v => ({ x0: (L.x0 + v.x0 * step) / scale, y0: (L.y0 + v.y0 * step) / scale, x1: (L.x0 + (v.x1 + 1) * step) / scale, y1: (L.y0 + (v.y1 + 1) * step) / scale });
  return back(box);
}

/**
 * Remove highlighter color inside mark rects (in place): luminance is rescaled so
 * the highlighter itself becomes white while text printed on it stays dark.
 */
export function eraseMarks(img, scale, marks, origin = { x: 0, y: 0 }) {
  const { data, width, height } = img;
  for (const m of marks) {
    const [mr, mg, mb] = m.rgb || [255, 255, 160];
    const lm = Math.max(120, 0.299 * mr + 0.587 * mg + 0.114 * mb - 6);
    const x0 = Math.max(0, Math.floor((m.x0 - origin.x) * scale) - 3), x1 = Math.min(width, Math.ceil((m.x1 - origin.x) * scale) + 3);
    const y0 = Math.max(0, Math.floor((m.y0 - origin.y) * scale) - 3), y1 = Math.min(height, Math.ceil((m.y1 - origin.y) * scale) + 3);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max - min < 12) continue; // already neutral: leave black text and white paper alone
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        // Colored print sitting on the highlighter (an orange problem number): keep it as ink.
        const [h, sat] = hsv(r, g, b);
        const dh = Math.min(Math.abs(h - (m.hue ?? h)), 360 - Math.abs(h - (m.hue ?? h)));
        if (sat > 0.45 && dh > 30 && l < lm - 25) { data[i] = data[i + 1] = data[i + 2] = Math.max(0, l * 0.35 - 10); continue; }
        const v = Math.min(255, Math.round(255 * Math.pow(l / lm, 1.4)));
        data[i] = data[i + 1] = data[i + 2] = v;
      }
    }
  }
  return img;
}

/**
 * Print-friendly grayscale (in place): colored print (orange problem numbers, blue
 * headings, cyan arrows) becomes dark gray so it reads like the black text around it.
 */
export function toPrintGray(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let l = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = max ? (max - min) / max : 0;
    if (sat > 0.3 && l < 225) l = Math.max(0, l * (1 - sat * 0.85) - 10);
    data[i] = data[i + 1] = data[i + 2] = l;
  }
  return img;
}
