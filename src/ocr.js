// OCR for scans and photos (pages with no text layer), via tesseract.js in a worker.
// Loaded from a CDN only when a page actually needs it.

import { isMarker } from './raster.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';
let workerPromise = null;
let progress = () => {};

async function worker() {
  workerPromise ||= (async () => {
    const mod = await import(TESSERACT);
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
  const { data } = await w.recognize(c, {}, { blocks: true, text: false });
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const lh = (line.rowAttributes?.row_height || (line.bbox.y1 - line.bbox.y0)) / scale;
        const size = Math.max(4, lh * 0.78);
        const bl = line.baseline;
        for (const word of line.words || []) {
          const text = (word.text || '').trim();
          if (!text || word.confidence < 12) continue;
          const b = word.bbox;
          const cx = (b.x0 + b.x1) / 2;
          let base = b.y1;
          if (bl && bl.x1 !== bl.x0) base = bl.y0 + (bl.y1 - bl.y0) * (cx - bl.x0) / (bl.x1 - bl.x0);
          words.push({
            text, x0: b.x0 / scale, x1: b.x1 / scale, y0: b.y0 / scale, y1: Math.max(b.y1, base) / scale,
            base: base / scale, size, bold: false, italic: false, math: false, conf: word.confidence,
          });
        }
      }
    }
  }
  return words;
}
