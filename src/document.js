// Load PDFs and images, render pages, read text (text layer or OCR), find problems.
import { pageWords } from './textlayer.js';
import { analyzePage, anchorForMark, cleanDirections } from './analyze.js';
import { findMarks, findFigures, fitToInk, eraseMarks, toPrintGray } from './raster.js';
import { aidFor, gridExtent } from './layout.js';
import { canEncode } from './render-pdf.js';
import { ocrWords } from './ocr.js';

const PDFJS = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const PDF_SCALE = 3;            // 216 dpi renders: crisp crops, fine OCR
const IMAGE_UNITS = 612;        // an image page is treated as 8.5 in wide
const MAX_IMAGE_SIDE = 2600;

let pdfjsPromise;
async function pdfjs() {
  pdfjsPromise ||= import(PDFJS).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

let seq = 0;
const id = prefix => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

export async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) || (bytes[0] === 0x25 && bytes[1] === 0x50);
  if (isPdf) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({
      data: bytes, isEvalSupported: false,
      cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    }).promise;
    return { id: id('s'), name: file.name, kind: 'pdf', doc, pageCount: doc.numPages, pages: [] };
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { id: id('s'), name: file.name, kind: 'image', bitmap, pageCount: 1, pages: [] };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

async function renderPage(source, index) {
  if (source.kind === 'pdf') {
    const page = await source.doc.getPage(index + 1);
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.min(PDF_SCALE, 3400 / Math.max(vp.width, vp.height));
    const c = canvas(vp.width * scale, vp.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }) }).promise;
    return { page, canvas: c, width: vp.width, height: vp.height, scale };
  }
  const b = source.bitmap;
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(b.width, b.height));
  const c = canvas(b.width * k, b.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(b, 0, 0, c.width, c.height);
  const scale = c.width / IMAGE_UNITS;
  return { page: null, canvas: c, width: IMAGE_UNITS, height: c.height / scale, scale };
}

const median = v => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function analyzeWords(words, r, img, ocr) {
  const bodySize = median(words.filter(w => w.text.length > 1).map(w => w.size)) || 10;
  // A new reader needs new text masks: stale figures can cover the recovered labels.
  const figures = findFigures(img, r.scale, words, bodySize);
  return analyzePage({ words, width: r.width, height: r.height, figures, ocr });
}

/**
 * Prepare one page: render, read words, analyze. Cached on the source.
 * @returns page model { index, width, height, scale, canvas, ocr, problems[], marks[], directions[] }
 */
export async function preparePage(source, index, onStatus = () => {}, { forceOcr = false } = {}) {
  const previous = source.pages[index];
  if (previous && !forceOcr) return previous;
  if (!previous) onStatus('Rendering page…');
  const r = previous || await renderPage(source, index);
  const img = previous?.img || r.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.canvas.width, r.canvas.height);
  let words = previous?.words || [];
  if (!previous && r.page) {
    try { words = await pageWords(r.page); }
    catch { /* A damaged text layer can still be read from the rendered page below. */ }
  }
  let ocr = previous?.ocr || false;
  let analysis = previous?.analysis || analyzeWords(words, r, img, ocr);
  let ocrAttempted = previous?.ocrAttempted || false;
  let readWarning = '', readNotice = '';
  const sparse = words.filter(w => /[a-z]{2}/i.test(w.text)).length < 12;
  // Readable prose does not guarantee that a PDF exposes its exercise-number glyphs.
  if (forceOcr || sparse || !analysis.anchors.length) {
    ocrAttempted = true;
    onStatus('Reading the page visually (OCR)…');
    try {
      const visualWords = await ocrWords(r.canvas, r.scale, p => onStatus(`Reading the page visually (OCR) ${Math.round(p * 100)}%`));
      const visual = analyzeWords(visualWords, r, img, true);
      const found = new Set(visual.anchors.map(a => a.number));
      const preserves = analysis.anchors.every(a => found.has(a.number));
      const improves = preserves && visual.anchors.length > analysis.anchors.length;
      const readsSparseText = !analysis.anchors.length && sparse && visualWords.length > words.length;
      if (improves || readsSparseText) {
        words = visualWords; analysis = visual; ocr = true;
        readNotice = analysis.anchors.length ? `Visual reading found ${analysis.anchors.length} numbered problems.` : 'No numbered problems detected after visual reading. Draw a box to select a problem.';
      } else {
        readNotice = analysis.anchors.length ? 'Visual reading found no safe improvement. Existing problem boxes were kept.' : 'No numbered problems detected after visual reading. Draw a box to select a problem.';
      }
    } catch (error) {
      // Keep the rendered page and continue the PDF, even if the OCR download fails.
      readWarning = `Visual reading failed: ${error.message || 'the text reader is unavailable.'} Use Read page visually to retry, or Draw to select a problem.`;
    }
  }
  if (previous && analysis === previous.analysis) {
    Object.assign(previous, { ocrAttempted, readWarning, readNotice });
    return previous;
  }
  onStatus('Finding problems…');
  const marks = findMarks(img, r.scale, analysis.bodySize);
  for (const m of marks) m.anchor = anchorForMark(m, analysis.anchors, analysis.bodySize)?.number ?? null;

  const model = { source, index, width: r.width, height: r.height, scale: r.scale, canvas: r.canvas, img, ocr, ocrAttempted, readWarning, readNotice, words, analysis, marks, problems: [], directions: [] };
  const bs = analysis.bodySize;
  analysis.directions.forEach((d, di) => {
    const key = `${source.id}:${index}:d${di}`;
    const text = cleanDirections(d.text);
    const printable = !d.math && canEncode(text) && (!ocr || d.conf >= 80) && text.length > 8;
    const rect = fitToInk(img, r.scale, d, { x0: d.x0 - 0.5 * bs, y0: d.y0 - 0.4 * bs, x1: d.x1 + 0.5 * bs, y1: d.y1 + 0.3 * bs });
    const figRect = (d.figures || []).reduce((u, f) => u ? { x0: Math.min(u.x0, f.x0), y0: Math.min(u.y0, f.y0), x1: Math.max(u.x1, f.x1), y1: Math.max(u.y1, f.y1) } : { ...f }, null);
    model.directions.push({ key, raw: d.text, text, label: printable ? text : cleanDirections(d.label || d.text), printable, rect, cut: prefixCut(d), range: d.range, aid: aidFor(d.text), figure: figRect && pad(figRect, 3) });
  });
  for (const a of analysis.anchors) {
    // Don't reach up into the problem above, or into figures that belong to someone else.
    const above = analysis.anchors.filter(b => b !== a && b.box.y1 <= a.y0 + 1 && b.x0 < a.right && b.right > a.x0);
    const ceiling = Math.max(-Infinity, ...above.map(b => b.box.y1 + 0.6));
    const limit = { x0: a.x0 - 0.9 * bs, y0: Math.max(ceiling, Math.min(a.y0, a.box.y0) - 1.3 * bs), x1: a.right, y1: a.limit };
    const others = analysis.figures.filter(f => !(a.figures || []).includes(f));
    let rect = fitToInk(img, r.scale, a.box, limit, others);
    // A problem's own figure is kept, but only the text and figure pixels are copied, so a
    // neighbouring problem that shares the figure's rows doesn't come along.
    const parts = a.figures?.length ? [pad(rect, 2.5), ...a.figures.map(f => pad(f, 2))] : null;
    for (const f of a.figures || []) rect = { x0: Math.min(rect.x0, f.x0), y0: Math.min(rect.y0, f.y0), x1: Math.max(rect.x1, f.x1), y1: Math.max(rect.y1, f.y1) };
    const di = analysis.directions.indexOf(a.directions);
    model.problems.push({
      id: `${source.id}:${index}:${a.number}`, number: a.number, page: index, sourceId: source.id,
      rect: pad(rect, 2.5), parts, baseline: a.base - (rect.y0 - 2.5), text: a.words.filter(w => !w.math && w !== a.word).map(w => w.text).join(' '),
      group: di >= 0 ? `${source.id}:${index}:d${di}` : `${source.id}:${index}:none`, detected: true,
    });
  }
  model.problems.sort((p, q) => p.number - q.number);
  for (const p of model.problems) p.extent = gridExtent(p.text);
  source.pages[index] = model;
  return model;
}

const pad = (r, d) => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/** Where "In Problems 11–18," ends on the first line, so a cropped image can skip it. */
function prefixCut(d) {
  const words = d.segs[0].words;
  let text = '';
  for (let i = 0; i < words.length - 1; i++) {
    text += (i ? ' ' : '') + words[i].text;
    if (/[:,]$/.test(text) && cleanDirections(text) === '') {
      return { x: words[i + 1].x0 - 0.5, y1: Math.max(...words.map(w => w.y1)) + 1 };
    }
  }
  return null;
}

/** Crop a page region to a PNG, removing highlighter color. */
export async function cropImage(model, rect, { eraseHighlights = true, parts = null } = {}) {
  const s = model.scale;
  const x0 = Math.max(0, Math.floor(rect.x0 * s)), y0 = Math.max(0, Math.floor(rect.y0 * s));
  const x1 = Math.min(model.canvas.width, Math.ceil(rect.x1 * s)), y1 = Math.min(model.canvas.height, Math.ceil(rect.y1 * s));
  const c = canvas(x1 - x0, y1 - y0);
  const ctx = c.getContext('2d');
  // Work on a copy of the region only.
  const region = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    const src = ((y0 + y) * model.img.width + x0) * 4;
    region.data.set(model.img.data.subarray(src, src + c.width * 4), y * c.width * 4);
  }
  if (parts) {
    // Blank everything outside the listed parts.
    const inPart = (x, y) => parts.some(p => x >= p.x0 * s && x < p.x1 * s && y >= p.y0 * s && y < p.y1 * s);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (inPart(x0 + x, y0 + y)) continue;
      const i = (y * c.width + x) * 4; region.data[i] = region.data[i + 1] = region.data[i + 2] = 255;
    }
  }
  if (eraseHighlights) {
    const hits = model.marks.filter(m => m.x1 > rect.x0 && m.x0 < rect.x1 && m.y1 > rect.y0 && m.y0 < rect.y1);
    eraseMarks(region, s, hits, { x: x0 / s, y: y0 / s });
  }
  toPrintGray(region);
  ctx.putImageData(region, 0, 0);
  return { canvas: c, w: (x1 - x0) / s, h: (y1 - y0) / s };
}

/** Directions as an image, without the "In Problems 11–18," prefix when it can be located. */
export async function directionsImage(model, dir) {
  const r = dir.rect;
  if (!dir.cut) return cropImage(model, r);
  const first = await cropImage(model, { x0: dir.cut.x, y0: r.y0, x1: r.x1, y1: Math.min(r.y1, dir.cut.y1) });
  if (dir.cut.y1 >= r.y1 - 2) return first;
  const rest = await cropImage(model, { x0: r.x0, y0: dir.cut.y1, x1: r.x1, y1: r.y1 });
  const c = canvas(Math.max(first.canvas.width, rest.canvas.width), first.canvas.height + rest.canvas.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(first.canvas, 0, 0); ctx.drawImage(rest.canvas, 0, first.canvas.height);
  return { canvas: c, w: c.width / model.scale, h: c.height / model.scale };
}

export async function pngBytes(c) {
  const blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Out of image memory.')), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A manual selection: trim to ink, adopt the number of any problem inside it. */
export function manualProblem(model, rect, n) {
  const trimmed = fitToInk(model.img, model.scale, rect, rect);
  const inside = model.problems.find(p => p.rect.x0 >= rect.x0 - 6 && p.rect.x1 <= rect.x1 + 6 && p.rect.y0 >= rect.y0 - 6 && p.rect.y1 <= rect.y1 + 6);
  const anchor = model.analysis.anchors.find(a => a.x0 >= rect.x0 && a.x1 <= rect.x1 && a.y0 >= rect.y0 && a.y1 <= rect.y1);
  const number = inside?.number ?? anchor?.number ?? null;
  const group = inside?.group ?? (anchor && model.analysis.directions.indexOf(anchor.directions) >= 0 ? `${model.source.id}:${model.index}:d${model.analysis.directions.indexOf(anchor.directions)}` : `${model.source.id}:${model.index}:manual`);
  return { id: `${model.source.id}:${model.index}:m${n}`, number, label: number ?? `#${n}`, page: model.index, sourceId: model.source.id, rect: pad(trimmed, 2), text: '', group, extent: 3, manual: true };
}
