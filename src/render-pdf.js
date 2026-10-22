// Draw a layout (from layout.js) into a PDF with pdf-lib. No headers, titles or footers.
import { gridScale } from './layout.js';

const INK = [0, 0, 0];
const GRID = [0.72, 0.72, 0.72];
const AXIS = [0.25, 0.25, 0.25];

/**
 * @param PDFLib the pdf-lib namespace
 * @param layout result of layoutExam
 * @param images Map ref → { bytes: Uint8Array, type: 'png'|'jpg' }
 */
export async function renderExamPdf(PDFLib, layout, images) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle('Problems');
  doc.setProducer('Show Your Work');
  doc.setCreator('Show Your Work');
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const embedded = new Map();
  const embed = async ref => {
    if (embedded.has(ref)) return embedded.get(ref);
    const img = images.get(ref);
    if (!img) return null;
    const e = img.type === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    embedded.set(ref, e);
    return e;
  };
  const color = c => rgb(c[0], c[1], c[2]);
  for (const p of layout.pages) {
    const page = doc.addPage([layout.width, layout.height]);
    const H = layout.height;
    for (const it of p.items) {
      if (it.type === 'image') {
        const e = await embed(it.ref);
        if (e) page.drawImage(e, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
      } else if (it.type === 'text') {
        const font = it.italic ? italic : roman;
        page.drawText(safeText(font, it.text), { x: it.x, y: H - it.y, size: it.size, font, color: color(INK) });
      } else if (it.type === 'line') {
        page.drawLine({ start: { x: it.x1, y: H - it.y1 }, end: { x: it.x2, y: H - it.y2 }, thickness: 0.6, color: color(INK) });
      } else if (it.type === 'polar') {
        drawPolar(page, it, H, { color, sans });
      } else if (it.type === 'xy' || it.type === 'complex') {
        drawXY(page, it, H, { color, sans });
      } else if (it.type === 'numberline') {
        drawNumberline(page, it, H, { color, sans });
      } else if (it.type === 'dot') {
        drawDots(page, it, H, { color });
      }
    }
  }
  return doc.save();
}

/** Replace characters the standard fonts cannot encode. */
export function safeText(font, text) {
  let out = '';
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += { '–': '-', '—': '-', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"' }[ch] || '?'; }
  }
  return out;
}

export function canEncode(text) {
  // WinAnsi covers Latin-1 plus a few typographic marks; anything else must stay an image.
  return /^[\x20-\x7E -ÿ–—‘’“”•…]*$/.test(text);
}

function drawPolar(page, it, H, { color, sans }) {
  const scale = gridScale(it.extent);
  const R = scale.steps;
  const cx = it.x + it.size / 2, cy = H - (it.y + it.size / 2);
  const rad = it.size / 2 - 2;
  const step = rad / R;
  for (let i = 1; i <= R; i++) {
    page.drawCircle({ x: cx, y: cy, size: step * i, borderColor: color(GRID), borderWidth: 0.5 });
  }
  for (let a = 0; a < 180; a += 15) {
    if (a % 90 === 0) continue;
    const t = a * Math.PI / 180, dx = Math.cos(t) * rad, dy = Math.sin(t) * rad;
    page.drawLine({ start: { x: cx - dx, y: cy - dy }, end: { x: cx + dx, y: cy + dy }, thickness: a % 30 === 0 ? 0.5 : 0.3, color: color(GRID) });
  }
  page.drawLine({ start: { x: cx - rad - 4, y: cy }, end: { x: cx + rad + 4, y: cy }, thickness: 0.9, color: color(AXIS) });
  page.drawLine({ start: { x: cx, y: cy - rad - 4 }, end: { x: cx, y: cy + rad + 4 }, thickness: 0.9, color: color(AXIS) });
  const fs = Math.max(5, Math.min(7, step * 0.55));
  for (let i = 1; i <= R; i++) page.drawText(tickText(i * scale.step), { x: cx + step * i - fs * 0.3, y: cy - fs - 1.5, size: fs, font: sans, color: color(AXIS) });
}

function drawXY(page, it, H, { color, sans }) {
  const scale = gridScale(it.extent);
  const n = scale.steps;
  // Keep axis captions and tick labels inside the allocated square.
  const x0 = it.x + 10, top = H - it.y - 10, size = it.size - 20;
  const cell = size / (2 * n);
  for (let i = 0; i <= 2 * n; i++) {
    const axis = i === n;
    page.drawLine({ start: { x: x0 + i * cell, y: top }, end: { x: x0 + i * cell, y: top - size }, thickness: axis ? 0.9 : 0.35, color: color(axis ? AXIS : GRID) });
    page.drawLine({ start: { x: x0, y: top - i * cell }, end: { x: x0 + size, y: top - i * cell }, thickness: axis ? 0.9 : 0.35, color: color(axis ? AXIS : GRID) });
  }
  const fs = Math.max(5, Math.min(6.5, cell * 0.48));
  const cx = x0 + n * cell, cy = top - n * cell;
  page.drawText(it.type === 'complex' ? 'Re' : 'x', { x: x0 + size - 8, y: cy + 4, size: fs + 1, font: sans, color: color(AXIS) });
  page.drawText(it.type === 'complex' ? 'Im' : 'y', { x: cx + 3, y: top + 3, size: fs + 1, font: sans, color: color(AXIS) });
  const widest = Math.max(...Array.from({ length: n }, (_, i) => sans.widthOfTextAtSize(tickText(-(i + 1) * scale.step), fs)));
  const labelStride = Math.max(1, Math.ceil((widest + 3) / cell));
  const labels = [];
  for (let i = n; i > 0; i -= labelStride) labels.push(-i, i);
  for (const i of labels) {
    const text = tickText(i * scale.step), tw = sans.widthOfTextAtSize(text, fs);
    page.drawText(text, { x: cx + i * cell - tw / 2, y: cy - fs - 2, size: fs, font: sans, color: color(AXIS) });
    page.drawText(text, { x: cx - tw - 2, y: cy + i * cell - fs * 0.3, size: fs, font: sans, color: color(AXIS) });
  }
  page.drawText('0', { x: cx + 2, y: cy - fs - 2, size: fs, font: sans, color: color(AXIS) });
}

function tickText(n) {
  return Math.abs(n) >= 1e4 ? Number(n.toPrecision(3)).toExponential().replace('e+', 'e') : String(Number(n.toPrecision(10)));
}

function drawNumberline(page, it, H, { color, sans }) {
  const scale = gridScale(it.extent, { maxSteps: 4 });
  const x0 = it.x + 10, x1 = it.x + it.w - 10, cy = H - it.y - 13;
  const line = (a, b, c, d, thickness = 0.7) => page.drawLine({ start: { x: a, y: b }, end: { x: c, y: d }, thickness, color: color(AXIS) });
  line(x0 - 5, cy, x1 + 5, cy);
  for (const [x, sign] of [[x0 - 5, 1], [x1 + 5, -1]]) {
    line(x, cy, x + sign * 4, cy + 3);
    line(x, cy, x + sign * 4, cy - 3);
  }
  for (let i = -scale.steps; i <= scale.steps; i++) {
    const x = x0 + (i + scale.steps) / (2 * scale.steps) * (x1 - x0);
    line(x, cy - 3, x, cy + 3);
    const text = tickText(i * scale.step), size = 6;
    page.drawText(text, { x: x - sans.widthOfTextAtSize(text, size) / 2, y: cy - 12, size, font: sans, color: color(AXIS) });
  }
}

function drawDots(page, it, H, { color }) {
  const count = Math.max(4, Math.min(16, Math.floor(it.size / 10)));
  const step = (it.size - 8) / count;
  for (let y = 0; y <= count; y++) for (let x = 0; x <= count; x++) {
    page.drawCircle({ x: it.x + 4 + x * step, y: H - it.y - 4 - y * step, size: 0.65, color: color(GRID) });
  }
}
