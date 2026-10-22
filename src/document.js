// Load PDFs and images, render pages, read text (text layer or OCR), find problems.
import { pageWords } from './textlayer.js';
import { analyzePage, anchorsForMark, cleanDirections } from './analyze.js';
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
      wasmUrl: new URL('../vendor/pdfjs/wasm/', import.meta.url).href,
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

/** PDF image draws use the current transform's unit square, regardless of pixel size. */
export function pdfImagePlacements(operators, viewport, OPS) {
  const multiply = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const bounds = (matrix, [x0, y0, x1, y1]) => {
    const points = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => [
      matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5],
    ]);
    return { x0: Math.min(...points.map(p => p[0])), y0: Math.min(...points.map(p => p[1])),
      x1: Math.max(...points.map(p => p[0])), y1: Math.max(...points.map(p => p[1])) };
  };
  const intersect = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  let state = { matrix: viewport.transform, clip: { x0: 0, y0: 0, x1: viewport.width, y1: viewport.height }, mask: false };
  const stack = [], images = [];
  let annotation = 0;
  const save = () => { stack.push(state); state = { ...state }; };
  const restore = () => { if (stack.length) state = stack.pop(); };
  const record = (matrix = state.matrix) => {
    if (state.mask) return;
    const rect = intersect(bounds(matrix, [0, 0, 1, 1]), state.clip);
    if (Object.values(rect).every(Number.isFinite) && rect.x1 > rect.x0 && rect.y1 > rect.y0) images.push(rect);
  };
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i] || [];
    // Annotation appearances and soft-mask images are not source illustrations.
    if (op === OPS.beginAnnotation) { annotation++; continue; }
    if (op === OPS.endAnnotation) { annotation = Math.max(0, annotation - 1); continue; }
    if (annotation) continue;
    if (op === OPS.save) save();
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd || op === OPS.endGroup) restore();
    else if (op === OPS.transform) state.matrix = multiply(state.matrix, args);
    else if (op === OPS.paintFormXObjectBegin) {
      save();
      if (args[0]) state.matrix = multiply(state.matrix, args[0]);
      if (args[1]) state.clip = intersect(state.clip, bounds(state.matrix, args[1]));
    } else if (op === OPS.beginGroup) {
      save();
      const group = args[0];
      // PDF.js applies the group's matrix to its clip; the content keeps the
      // previous transform and applies its own form matrix separately.
      if (group.bbox) state.clip = intersect(state.clip, bounds(group.matrix ? multiply(state.matrix, group.matrix) : state.matrix, group.bbox));
      state.mask ||= !!group.smask;
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) record();
    else if (op === OPS.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args;
      for (let j = 0; j < positions.length; j += 2) record(multiply(state.matrix, [sx, 0, 0, sy, positions[j], positions[j + 1]]));
    } else if (op === OPS.paintInlineImageXObjectGroup) {
      for (const entry of args[1]) record(multiply(state.matrix, entry.transform));
    }
  }
  return images;
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
    let imageBounds = [];
    try { imageBounds = pdfImagePlacements(await page.getOperatorList(), vp, (await pdfjs()).OPS); }
    catch { /* Raster figure detection still works if a damaged operator list cannot be read. */ }
    return { page, canvas: c, width: vp.width, height: vp.height, scale, imageBounds };
  }
  const b = source.bitmap;
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(b.width, b.height));
  const c = canvas(b.width * k, b.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(b, 0, 0, c.width, c.height);
  const scale = c.width / IMAGE_UNITS;
  return { page: null, canvas: c, width: IMAGE_UNITS, height: c.height / scale, scale, imageBounds: [] };
}

const median = v => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = w => Math.max(1, (w.x1 - w.x0) * (w.y1 - w.y0));
const nearLabel = (a, b, bs) => Math.abs(a.x0 - b.x0) < 0.9 * bs && Math.abs(a.base - b.base) < 0.9 * bs;
const soundLabel = (a, bs) => Number.isFinite(a.x0 + a.x1 + a.y0 + a.y1) && a.x1 > a.x0 &&
  a.x1 - a.x0 <= Math.max(3 * bs, String(a.number).length * bs) && a.y1 - a.y0 <= 2.3 * bs;

/** Native image bounds preserve pale artwork, but must never mask a scanned page or label. */
export function imageFigureBounds(images, words, bodySize, width, height) {
  return images.filter(f => {
    const w = f.x1 - f.x0, h = f.y1 - f.y0;
    if (Math.min(w, h) < 2.6 * bodySize || w * h >= 0.5 * width * height || (w >= 0.8 * width && h >= 0.65 * height)) return false;
    if (Math.max(w, h) / Math.min(w, h) > 6 && Math.min(w, h) < 5 * bodySize) return false;
    // Embedded scans of exercises remain text to the readers, not illustrations.
    const inside = words.filter(word => (word.x0 + word.x1) / 2 >= f.x0 && (word.x0 + word.x1) / 2 <= f.x1 &&
      (word.y0 + word.y1) / 2 >= f.y0 && (word.y0 + word.y1) / 2 <= f.y1);
    if (inside.some(word => /^[1-9]\d{0,2}[.)](?:$|\s|[A-Z])/.test(word.text))) return false;
    const base = word => word.base ?? word.y1;
    const prose = inside.filter(word => /[a-z]{3}/i.test(word.text));
    const rows = [];
    for (const word of prose) if (!rows.some(y => Math.abs(y - base(word)) < 0.8 * bodySize)) rows.push(base(word));
    if (prose.length >= 16 && rows.length >= 3) return false;
    const bare = inside.filter(word => /^[1-9]\d{0,2}$/.test(word.text) && (word.ocrLabel || prose.some(p =>
      p.x0 >= word.x1 && p.x0 - word.x1 < 6 * bodySize && Math.abs(base(p) - base(word)) < 0.8 * bodySize
    )));
    return !bare.some(a => bare.some(b => b !== a && Math.abs(a.x0 - b.x0) < bodySize &&
      Math.abs(base(a) - base(b)) > 1.2 * bodySize && (Number(a.text) - Number(b.text)) * (base(a) - base(b)) > 0));
  }).filter((f, i, all) => !all.some((other, j) => j < i && overlap(f, other) >= 0.98 * Math.max(area(f), area(other))));
}

/** Only local gaps inside an observed, explicitly named range justify an automatic reread. */
export function needsVisualCheck(words, analysis) {
  if (!words.length || !analysis.anchors.length) return true;
  if (analysis.anchors.some(a => !soundLabel(a, analysis.bodySize))) return true;
  return analysis.directions.some(d => {
    if (!d.range || d.range.to - d.range.from > 400) return false;
    const observed = analysis.anchors.filter(a => a.number >= d.range.from && a.number <= d.range.to && a.base > d.y1).map(a => a.number);
    if (observed.length < 2) return false;
    const low = Math.min(...observed), high = Math.max(...observed), have = new Set(observed);
    for (let n = low + 1; n < high; n++) if (!have.has(n)) return true;
    return false;
  });
}

/**
 * Supplement positioned native text with independently read visual labels/text.
 * A bigger OCR anchor count alone is not evidence that any label is correct.
 */
export function mergeVisualWords(words, analysis, visualWords, visual) {
  const bs = analysis.bodySize || visual.bodySize || 10;
  const plain = w => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const covered = (w, known) => known.some(n => overlap(w, n) >= 0.25 * Math.min(area(w), area(n)));
  const sparse = !analysis.anchors.length && words.filter(w => /[a-z]{2}/i.test(w.text)).length < 12;
  if (sparse) {
    // Scans may still expose a native header. Preserve those words and their
    // exact geometry while filling the otherwise unreadable page from OCR.
    return { words: [...words, ...visualWords.filter(w => !covered(w, words))], labels: [], conflicts: 0, fullVisual: true };
  }
  const reliable = analysis.anchors.filter(a => soundLabel(a, bs));
  const additions = [], replaced = new Set(), labels = [];
  let conflicts = 0;
  for (const a of visual.anchors) {
    if (!soundLabel(a, bs) || (a.word.conf ?? 100) < 35) continue;
    const old = reliable.find(b => nearLabel(a, b, bs));
    if (old && old.number !== a.number) { conflicts++; continue; }
    const agrees = old?.number === a.number;
    const named = analysis.directions.filter(d => d.range && d.y1 <= a.y0 && d.x0 <= a.x0 + bs &&
      !analysis.headings.some(h => h.y0 > d.y1 && h.y1 < a.y0 && h.x0 <= a.x0 + bs)
    ).sort((p, q) => q.y1 - p.y1)[0];
    if (!agrees && named && (a.number < named.range.from || a.number > named.range.to)) continue;
    const nearby = a.words.filter(w => w !== a.word && w.base <= a.base + 3 * bs);
    const matched = nearby.some(w => plain(w).length >= 3 && /\p{L}/u.test(w.text) && words.some(n =>
      plain(n) === plain(w) && Math.abs(n.x0 - w.x0) < bs && Math.abs(n.base - w.base) < 0.8 * bs
    ));
    const nativeStart = words.some(w => w.x0 >= a.x1 - 0.3 * bs && w.x0 - a.x1 <= 4 * bs && Math.abs(w.base - a.base) < 0.8 * bs);
    const aligned = reliable.some(b => b.number !== a.number && (
      (Math.abs(b.x0 - a.x0) < 0.7 * bs && Math.abs(b.base - a.base) > 1.2 * bs && (b.number - a.number) * (b.base - a.base) > 0) ||
      (Math.abs(b.base - a.base) < 0.8 * bs && Math.abs(b.x0 - a.x0) > 8 * bs && (b.number - a.number) * (b.x0 - a.x0) > 0)
    ));
    if (!agrees && !(matched && nativeStart) && !((a.word.conf ?? 100) >= 65 && aligned)) continue;
    if (!agrees) {
      const malformed = analysis.anchors.find(b => b.number === a.number && !soundLabel(b, bs) && nearLabel(a, b, bs));
      if (covered(a.word, words.filter(w => w !== malformed?.word))) continue;
      if (malformed) replaced.add(malformed.word);
      additions.push({ ...a.word, ocrLabel: true, ocrSupplement: true, corroboratedLabel: true });
      labels.push(a);
    }
    // Fill only a corroborated exercise's missing image text. Native words win
    // every overlap, and supplemental body text cannot introduce extra labels.
    for (const w of a.words) {
      if (w === a.word || (w.conf ?? 100) < 35 || visual.anchors.some(b => b.word === w)) continue;
      if (!covered(w, words) && !covered(w, additions)) additions.push({ ...w, ocrSupplement: true });
    }
  }
  return { words: [...words.filter(w => !replaced.has(w)), ...additions], labels, conflicts, fullVisual: false };
}

function analyzeWords(words, r, img, ocr) {
  const bodySize = median(words.filter(w => w.text.length > 1).map(w => w.size)) || 10;
  // A new reader needs new text masks: stale figures can cover the recovered labels.
  const images = imageFigureBounds(r.imageBounds || [], words, bodySize, r.width, r.height).map(f => ({ ...f, pdfImage: true }));
  const raster = findFigures(img, r.scale, words, bodySize);
  const figures = [...raster.filter(f => !images.some(image => overlap(f, image) >= 0.65 * area(f))), ...images];
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
  let nativeWords = previous?.nativeWords || [];
  if (!previous && r.page) {
    try { nativeWords = await pageWords(r.page); }
    catch { /* A damaged text layer can still be read from the rendered page below. */ }
  }
  let words = previous?.words || nativeWords;
  let ocr = previous?.ocr || false;
  const nativeAnalysis = previous?.nativeAnalysis || analyzeWords(nativeWords, r, img, false);
  let analysis = previous?.analysis || nativeAnalysis;
  let ocrAttempted = previous?.ocrAttempted || false;
  let readWarning = '', readNotice = '';
  // Readable prose does not guarantee that a PDF exposes its exercise-number glyphs.
  if (forceOcr || needsVisualCheck(words, analysis)) {
    ocrAttempted = true;
    onStatus('Reading the page visually (OCR)…');
    try {
      const visualWords = await ocrWords(r.canvas, r.scale, p => onStatus(`Reading the page visually (OCR) ${Math.round(p * 100)}%`));
      const visual = analyzeWords(visualWords, r, img, true);
      // A reread starts from native evidence, never from cached OCR as though it
      // were PDF text. This lets a fresh scan read correct earlier OCR mistakes.
      const merged = mergeVisualWords(nativeWords, nativeAnalysis, visualWords, visual);
      const candidate = analyzeWords(merged.words, r, img, true);
      const preserves = nativeAnalysis.anchors.filter(a => soundLabel(a, nativeAnalysis.bodySize)).every(a => candidate.anchors.some(b =>
        b.number === a.number && (nearLabel(a, b, nativeAnalysis.bodySize) || (a.review && !b.review))
      ));
      const verified = merged.labels.filter(a => candidate.anchors.some(b => b.number === a.number && nearLabel(a, b, nativeAnalysis.bodySize)));
      const usableScan = !previous || !merged.fullVisual || !analysis.anchors.length || candidate.anchors.some(a =>
        soundLabel(a, candidate.bodySize) && (a.word.conf ?? 0) >= 50
      );
      if (preserves && usableScan && (merged.fullVisual || merged.words.length !== nativeWords.length || verified.length)) {
        words = merged.words; analysis = candidate; ocr = true;
        readNotice = merged.fullVisual ? (analysis.anchors.length ? `Visual reading found ${analysis.anchors.length} numbered problems.` : 'No numbered problems detected after visual reading. Draw a box to select a problem.') :
          verified.length ? `Cross-check verified ${verified.length} visual problem label${verified.length === 1 ? '' : 's'} while keeping the PDF text.` :
          'Visual reading filled in missing text while keeping the existing problem labels.';
      } else {
        readNotice = analysis.anchors.length ? 'No additional problem labels could be verified. Use Draw for a missing problem.' : 'No numbered problems detected after visual reading. Draw a box to select a problem.';
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
  const marks = findMarks(img, r.scale, analysis.bodySize, { figures: analysis.figures, words, anchors: analysis.anchors });
  for (const m of marks) {
    m.anchors = anchorsForMark(m, analysis.anchors, analysis.bodySize).map(a => a.number);
    m.anchor = m.anchors[0] ?? null;
  }

  const model = { source, index, width: r.width, height: r.height, scale: r.scale, canvas: r.canvas, imageBounds: r.imageBounds, img, ocr, ocrAttempted, readWarning, readNotice, nativeWords, nativeAnalysis, words, analysis, marks, problems: [], directions: [] };
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
    const limit = { x0: a.x0 - 0.9 * bs, y0: Math.max(a.top ?? 0, ceiling, Math.min(a.y0, a.box.y0) - 1.3 * bs), x1: a.right, y1: a.limit };
    const others = analysis.figures.filter(f => !(a.figures || []).includes(f));
    let rect = clamp(pad(fitToInk(img, r.scale, a.box, limit, others), 2.5), limit);
    // A problem's own figure is kept, but only the text and figure pixels are copied, so a
    // neighbouring problem that shares the figure's rows doesn't come along.
    const parts = a.figures?.length ? [rect, ...a.figures.map(f => pad(f, 2))] : null;
    for (const f of parts?.slice(1) || []) rect = { x0: Math.min(rect.x0, f.x0), y0: Math.min(rect.y0, f.y0), x1: Math.max(rect.x1, f.x1), y1: Math.max(rect.y1, f.y1) };
    const di = analysis.directions.indexOf(a.directions);
    model.problems.push({
      id: `${source.id}:${index}:${a.number}`, number: a.number, page: index, sourceId: source.id,
      review: !!a.review,
      rect, parts, baseline: a.base - rect.y0, text: a.words.filter(w => !w.math && w !== a.word).map(w => w.text).join(' '),
      graphText: a.words.filter(w => w !== a.word).map(w => w.text).join(' '),
      group: di >= 0 ? `${source.id}:${index}:d${di}` : `${source.id}:${index}:none`, detected: true,
    });
  }
  model.problems.sort((p, q) => p.number - q.number);
  for (const p of model.problems) p.extent = gridExtent(p.graphText || p.text, model.directions.find(d => d.key === p.group)?.aid.kind || 'xy');
  source.pages[index] = model;
  return model;
}

const pad = (r, d) => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const clamp = (r, limit) => ({ x0: Math.max(r.x0, limit.x0), y0: Math.max(r.y0, limit.y0), x1: Math.min(r.x1, limit.x1), y1: Math.min(r.y1, limit.y1) });

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
  return { id: `${model.source.id}:${model.index}:m${n}`, number, label: number ?? `#${n}`, page: model.index, sourceId: model.source.id, review: !!(inside?.review ?? anchor?.review), rect: pad(trimmed, 2), text: '', group, extent: 3, manual: true };
}
