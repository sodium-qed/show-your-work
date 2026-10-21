// Raster-only mathematics with staggered columns: verify the actual selected pixels,
// including superscripts and fraction bars, rather than relying on OCR transcripts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createStaticServer } from '../scripts/serve.mjs';

const out = process.env.OUT || 'tests/output/scan-layout';
await mkdir(out, { recursive: true });
const expected = [2, 4, 6, 8, 10, 12, 38, 40];

async function scannedWorksheet(page) {
  const fixture = await page.evaluate(() => {
    const width = 850, height = 1100, scale = 3;
    const c = document.createElement('canvas');
    c.width = width * scale; c.height = height * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#111'; ctx.lineWidth = 0.8;
    const text = (t, x, y, size = 16, bold = false) => {
      ctx.font = `${bold ? 'bold ' : ''}${size}px "Times New Roman", serif`;
      ctx.fillText(t, x, y);
    };
    text('Integral practice', 60, 50, 24, true);
    text('Exer. 1–40: Evaluate.', 60, 90, 16, true);
    const exercises = [];
    function fraction(top, bottom, x, y) {
      text(top, x + 4, y - 7, 15);
      ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x + 23, y - 2); ctx.stroke();
      text(bottom, x + 3, y + 14, 15);
    }
    function problem(number, x, y, kind = number % 3) {
      text(String(number), x, y, 16, true);
      text('∫', x + 24, y + 9, 34);
      if (kind === 0) {
        fraction('4', 'z⁷', x + 47, y);
        text('−', x + 80, y + 4, 17);
        fraction('7', 'z⁴', x + 101, y);
        text('dz', x + 139, y + 4, 16);
      } else if (kind === 1) {
        text('(2x³ − x² + 3) dx', x + 45, y + 3, 16);
      } else {
        text('(3√u +', x + 45, y + 3, 16);
        fraction('1', 'u²', x + 98, y);
        text(') du', x + 129, y + 3, 16);
      }
      exercises.push({ number, bounds: { x0: x - 2, y0: y - 28, x1: x + 172, y1: y + 24 } });
    }
    // A baseline shift larger than small-font OCR line tolerance is ordinary in
    // scanned pages: the right integral can be taller than the neighboring one.
    for (let row = 0; row < 6; row++) {
      problem(1 + 2 * row, 60, 140 + 70 * row);
      problem(2 + 2 * row, 250, 148 + 70 * row);
    }
    // The neighboring block changes from two columns to a full-width prompt.
    problem(38, 500, 138, 0);
    problem(39, 675, 145, 2);
    problem(40, 500, 225, 1);
    for (const [number, y] of [[41, 315], [42, 405]]) {
      text(String(number), 500, y, 16, true);
      text('Show each step of the calculation.', 525, y, 16);
      text('Explain the constant in your answer.', 525, y + 24, 16);
      exercises.push({ number, bounds: { x0: 498, y0: y - 18, x1: 835, y1: y + 28 } });
    }
    text('Exer. 43–48: Find an antiderivative.', 500, 485, 16, true);
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
      const number = 43 + row * 3 + col, x = 500 + col * 110, y = 535 + row * 70;
      text(String(number), x, y, 16, true);
      text('∫', x + 23, y + 8, 32);
      text('a² dx', x + 43, y + 2, 16);
      exercises.push({ number, bounds: { x0: x - 2, y0: y - 27, x1: x + 95, y1: y + 20 } });
    }
    return { png: c.toDataURL('image/png'), width, height, exercises };
  });
  const doc = await PDFDocument.create();
  const png = Buffer.from(fixture.png.split(',')[1], 'base64');
  const image = await doc.embedPng(png);
  doc.addPage([fixture.width, fixture.height]).drawImage(image, { x: 0, y: 0, width: fixture.width, height: fixture.height });
  return { ...fixture, png, pdf: await doc.save() };
}

const HOST = process.env.E2E_HOST || 'localhost';
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(0, HOST === 'localhost' ? undefined : HOST);
await once(server, 'listening');
const BASE = `http://${HOST}:${server.address().port}`;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
let browser;
const errors = [], failures = [], ocrRequests = [];
try {
  browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('request', request => { if (/tesseract|traineddata/i.test(request.url())) ocrRequests.push(request.url()); });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => !!window.__syw);
  const fixture = await scannedWorksheet(page);
  await writeFile(`${out}/worksheet.png`, fixture.png);
  await writeFile(`${out}/worksheet.pdf`, fixture.pdf);
  await page.evaluate(async bytes => {
    await window.__syw.addFiles([new File([new Uint8Array(bytes)], 'scan-layout.pdf', { type: 'application/pdf' })]);
  }, [...fixture.pdf]);
  await page.locator('#ask-input').fill('1-40 even');
  await page.locator('#ask button').click();
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled, null, { timeout: 240_000 });

  const result = await page.evaluate(async exercises => {
    const { cropImage } = await import('/src/document.js');
    const state = window.__syw.state, model = state.sources[0].pages[0];
    const results = [];
    for (const p of state.selected.values()) {
      const crop = await cropImage(model, p.rect, { parts: p.parts });
      const pixels = crop.canvas.getContext('2d').getImageData(0, 0, crop.canvas.width, crop.canvas.height);
      const origin = { x: Math.max(0, Math.floor(p.rect.x0 * model.scale)), y: Math.max(0, Math.floor(p.rect.y0 * model.scale)) };
      const ink = exercises.map(e => {
        let source = 0, retained = 0;
        for (let y = Math.max(0, Math.floor(e.bounds.y0 * model.scale)); y < Math.min(model.img.height, Math.ceil(e.bounds.y1 * model.scale)); y++) {
          for (let x = Math.max(0, Math.floor(e.bounds.x0 * model.scale)); x < Math.min(model.img.width, Math.ceil(e.bounds.x1 * model.scale)); x++) {
            const from = (y * model.img.width + x) * 4;
            if (Math.max(model.img.data[from], model.img.data[from + 1], model.img.data[from + 2]) >= 100) continue;
            source++;
            const cx = x - origin.x, cy = y - origin.y;
            if (cx >= 0 && cy >= 0 && cx < pixels.width && cy < pixels.height && pixels.data[(cy * pixels.width + cx) * 4] < 180) retained++;
          }
        }
        return { number: e.number, source, retained };
      });
      results.push({ number: p.number, rect: p.rect, parts: p.parts, text: p.text, ink, png: crop.canvas.toDataURL('image/png') });
    }
    return {
      detected: model.problems.map(p => p.number), selected: [...state.selected.values()].map(p => p.number).sort((a, b) => a - b),
      textLayerItems: (await (await model.source.doc.getPage(1)).getTextContent()).items.length,
      ocr: model.ocr, bodySize: model.analysis.bodySize, words: model.words,
      anchors: model.analysis.anchors.map(a => ({ number: a.number, word: a.word, box: a.box, right: a.right, limit: a.limit })),
      figures: model.analysis.figures.map(f => ({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, owner: f.owner })),
      toast: document.querySelector('#toast').textContent, crops: results,
    };
  }, fixture.exercises);
  for (const crop of result.crops) {
    await writeFile(`${out}/problem-${crop.number}.png`, Buffer.from(crop.png.split(',')[1], 'base64'));
    delete crop.png;
  }
  await writeFile(`${out}/result.json`, JSON.stringify({ ...result, exercises: fixture.exercises }, null, 2));
  await page.screenshot({ path: `${out}/app.png`, fullPage: false });
  console.log(JSON.stringify({ detected: result.detected, selected: result.selected, ocr: result.ocr, toast: result.toast }));
  const summary = result.crops.map(c => ({ number: c.number,
    own: c.ink.filter(i => i.number === c.number).map(i => `${i.retained}/${i.source}`),
    neighbors: c.ink.filter(i => i.number !== c.number && i.retained > 0).map(i => `${i.number}:${i.retained}/${i.source}`) }));
  console.log(`Crop pixels: ${JSON.stringify(summary)}`);
  assert.equal(result.textLayerItems, 0, 'the original fixture really is a scanned PDF without a text layer');
  assert.ok(result.ocr && ocrRequests.length, 'the real browser OCR pipeline reads the scan');
  assert.deepEqual(result.selected, expected, '1-40 even selects exactly the visible requested exercises');
  for (const crop of result.crops) {
    for (const ink of crop.ink) {
      assert.ok(ink.source > 100, `exercise ${ink.number} contains visible ink`);
      if (ink.number === crop.number) assert.ok(ink.retained / ink.source >= 0.99,
        `problem ${crop.number}: complete original equation (${ink.retained}/${ink.source} pixels)`);
      else assert.ok(ink.retained / ink.source <= 0.01,
        `problem ${crop.number}: excludes neighboring exercise ${ink.number} (${ink.retained}/${ink.source} pixels)`);
    }
  }
  await page.waitForFunction(() => !!window.__syw.state.pdf && /^8 problems on/.test(document.querySelector('#exam-status').textContent), null, { timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(`${out}/scan-exam.pdf`);
  assert.equal((await PDFDocument.load(await readFile(`${out}/scan-exam.pdf`))).getPageCount(), 2, 'a valid two-sided exam downloads');
  assert.deepEqual(errors, [], 'the app raises no browser errors');
  console.log('SCAN LAYOUT OK: exact even range, full equation pixels, neighboring exercises excluded, valid PDF');
} finally {
  if (failures.length) console.error(`Network failures:\n${failures.join('\n')}`);
  if (errors.length) console.error(`Browser errors:\n${errors.join('\n')}`);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
