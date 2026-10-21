// OCR for scans, photos, and incomplete PDF text layers, via tesseract.js in a worker.
// Loaded from a CDN only when a page actually needs it.

import { isMarker } from './raster.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';
let workerPromise = null;
let importFailures = 0;
let progress = () => {};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 10;
const label = text => /^\d{1,3}[.):,]?$/.test(text);

// An integral or stacked fraction can make a Tesseract line several times taller
// than its exercise label. Font size and label baseline must come from the ink.
export function ocrWordRecords(data, scale = 1, offset = { x: 0, y: 0 }) {
  const words = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    const lh = (line.rowAttributes?.row_height || line.bbox.y1 - line.bbox.y0) / scale;
    for (const word of line.words || []) {
      const text = (word.text || '').trim(), b = word.bbox;
      if (!text || word.confidence < 12 || !b || b.y1 <= b.y0) continue;
      const h = b.y1 - b.y0, bl = line.baseline;
      let base = b.y1;
      if (!label(text) && bl && bl.x1 !== bl.x0) {
        const estimate = bl.y0 + (bl.y1 - bl.y0) * ((b.x0 + b.x1) / 2 - bl.x0) / (bl.x1 - bl.x0);
        if (estimate >= b.y0 + h * 0.5 && estimate <= b.y1 + h * 0.2) base = estimate;
      }
      words.push({ text, x0: b.x0 / scale + offset.x, x1: b.x1 / scale + offset.x,
        y0: b.y0 / scale + offset.y, y1: Math.max(b.y1, base) / scale + offset.y,
        base: base / scale + offset.y, size: Math.max(4, Math.min(lh * 0.78, h / scale / 0.72)),
        bold: false, italic: false, math: false, conf: word.confidence });
    }
  }
  const ordinary = words.filter(w => label(w.text) || /^[A-Za-z]{2,}$/.test(w.text));
  const body = median(ordinary.map(w => w.size));
  // Keep heading sizes, but don't treat a formula's total height as a font size.
  for (const w of words) if (w.size > body * 1.5 && /[^A-Za-z]/.test(w.text)) w.size = body;
  return words;
}

function hasTallMathRows(data) {
  let count = 0;
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    const h = line.rowAttributes?.row_height || line.bbox.y1 - line.bbox.y0;
    for (const word of line.words || []) if (label((word.text || '').trim()) && h > (word.bbox.y1 - word.bbox.y0) * 2) count++;
  }
  return count >= 3;
}

function numberColumns(passes, body) {
  const seeds = [];
  for (const words of passes) for (const word of words) {
    if (!label(word.text) || word.x1 - word.x0 > (word.text.replace(/\D/g, '').length * 0.9 + 0.25) * body) continue;
    // A number following nearby equation ink is not an independent column label.
    if (words.some(w => w !== word && w.x1 <= word.x0 && word.x0 - w.x1 < body * 0.9 &&
      Math.min(w.y1, word.y1) - Math.max(w.y0, word.y0) > 0.5 * Math.min(w.y1 - w.y0, word.y1 - word.y0))) continue;
    seeds.push(word);
  }
  const groups = [];
  for (const word of seeds.sort((a, b) => a.x0 - b.x0)) {
    let group = groups.find(g => Math.abs(median(g.map(w => w.x0)) - word.x0) < body * 0.85);
    if (!group) groups.push(group = []);
    group.push(word);
  }
  return groups.filter(group => {
    const rows = [];
    for (const w of group) if (!rows.some(y => Math.abs(y - (w.y0 + w.y1) / 2) < body * 0.65)) rows.push((w.y0 + w.y1) / 2);
    return rows.length >= 3 && new Set(group.map(w => parseInt(w.text, 10))).size >= 3 && Math.max(...rows) - Math.min(...rows) > 3 * body;
  }).sort((a, b) => b.length - a.length).slice(0, 12);
}

async function readRegion(w, page, scale, rect, mode) {
  const x0 = Math.max(0, Math.floor(rect.x0 * scale)), y0 = Math.max(0, Math.floor(rect.y0 * scale));
  const x1 = Math.min(page.width, Math.ceil(rect.x1 * scale)), y1 = Math.min(page.height, Math.ceil(rect.y1 * scale));
  const border = Math.ceil(3 * scale), c = document.createElement('canvas');
  c.width = x1 - x0 + border * 2; c.height = y1 - y0 + border * 2;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(page, x0, y0, x1 - x0, y1 - y0, border, border, x1 - x0, y1 - y0);
  await w.setParameters({ tessedit_pageseg_mode: String(mode), tessedit_char_whitelist: '0123456789.()' });
  const { data } = await w.recognize(c, {}, { blocks: true, text: false });
  return ocrWordRecords(data, scale, { x: (x0 - border) / scale, y: (y0 - border) / scale }).filter(v => label(v.text));
}

// Cross-check difficult mathematical pages with a sparse read and narrow number
// columns. Every proposed label is read from actual pixels; a sequence never
// supplies an unseen number. The original full-page words still own the content.
async function crossCheckMathLabels(w, c, scale, original) {
  await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  const { data } = await w.recognize(c, {}, { blocks: true, text: false });
  const sparse = ocrWordRecords(data, scale);
  const body = median([...original, ...sparse].filter(v => label(v.text) || /^[A-Za-z]{2,}$/.test(v.text)).map(v => v.size));
  const result = [...original];
  const pixels = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const hasFollowingInk = box => {
    const left = Math.max(0, Math.floor((box.x1 + body * 0.2) * scale));
    const right = Math.min(c.width, Math.ceil((box.x1 + body * 6) * scale));
    const top = Math.max(0, Math.floor((box.y0 - body) * scale));
    const bottom = Math.min(c.height, Math.ceil((box.y1 + body) * scale));
    const step = Math.max(1, Math.round(scale / 2));
    let ink = 0;
    for (let y = top; y < bottom; y += step) for (let x = left; x < right; x += step) {
      if (pixels.data[(y * pixels.width + x) * 4] < 130 && ++ink >= body) return true;
    }
    return false;
  };
  for (const column of numberColumns([original, sparse], body)) {
    const x0 = Math.min(...column.map(v => v.x0)) - body * 0.18;
    const x1 = Math.max(...column.map(v => v.x1)) + body * 0.18;
    const y0 = Math.max(0, Math.min(...column.map(v => v.y0)) - body * 6);
    const y1 = Math.min(c.height / scale, Math.max(...column.map(v => v.y1)) + body * 6);
    const strip = await readRegion(w, c, scale, { x0, x1, y0, y1 }, 6);
    const rows = [];
    for (const [pass, words] of [[0, original], [1, sparse], [2, strip]]) for (const word of words) {
      if (!label(word.text) || word.x0 < x0 - 1 || word.x1 > x1 + 1 || word.y0 < y0 || word.y1 > y1 || word.y1 - word.y0 > body * 1.8) continue;
      const cy = (word.y0 + word.y1) / 2;
      let row = rows.find(r => Math.abs(r.cy - cy) < body * 0.65);
      if (!row) rows.push(row = { cy, readings: [] });
      row.readings.push({ word, pass });
    }
    for (const row of rows) {
      const r = row.readings;
      const box = { x0: Math.min(...r.map(v => v.word.x0)), x1: Math.max(...r.map(v => v.word.x1)),
        y0: Math.min(...r.map(v => v.word.y0)), y1: Math.max(...r.map(v => v.word.y1)) };
      // Do not turn a slice through a word or heading into a new label.
      if (original.some(v => v.x0 < x0 - body * 0.3 && v.x1 > x1 && v.y0 < box.y1 && v.y1 > box.y0)) continue;
      if (original.some(v => /^[A-Za-z]{2}/.test(v.text) && v.x0 >= x0 - body * 0.3 && v.x0 < x1 &&
        v.x1 > x1 + body * 0.3 && v.y0 < box.y1 && v.y1 > box.y0)) continue;
      if (!hasFollowingInk(box)) continue;
      const values = new Set(r.map(v => parseInt(v.word.text, 10)));
      if (values.size > 1 || !r.some(v => v.pass < 2) || Math.max(...r.map(v => v.word.conf)) < 75) {
        const rect = { x0: box.x0 - body * 0.2, x1: box.x1 + body * 0.2, y0: box.y0 - body * 0.25, y1: box.y1 + body * 0.25 };
        const local = await readRegion(w, c, scale, rect, 7);
        for (const word of local) r.push({ word, pass: 3 });
        if (!local.length) for (const word of await readRegion(w, c, scale, rect, 13)) r.push({ word, pass: 4 });
      }
      const votes = new Map();
      for (const { word, pass } of r) {
        const n = parseInt(word.text, 10);
        if (!votes.has(n)) votes.set(n, { n, score: 0, passes: new Set(), word });
        const vote = votes.get(n);
        if (vote.passes.has(pass)) continue;
        vote.passes.add(pass); vote.score += word.conf * (pass >= 2 ? 2 : 1);
        if (word.conf > vote.word.conf || pass === 2) vote.word = word;
      }
      const best = [...votes.values()].sort((a, b) => b.score - a.score)[0];
      if (!best || best.passes.size < 2) continue;
      const punctuated = r.find(v => parseInt(v.word.text, 10) === best.n && /^\d{1,3}[.)]$/.test(v.word.text));
      const chosen = { ...best.word, text: punctuated?.word.text || String(best.n), size: body, base: best.word.y1, ocrLabel: true };
      for (let i = result.length - 1; i >= 0; i--) {
        const v = result[i];
        if (v.x0 >= x0 - 1 && v.x1 <= x1 + 1 && Math.abs((v.y0 + v.y1) / 2 - row.cy) < body * 0.65) result.splice(i, 1);
      }
      result.push(chosen);
    }
  }
  return result;
}

async function worker() {
  workerPromise ||= (async () => {
    // Browsers cache a rejected module import for the rest of the tab's life.
    // Only after an import failure, use a new URL so a restored connection can retry.
    const url = importFailures ? `${TESSERACT}?retry=${importFailures}` : TESSERACT;
    let mod;
    try { mod = await import(url); }
    catch (error) { importFailures++; throw error; }
    const T = mod.default || mod;
    const w = await T.createWorker('eng', 1, {
      logger: m => { if (m.status === 'recognizing text') progress(m.progress); },
    });
    await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
    return w;
  })().catch(error => { workerPromise = null; throw new Error(`Could not load the text reader (${error.message}). Check the connection and try again.`); });
  return workerPromise;
}

/**
 * @param canvas rendered page
 * @param scale  pixels per page unit
 * @returns words in page units, same shape as textlayer.js
 */
export async function ocrWords(canvas, scale, onProgress = () => {}) {
  progress = onProgress;
  const w = await worker();
  // Tesseract reads best at ~300 dpi, in gray, without highlighter behind the text.
  const k = Math.min(3, Math.max(1, (300 / 72) / scale));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = isMarker(d[i], d[i + 1], d[i + 2]) ? 255 : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  scale *= k;
  await w.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  const { data } = await w.recognize(c, {}, { blocks: true, text: false });
  const words = ocrWordRecords(data, scale);
  if (!hasTallMathRows(data)) return words;
  try { return await crossCheckMathLabels(w, c, scale, words); }
  catch { return words; } // An optional second pass must not discard a successful first read.
}
