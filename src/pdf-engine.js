import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
import { planWorksheet } from './layout.js';
import { detectQuestions } from './detection.js';
import { extractRegionText } from './text-extraction.js';

pdfjs.GlobalWorkerOptions.workerSrc = globalThis.MARGIN_EMBEDDED?.workerURL || '/vendor/pdfjs/build/pdf.worker.mjs';
const pdfOptions = {
  cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
  isEvalSupported: false,
  ...globalThis.MARGIN_EMBEDDED?.pdfOptions,
};
const MAX_PIXELS = 20_000_000;
const MAX_SIDE = 14_000;
const PREVIEW_PIXELS = 48_000_000;
const DPR = 300 / 72;
const WORKSHEET_FONT = 'Arial, Helvetica, "Cambria Math", "Noto Sans Math", "DejaVu Sans", sans-serif';
const sourceRenders = new WeakMap();
const previewRenders = new WeakMap();
let idSequence = 0;

export const uid = () => globalThis.crypto?.randomUUID?.()
  || `region-${Date.now().toString(36)}-${(++idSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;

function canvas(w, h) {
  const width = Math.max(1, Math.ceil(w)), height = Math.max(1, Math.ceil(h));
  if (!Number.isFinite(width + height) || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('This image is too large to render. Use a smaller crop.');
  }
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  return c;
}

function white(c) {
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Your browser could not create an image canvas. Try a smaller crop.');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  return ctx;
}

function dimensions(width, height, requestedScale, pixelBudget = MAX_PIXELS) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) {
    throw new Error('This page has invalid dimensions.');
  }
  const scale = Math.min(requestedScale, Math.sqrt(pixelBudget / width / height), MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

async function pngBytes(c) {
  const blob = await new Promise((resolve, reject) => {
    c.toBlob(value => value ? resolve(value) : reject(new Error('Your browser ran out of image memory. Use a smaller crop.')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function thumbnail(c) {
  const scale = Math.min(1, 560 / c.width, 840 / c.height);
  const thumb = canvas(c.width * scale, c.height * scale);
  try {
    white(thumb).drawImage(c, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/png');
  } finally { thumb.width = thumb.height = 1; }
}

function assertSource(source, pageNumber) {
  if (!source || source.disposed) throw new Error('This source has been closed. Import it again.');
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > source.pages) {
    throw new Error('Choose an available page from this source.');
  }
}

export async function loadSource(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a PDF or image file.');
  if (!file.size) throw new Error('This file is empty. Choose another file.');
  if (file.size > 50 * 1024 * 1024) throw new Error('Choose a file smaller than 50 MB.');
  const source = { id: uid(), name: file.name || 'Untitled source', kind: '', pages: 1, cache: new Map(), rasterCache: new Map(), tasks: new Set() };
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const pdfHeader = new TextDecoder('latin1').decode(head).includes('%PDF-');
  const imageHeader = (head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71)
    || (head[0] === 255 && head[1] === 216 && head[2] === 255)
    || (head[0] === 82 && head[1] === 73 && head[2] === 70 && head[3] === 70 && head[8] === 87 && head[9] === 69 && head[10] === 66 && head[11] === 80);
  if (pdfHeader || (!imageHeader && (file.type === 'application/pdf' || /\.pdf$/i.test(source.name)))) {
    source.kind = 'pdf';
    let loading;
    try {
      loading = pdfjs.getDocument({ ...pdfOptions, data: new Uint8Array(await file.arrayBuffer()) });
      source.pdf = await loading.promise;
      source.pages = source.pdf.numPages;
      if (source.pages > 500) throw new Error('This PDF has more than 500 pages. Split it into smaller files first.');
      if (source.pdf.isPureXfa) throw new Error('This PDF uses XFA forms. Print it to a standard PDF before importing.');
    } catch (error) {
      await loading?.destroy().catch(() => {});
      if (error.name === 'PasswordException') throw new Error('This PDF is password-protected. Upload an unlocked copy.');
      throw new Error(`Unable to open PDF: ${error.message || 'The file may be damaged or unsupported.'}`);
    }
  } else if (imageHeader || /^image\/(png|jpe?g|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(source.name)) {
    source.kind = 'image';
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode();
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw new Error('The image has no usable pixels.');
      if (img.naturalWidth * img.naturalHeight > 50_000_000) throw new Error('Image exceeds 50 megapixels. Resize it before importing.');
      source.image = img;
      // Images start at their 300 dpi print size, capped at 7.5 inches wide.
      // Browser decoding also applies JPEG EXIF orientation before cropping.
      const factor = Math.min(72 / 300, 540 / img.naturalWidth);
      source.width = img.naturalWidth * factor; source.height = img.naturalHeight * factor;
      source.url = url;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw new Error(`Unable to open image: ${error.message || 'The file may be damaged or unsupported.'}`);
    }
  } else throw new Error('Supported files: PDF, PNG, JPEG, and WEBP.');
  return source;
}

/** Call when removing a source; existing exported crops remain usable. */
export async function disposeSource(source) {
  if (!source || source.disposed) return;
  source.disposed = true;
  for (const task of source.tasks || []) task.cancel();
  if (source.url) URL.revokeObjectURL(source.url);
  source.image = null;
  source.cache?.clear(); source.rasterCache?.clear();
  await source.pdf?.destroy();
}

export async function pageInfo(source, pageNumber) {
  assertSource(source, pageNumber);
  if (source.kind !== 'pdf') return { width: source.width, height: source.height };
  if (!source.cache.has(pageNumber)) source.cache.set(pageNumber, await source.pdf.getPage(pageNumber));
  assertSource(source, pageNumber);
  const page = source.cache.get(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  if (!(viewport.width > 0 && viewport.height > 0) || !Number.isFinite(viewport.width + viewport.height)) {
    throw new Error('This PDF page has invalid dimensions.');
  }
  return { width: viewport.width, height: viewport.height, page };
}

/** Superseded renders resolve to null and never overwrite a newer page. */
export async function renderSource(source, pageNumber, target, cssWidth = 800) {
  const previous = sourceRenders.get(target);
  const request = { task: null };
  sourceRenders.set(target, request);
  previous?.task?.cancel();
  try {
    await previous?.task?.promise.catch(() => {});
    const info = await pageInfo(source, pageNumber);
    if (sourceRenders.get(target) !== request) return null;
    const screenWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 800;
    const deviceScale = Math.max(1, Math.min(Number(globalThis.devicePixelRatio) || 1, 2));
    const size = dimensions(info.width, info.height, screenWidth * deviceScale / info.width);
    target.width = size.width; target.height = size.height;
    const ctx = white(target);
    if (source.kind === 'pdf') {
      request.task = info.page.render({ canvasContext: ctx, viewport: info.page.getViewport({ scale: 1 }),
        transform: [target.width / info.width, 0, 0, target.height / info.height, 0, 0],
        intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE });
      source.tasks?.add(request.task);
      await request.task.promise;
    } else ctx.drawImage(source.image, 0, 0, target.width, target.height);
    return sourceRenders.get(target) === request ? info : null;
  } catch (error) {
    if (sourceRenders.get(target) !== request || source?.disposed) return null;
    throw error;
  } finally {
    source.tasks?.delete(request.task);
    if (sourceRenders.get(target) === request) sourceRenders.delete(target);
  }
}

async function pageTextItems(page) {
  const viewport = page.getViewport({ scale: 1 });
  const data = await page.getTextContent();
  return data.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => {
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    const style = data.styles[item.fontName] || {};
    const angle = Math.atan2(t[1], t[0]) + (style.vertical ? Math.PI / 2 : 0);
    const h = Math.hypot(t[2], t[3]);
    const ascent = h * (Number.isFinite(style.ascent) ? style.ascent : 0.85);
    const advance = (style.vertical ? item.height : item.width) * viewport.userUnit;
    const ux = Math.cos(angle), uy = Math.sin(angle), vx = Math.sin(angle), vy = -Math.cos(angle);
    const corners = [[0, ascent], [advance, ascent], [0, ascent - h], [advance, ascent - h]]
      .map(([along, up]) => [t[4] + along * ux + up * vx, t[5] + along * uy + up * vy]);
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    return { text: item.str, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  });
}

export async function suggestions(source, pageNumber) {
  assertSource(source, pageNumber);
  if (source.kind !== 'pdf') return [];
  const { page, width, height } = await pageInfo(source, pageNumber);
  return detectQuestions(await pageTextItems(page), width, height);
}

/** Extract only the PDF text layer; callers must let the user review the wording. */
export async function selectedText(source, pageNumber, inputRect) {
  assertSource(source, pageNumber);
  const rect = boundedRect(inputRect);
  const manualEntry = 'Type or paste the wording manually. This tool does not perform OCR.';
  if (source.kind !== 'pdf') {
    return { text: '', warnings: [`Images do not have a selectable PDF text layer. ${manualEntry}`] };
  }
  const { page, width, height } = await pageInfo(source, pageNumber);
  let items;
  try {
    items = await pageTextItems(page);
  } catch {
    assertSource(source, pageNumber);
    return { text: '', warnings: [`The PDF text layer could not be read. ${manualEntry}`] };
  }
  assertSource(source, pageNumber);
  const result = extractRegionText(items, { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height });
  if (!result.text.trim()) {
    return { text: '', warnings: [...new Set([...result.warnings, manualEntry])] };
  }
  return result;
}

function boundedRect(rect) {
  if (!rect || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(rect[key]))) || !(Number(rect.w) > 0 && Number(rect.h) > 0)) {
    throw new Error('Draw a crop with a positive width and height.');
  }
  const x = Math.max(0, Number(rect.x)), y = Math.max(0, Number(rect.y));
  const right = Math.min(1, Number(rect.x) + Number(rect.w)), bottom = Math.min(1, Number(rect.y) + Number(rect.h));
  if (right <= x || bottom <= y) throw new Error('The crop must overlap the source page.');
  return { x, y, w: right - x, h: bottom - y };
}

// Assets contain locally generated PNG bytes. Read the PNG bounds before
// decoding so an invalid asset cannot bypass the existing canvas memory limit.
async function assetImage(asset) {
  const input = asset?.png;
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!bytes || bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('This problem is missing its original PNG image. Re-add the crop.');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) {
    throw new Error('This crop image could not be read. Re-add the crop.');
  }
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height) throw new Error('This crop image has no usable pixels. Re-add the crop.');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('This crop image is too large to render. Use a smaller crop.');
  }
  const blob = new Blob([bytes], { type: 'image/png' });
  let image, url;
  const release = () => {
    image?.close?.();
    if (url) { image?.removeAttribute('src'); URL.revokeObjectURL(url); }
  };
  try {
    if (typeof globalThis.createImageBitmap === 'function') image = await createImageBitmap(blob);
    else {
      url = URL.createObjectURL(blob);
      image = new Image(); image.decoding = 'async'; image.src = url;
      await image.decode();
    }
    if ((image.naturalWidth || image.width) !== width || (image.naturalHeight || image.height) !== height) {
      throw new Error('Unexpected image dimensions.');
    }
    return { image, width, height, release };
  } catch {
    release();
    throw new Error('This crop image could not be read. Re-add the crop.');
  }
}

/** Prepare a small local image; this function never sends it to a service. */
export async function aiImage(asset) {
  const original = await assetImage(asset);
  let c;
  try {
    const scale = Math.min(1, 1600 / Math.max(original.width, original.height));
    const size = dimensions(original.width, original.height, scale, 2_000_000);
    c = canvas(size.width, size.height);
    const ctx = white(c); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(original.image, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height,
      text: typeof asset.text === 'string' ? asset.text : '' };
  } finally {
    original.release();
    if (c) c.width = c.height = 1;
  }
}

/** Copy original crop pixels at their existing print size, never the AI image. */
export async function cropAssetRegion(asset, inputRect) {
  const rect = boundedRect(inputRect);
  if (!(asset?.width > 0 && asset?.height > 0) || !Number.isFinite(asset.width + asset.height)) {
    throw new Error('This problem has invalid print dimensions. Re-add the crop.');
  }
  const originalRect = asset.rect == null ? null : boundedRect(asset.rect);
  const original = await assetImage(asset);
  let c;
  try {
    // Round shared edges consistently. The matching point bounds keep the
    // copied pixels at exactly their original scale, including repeated crops.
    const left = Math.round(rect.x * original.width), top = Math.round(rect.y * original.height);
    const right = Math.round((rect.x + rect.w) * original.width), bottom = Math.round((rect.y + rect.h) * original.height);
    if (right <= left || bottom <= top) throw new Error('The crop is smaller than one source pixel. Select a larger area.');
    const normalized = { x: left / original.width, y: top / original.height,
      w: (right - left) / original.width, h: (bottom - top) / original.height };
    const width = asset.width * normalized.w, height = asset.height * normalized.h;
    const density = 72 * Math.min((right - left) / width, (bottom - top) / height);
    if (!(width > 0 && height > 0 && density > 0) || !Number.isFinite(width + height + density)) {
      throw new Error('This problem has invalid print dimensions. Re-add the crop.');
    }
    const renderDpi = Math.min(density, Number.isFinite(asset.renderDpi) && asset.renderDpi > 0 ? asset.renderDpi : Infinity);
    const dpi = Math.min(renderDpi, Number.isFinite(asset.dpi) && asset.dpi > 0 ? asset.dpi : Infinity);
    c = canvas(right - left, bottom - top);
    const ctx = white(c); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(original.image, left, top, c.width, c.height, 0, 0, c.width, c.height);
    const region = {
      id: uid(), sourceId: asset.sourceId ?? null, sourceName: asset.sourceName ?? 'Original crop', page: asset.page ?? 1,
      width, height, pixelWidth: c.width, pixelHeight: c.height, dpi, renderDpi,
      png: await pngBytes(c), thumbnail: thumbnail(c), breaks: whitespaceBreaks(c),
    };
    if (originalRect) region.rect = boundedRect({
      x: originalRect.x + normalized.x * originalRect.w, y: originalRect.y + normalized.y * originalRect.h,
      w: normalized.w * originalRect.w, h: normalized.h * originalRect.h,
    });
    return region;
  } finally {
    original.release();
    if (c) c.width = c.height = 1;
  }
}

// Estimate native scan density without decoding another copy of its image. This
// deliberately ignores PDF text/vector objects, which use the export raster target.
async function rasterImages(source, pageNumber, info) {
  if (source.kind !== 'pdf') return [];
  if (!source.rasterCache) source.rasterCache = new Map();
  if (!source.rasterCache.has(pageNumber)) {
    source.rasterCache.set(pageNumber, (async () => {
      const ops = await info.page.getOperatorList({ intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE });
      const viewport = info.page.getViewport({ scale: 1 });
      const stack = [], images = [];
      let matrix = viewport.transform.slice();
      const add = (width, height) => {
        const sx = Math.hypot(matrix[0], matrix[1]), sy = Math.hypot(matrix[2], matrix[3]);
        if (!(width > 0 && height > 0 && sx > 0 && sy > 0)) return;
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => { pdfjs.Util.applyTransform(p, matrix); return p; });
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        images.push({ x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), dpi: 72 * Math.min(width / sx, height / sy) });
      };
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === pdfjs.OPS.save || fn === pdfjs.OPS.beginGroup) stack.push(matrix.slice());
        else if (fn === pdfjs.OPS.restore || fn === pdfjs.OPS.endGroup || fn === pdfjs.OPS.paintFormXObjectEnd || fn === pdfjs.OPS.endAnnotation) matrix = stack.pop() || viewport.transform.slice();
        else if (fn === pdfjs.OPS.transform) matrix = pdfjs.Util.transform(matrix, args);
        else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
          stack.push(matrix.slice());
          if (args[0]) matrix = pdfjs.Util.transform(matrix, args[0]);
        } else if (fn === pdfjs.OPS.beginAnnotation) {
          stack.push(matrix.slice()); matrix = viewport.transform.slice();
          if (args[2]) matrix = pdfjs.Util.transform(matrix, args[2]);
          if (args[3]) matrix = pdfjs.Util.transform(matrix, args[3]);
        } else if (fn === pdfjs.OPS.paintImageXObject) add(args[1], args[2]);
        else if (fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) add(args[0]?.width, args[0]?.height);
      }
      return images;
    })().catch(() => [])); // Density estimates must never block a valid crop.
  }
  return source.rasterCache.get(pageNumber);
}

export async function cropRegion(source, pageNumber, inputRect, existingId) {
  const rect = boundedRect(inputRect);
  const info = await pageInfo(source, pageNumber);
  const width = rect.w * info.width, height = rect.h * info.height;
  const nativeScale = source.kind === 'image' ? Math.min(source.image.naturalWidth / info.width, source.image.naturalHeight / info.height) : Infinity;
  const size = dimensions(width, height, Math.min(DPR, nativeScale));
  const c = canvas(size.width, size.height);
  let task;
  try {
    const ctx = white(c);
    const images = await rasterImages(source, pageNumber, info);
    assertSource(source, pageNumber);
    if (source.kind === 'pdf') {
      // The displayed, rotated CropBox is the common coordinate space. Scaling
      // both axes to the integer canvas bounds avoids subpixel edge stretching.
      const sx = c.width / width, sy = c.height / height;
      task = info.page.render({ canvasContext: ctx, viewport: info.page.getViewport({ scale: 1 }),
        transform: [sx, 0, 0, sy, -rect.x * info.width * sx, -rect.y * info.height * sy],
        intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE });
      source.tasks?.add(task); await task.promise;
    } else {
      ctx.drawImage(source.image, rect.x * source.image.naturalWidth, rect.y * source.image.naturalHeight,
        rect.w * source.image.naturalWidth, rect.h * source.image.naturalHeight, 0, 0, c.width, c.height);
    }
    const renderDpi = 72 * Math.min(c.width / width, c.height / height);
    let dpi = Math.min(renderDpi, nativeScale * 72);
    const x = rect.x * info.width, y = rect.y * info.height;
    for (const img of images) {
      const overlap = Math.max(0, Math.min(x + width, img.right) - Math.max(x, img.x))
        * Math.max(0, Math.min(y + height, img.bottom) - Math.max(y, img.y));
      if (overlap >= Math.min(625, width * height * 0.02)) dpi = Math.min(dpi, img.dpi);
    }
    return {
      id: existingId || uid(), sourceId: source.id, sourceName: source.name, page: pageNumber, rect,
      width, height, pixelWidth: c.width, pixelHeight: c.height, dpi, renderDpi,
      png: await pngBytes(c), thumbnail: thumbnail(c), breaks: whitespaceBreaks(c),
    };
  } finally {
    source.tasks?.delete(task);
    c.width = c.height = 1;
  }
}

function whitespaceBreaks(c) {
  const sample = canvas(Math.min(800, c.width), Math.min(4000, c.height));
  try {
    const ctx = white(sample); ctx.drawImage(c, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    const cuts = []; let run = 0;
    for (let y = 0; y < sample.height; y++) {
      let blank = true;
      for (let x = 0; x < sample.width; x++) {
        const p = (y * sample.width + x) * 4;
        if (Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) < 248) { blank = false; break; }
      }
      if (blank) run++;
      else { if (run >= 3 && y > run) cuts.push((y - run / 2) / sample.height); run = 0; }
    }
    return cuts;
  } finally { sample.width = sample.height = 1; }
}

export async function textRegion(text, width = 540) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste some text before adding a problem.');
  if (!Number.isFinite(width) || width < 24 || width > 1440) throw new Error('Choose a text width between 24 and 1440 points.');
  if (text.length > 200_000) throw new Error('Text is too long. Split it into multiple problems.');
  await document.fonts?.ready;
  const probe = canvas(1, 1), ctx = probe.getContext('2d');
  const font = `14px ${WORKSHEET_FONT}`;
  ctx.font = font;
  const lines = [], maxWidth = width - 8;
  const maxLines = Math.floor((Math.min(MAX_SIDE / DPR, MAX_PIXELS / (Math.ceil(width * DPR) * DPR)) - 10) / 21);
  const pushLine = line => {
    lines.push(line.trimEnd());
    if (lines.length > maxLines) throw new Error('Text is too long. Split it into multiple problems.');
  };
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const word of paragraph.match(/\s+|\S+/gu) || []) {
      if (ctx.measureText(line + word).width <= maxWidth) { line += word; continue; }
      if (line) { pushLine(line); line = ''; }
      if (!word.trim()) continue;
      // Iterating the string keeps surrogate pairs intact during token wrapping.
      for (const char of word) {
        if (line && ctx.measureText(line + char).width > maxWidth) { pushLine(line); line = ''; }
        line += char;
      }
    }
    pushLine(line);
  }
  const height = lines.length * 21 + 10;
  const c = canvas(Math.ceil(width * DPR), Math.ceil(height * DPR));
  try {
    const draw = white(c); draw.scale(c.width / width, c.height / height); draw.font = font;
    draw.fillStyle = '#111111'; draw.textBaseline = 'top';
    lines.forEach((line, i) => draw.fillText(line, 4, 5 + i * 21));
    return {
      id: uid(), sourceId: null, sourceName: 'Pasted text', page: 1, text, width, height,
      pixelWidth: c.width, pixelHeight: c.height, dpi: 300, renderDpi: 300,
      png: await pngBytes(c), thumbnail: thumbnail(c), breaks: whitespaceBreaks(c),
    };
  } finally { c.width = c.height = probe.width = probe.height = 1; }
}

async function headerImage(title, width, alignment) {
  await document.fonts?.ready;
  const height = 24, c = canvas(width * DPR, height * DPR), ctx = white(c);
  try {
    ctx.scale(c.width / width, c.height / height); ctx.fillStyle = '#111111';
    ctx.font = `16px ${WORKSHEET_FONT}`; ctx.textBaseline = 'top';
    const size = Math.min(16, 16 * width / Math.max(1, ctx.measureText(title).width));
    ctx.font = `${size}px ${WORKSHEET_FONT}`;
    ctx.textAlign = alignment === 'left' ? 'left' : 'center';
    ctx.fillText(title, alignment === 'left' ? 0 : width / 2, 0);
    return { png: await pngBytes(c), height, size };
  } finally { c.width = c.height = 1; }
}

export async function createWorksheet(problems, settings = {}) {
  if (!globalThis.PDFLib) throw new Error('The PDF export library did not load. Reload the app and try again.');
  const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = globalThis.PDFLib;
  settings = { ...settings, title: String(settings.title || '').replace(/\s+/g, ' ').trim() };
  const layout = planWorksheet(problems, settings);
  if (!layout.pages.length) throw new Error('Add at least one problem before exporting.');
  const doc = await PDFDocument.create();
  doc.setTitle(settings.title || 'Math worksheet'); doc.setCreator('Margin worksheet studio');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const nameLine = 'Name: _________________________    Date: ______________';
  const nameSize = 10, nameWidth = font.widthOfTextAtSize(nameLine, nameSize);
  const nameX = settings.alignment === 'left' ? layout.margin : (layout.width - nameWidth) / 2;
  const assets = new Map(problems.flatMap(p => p.regions).map(r => [r.id, r]));
  const embedded = new Map(), problemDpi = new Map();
  let title = null;
  if (settings.title) {
    const image = await headerImage(settings.title, layout.width - layout.margin * 2, settings.alignment);
    title = await doc.embedPng(image.png); await title.embed();
    if (image.size < 11) layout.warnings.push({ kind: 'title', message: 'The worksheet title uses small text. Shorten it to improve readability.' });
  }
  for (const [pi, entry] of layout.pages.entries()) {
    const page = doc.addPage([layout.width, layout.height]);
    if (title) page.drawImage(title, { x: layout.margin, y: layout.height - layout.margin - 24, width: layout.width - layout.margin * 2, height: 24 });
    if (settings.nameLine) page.drawText(nameLine, {
      x: nameX, y: layout.height - layout.margin - (title ? 36 : 9), size: nameSize, font, color: rgb(.25, .25, .25),
    });
    for (const item of entry.items) {
      if (item.type === 'label') {
        if (item.text) page.drawText(item.text, {
          x: item.x, y: layout.height - item.y - 10, size: 10, font, color: rgb(0, 0, 0),
        });
        continue;
      }
      if (item.type !== 'region') continue;
      const asset = assets.get(item.regionId);
      if (!asset?.png?.length) throw new Error(`Problem ${item.number} is missing its crop image. Re-add that crop.`);
      if (!embedded.has(item.regionId)) {
        const image = await doc.embedPng(asset.png);
        // Embedding immediately releases pdf-lib's decoded RGB/alpha buffers.
        await image.embed(); embedded.set(item.regionId, image);
      }
      const image = embedded.get(item.regionId);
      const fullHeight = item.height / item.sourceHeight;
      const y = layout.height - item.y - item.height;
      // A single PNG is reused across pages. Clipping preserves every original
      // row, even when a continuation boundary falls between source pixels.
      page.pushOperators(pushGraphicsState(), rectangle(item.x, y, item.width, item.height), clip(), endPath());
      page.drawImage(image, {
        x: item.x, y: layout.height - item.y - (1 - item.sourceTop) * fullHeight,
        width: item.width, height: fullHeight,
      });
      page.pushOperators(popGraphicsState());
      const effectiveDpi = Math.min(
        image.width / item.width * 72, image.height / fullHeight * 72,
        Number.isFinite(asset.dpi) && asset.dpi > 0 ? asset.dpi * Math.min(asset.width / item.width, asset.height / fullHeight) : Infinity,
      );
      problemDpi.set(item.number, Math.min(problemDpi.get(item.number) || Infinity, effectiveDpi));
    }
    const footer = `${pi + 1} / ${layout.pages.length}`;
    page.drawText(footer, { x: layout.width - layout.margin - font.widthOfTextAtSize(footer, 9), y: layout.margin + 1, size: 9, font, color: rgb(.35, .35, .35) });
  }
  for (const [problem, dpi] of problemDpi) {
    if (dpi < 250) layout.warnings.push({ problem, kind: 'resolution', message: `Problem ${problem} includes an image at about ${Math.max(1, Math.round(dpi))} dpi at its current print size. Inspect its sharpness or reduce its scale.` });
  }
  return { bytes: await doc.save(), layout };
}

/** Preview is rendered from the exact bytes returned for download. */
export async function renderPreview(bytes, container) {
  const previous = previewRenders.get(container);
  const request = { task: null, loading: null };
  previewRenders.set(container, request);
  previous?.task?.cancel();
  try {
    await previous?.loading?.destroy().catch(() => {});
    if (previewRenders.get(container) !== request) return null;
    container.replaceChildren();
    const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
    request.loading = pdfjs.getDocument({ ...pdfOptions, data });
    const pdf = await request.loading.promise;
    let reducedResolution = false;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), initial = page.getViewport({ scale: 1 });
      if (previewRenders.get(container) !== request) return null;
      const requestedScale = Math.min(1.6, 1100 / initial.width);
      const size = dimensions(initial.width, initial.height, requestedScale, Math.min(MAX_PIXELS, PREVIEW_PIXELS / pdf.numPages));
      reducedResolution ||= size.width < initial.width * requestedScale - 1;
      const c = canvas(size.width, size.height);
      c.className = 'preview-page'; c.setAttribute('aria-label', `Worksheet page ${n}`);
      try {
        request.task = page.render({ canvasContext: white(c), viewport: initial,
          transform: [c.width / initial.width, 0, 0, c.height / initial.height, 0, 0], intent: 'print' });
        await request.task.promise;
        if (previewRenders.get(container) !== request) { c.width = c.height = 1; return null; }
        const frame = document.createElement('figure'); frame.append(c);
        const cap = document.createElement('figcaption'); cap.textContent = `PAGE ${n} OF ${pdf.numPages}`;
        frame.append(cap); container.append(frame);
      } catch (error) { c.width = c.height = 1; throw error; }
    }
    return { pages: pdf.numPages, reducedResolution };
  } catch (error) {
    if (previewRenders.get(container) !== request) return null;
    throw error;
  } finally {
    await request.loading?.destroy().catch(() => {});
    if (previewRenders.get(container) === request) previewRenders.delete(container);
  }
}
