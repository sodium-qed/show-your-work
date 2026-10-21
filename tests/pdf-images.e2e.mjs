// An original CMYK JPEG2000 illustration must survive PDF decoding, exercise
// cropping, and the downloaded exam. Its pale, warm exterior must not be erased as a highlighter.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState,
  concatTransformationMatrix, drawObject,
} from 'pdf-lib';
import { createStaticServer } from '../scripts/serve.mjs';

// Generated solely for this test by fixtures/make-jpeg2000-diagram.py. Keeping
// the encoded bytes here avoids requiring an image encoder in the test runner.
const JPEG2000 = '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';
const out = process.env.OUT || 'tests/output/pdf-images';
await mkdir(out, { recursive: true });
const diagram = { x0: 80, y0: 160, x1: 260, y1: 295 };
const neighbors = [
  { number: 72, x0: 337, y0: 95, x1: 580, y1: 150 },
  { number: 73, x0: 47, y0: 325, x1: 290, y1: 380 },
];

async function worksheet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([612, 792]);
  const text = (value, x, top, size = 12, emphasis = false) =>
    page.drawText(value, { x, y: 792 - top, size, font: emphasis ? bold : font });
  text('Solid geometry practice', 50, 45, 19, true);
  text('Exercises 71-73: Explain your reasoning.', 50, 77, 12, true);
  text('71.', 50, 112, 12, true);
  text('Study the shaded solid in the figure.', 74, 112);
  text('Find its volume and explain your method.', 74, 129);
  text('72.', 340, 112, 12, true);
  text('Compare two rectangular prisms.', 364, 112);
  text('State how their volumes are related.', 364, 129);
  text('73.', 50, 342, 12, true);
  text('Describe the cross section of a cylinder.', 74, 342);
  text('Justify your answer in a complete sentence.', 74, 359);
  const imageRef = doc.context.register(doc.context.stream(Buffer.from(JPEG2000, 'base64'), {
    Type: 'XObject', Subtype: 'Image', Width: 240, Height: 180,
    ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'JPXDecode',
  }));
  const name = page.node.newXObject('OriginalDiagram', imageRef);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(
    diagram.x1 - diagram.x0, 0, 0, diagram.y1 - diagram.y0, diagram.x0, 792 - diagram.y1,
  ), drawObject(name), popGraphicsState());
  return doc.save();
}

const HOST = process.env.E2E_HOST || 'localhost';
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(0, HOST === 'localhost' ? undefined : HOST);
await once(server, 'listening');
const BASE = `http://${HOST}:${server.address().port}`;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
let browser;
const errors = [], failures = [], decoderRequests = [];
try {
  browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('request', request => { if (/openjpeg|qcms_bg/i.test(request.url())) decoderRequests.push(request.url()); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__syw);
  const bytes = await worksheet();
  await writeFile(`${out}/worksheet.pdf`, bytes);
  await page.evaluate(async bytes => {
    await window.__syw.addFiles([new File([new Uint8Array(bytes)], 'original-jpeg2000.pdf', { type: 'application/pdf' })]);
  }, [...bytes]);
  await page.locator('#ask-input').fill('71');
  await page.locator('#ask button').click();
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled, null, { timeout: 120_000 });
  const result = await page.evaluate(async ({ diagram, neighbors }) => {
    const { cropImage } = await import('/src/document.js');
    const { state } = window.__syw, model = state.sources[0].pages[0];
    const problem = [...state.selected.values()].find(p => p.number === 71);
    const crop = problem && await cropImage(model, problem.rect, { parts: problem.parts });
    const destination = crop?.canvas.getContext('2d').getImageData(0, 0, crop.canvas.width, crop.canvas.height);
    const ox = problem && Math.max(0, Math.floor(problem.rect.x0 * model.scale));
    const oy = problem && Math.max(0, Math.floor(problem.rect.y0 * model.scale));
    const measure = (bounds, darkOnly = false) => {
      let visible = 0, retained = 0, pale = 0;
      for (let y = Math.floor(bounds.y0 * model.scale); y < Math.ceil(bounds.y1 * model.scale); y++) {
        for (let x = Math.floor(bounds.x0 * model.scale); x < Math.ceil(bounds.x1 * model.scale); x++) {
          const offset = (y * model.img.width + x) * 4;
          const rgb = model.img.data.subarray(offset, offset + 3), hi = Math.max(...rgb), lo = Math.min(...rgb);
          if (darkOnly ? hi >= 100 : lo >= 245) continue;
          visible++; if (lo >= 170) pale++;
          const cx = x - ox, cy = y - oy;
          if (destination && cx >= 0 && cy >= 0 && cx < destination.width && cy < destination.height &&
            destination.data[(cy * destination.width + cx) * 4] < (darkOnly ? 180 : 250)) retained++;
        }
      }
      return { visible, retained, pale };
    };
    return {
      selected: [...state.selected.values()].map(p => p.number), detected: model.problems.map(p => p.number),
      ocr: model.ocr, diagram: measure(diagram), neighbors: neighbors.map(n => ({ number: n.number, ...measure(n, true) })),
      problem, figures: model.analysis.figures.map(f => ({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, owner: f.owner })),
      sourcePng: model.canvas.toDataURL('image/png'), cropPng: crop?.canvas.toDataURL('image/png'),
    };
  }, { diagram, neighbors });
  await writeFile(`${out}/source.png`, Buffer.from(result.sourcePng.split(',')[1], 'base64'));
  if (result.cropPng) await writeFile(`${out}/problem-71.png`, Buffer.from(result.cropPng.split(',')[1], 'base64'));
  delete result.sourcePng; delete result.cropPng;
  await writeFile(`${out}/result.json`, JSON.stringify({ ...result, decoderRequests, errors }, null, 2));
  await page.screenshot({ path: `${out}/app.png` });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.selected, [71], 'only the requested exercise is selected');
  assert.equal(result.ocr, false, 'native problem text needs no OCR');
  assert.ok(result.diagram.visible > 80_000, 'the original JPEG2000 solid is decoded, including its pale exterior');
  assert.ok(result.diagram.retained / result.diagram.visible >= 0.99,
    `complete source illustration survives cropping (${result.diagram.retained}/${result.diagram.visible} pixels)`);
  for (const neighbor of result.neighbors) {
    assert.ok(neighbor.visible > 100, `neighbor ${neighbor.number} has visible source text`);
    assert.ok(neighbor.retained / neighbor.visible <= 0.01, `crop excludes exercise ${neighbor.number}`);
  }
  assert.ok(decoderRequests.some(url => /openjpeg/i.test(url)), 'the browser loads the bundled JPEG2000 decoder');
  await page.waitForFunction(() => !!window.__syw.state.pdf && !document.querySelector('#download').disabled, null, { timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(`${out}/image-exam.pdf`);
  const exported = await readFile(`${out}/image-exam.pdf`);
  assert.ok((await PDFDocument.load(exported)).getPageCount() >= 1, 'the downloaded exam is a valid PDF');
  const renders = await page.evaluate(async bytes => {
    const lib = await import('/vendor/pdfjs/pdf.min.mjs');
    const pdf = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false,
      wasmUrl: '/vendor/pdfjs/wasm/' }).promise;
    const renders = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n), viewport = p.getViewport({ scale: 4 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await p.render({ canvasContext: ctx, viewport }).promise;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let pale = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] >= 170 && data[i] < 245) pale++;
      renders.push({ page: n, pale, png: canvas.toDataURL('image/png') });
    }
    await pdf.destroy();
    return renders;
  }, [...exported]);
  for (const render of renders) {
    await writeFile(`${out}/exam-${render.page}.png`, Buffer.from(render.png.split(',')[1], 'base64'));
    delete render.png;
  }
  await writeFile(`${out}/export.json`, JSON.stringify(renders, null, 2));
  // At 288 dpi even the app's smallest layout scale preserves at least the
  // source's 216-dpi count. A missing pale solid cannot be hidden by black text.
  assert.ok(renders.reduce((sum, r) => sum + r.pale, 0) >= 0.95 * result.diagram.pale,
    'the downloaded exam visibly renders the pale illustration, not only its dark construction lines');
  assert.deepEqual(errors, [], 'the browser raises no errors');
  console.log('PDF IMAGES OK: real JPEG2000 decoding, complete original pixels, no neighbors, visible downloaded diagram');
} finally {
  if (failures.length) console.error(`Network failures:\n${failures.join('\n')}`);
  if (errors.length) console.error(`Browser errors:\n${errors.join('\n')}`);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
