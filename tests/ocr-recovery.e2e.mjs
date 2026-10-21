// A PDF can have a readable prose text layer while its exercise labels are images.
// This regression uses real browser OCR and original generated content, not mocks.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createStaticServer } from '../scripts/serve.mjs';

const out = process.env.OUT || 'tests/output/ocr-recovery';
await mkdir(out, { recursive: true });
const exercises = [
  { number: 42, title: 'Area of a triangle', x: 44, y: 684, shape: 'triangle' },
  { number: 47, title: 'Storage bin', x: 320, y: 684, shape: 'rectangle' },
  { number: 52, title: 'Open-top box', x: 44, y: 436, shape: 'rectangle' },
  { number: 53, title: 'Travel time', x: 320, y: 436, shape: 'triangle' },
];

async function textbook(page, { nativeFirst = false, nativeNumbers = [], declaredRange = false, laterPage = false } = {}) {
  // Rasterize just the labels. They are clearly visible but cannot be recovered
  // from PDF.js text extraction; prose and titles remain ordinary PDF text.
  const labels = await page.evaluate(numbers => numbers.map(number => {
    const c = document.createElement('canvas');
    c.width = 34 * 6; c.height = 22 * 6;
    const ctx = c.getContext('2d');
    ctx.scale(6, 6); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 34, 22);
    ctx.fillStyle = '#000'; ctx.font = 'bold 14px "Times New Roman", serif';
    ctx.fillText(`${number}.`, 0, 16);
    return c.toDataURL('image/png');
  }), exercises.map(e => e.number));
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const p = doc.addPage([612, 792]);
  p.drawText('Optimization exercises', { x: 44, y: 750, size: 18, font: bold });
  p.drawText(declaredRange ? 'In Problems 42-53, solve each problem and explain your method.' : 'Solve each problem. Include a diagram and a complete explanation.', { x: 44, y: 724, size: 11, font: italic });
  for (const [i, e] of exercises.entries()) {
    if ((nativeFirst && e.number === 42) || nativeNumbers.includes(e.number)) p.drawText(`${e.number}.`, { x: e.x, y: e.y, size: 14, font: bold });
    else {
      const image = await doc.embedPng(labels[i]);
      p.drawImage(image, { x: e.x, y: e.y - 6, width: 34, height: 22 });
    }
    p.drawText(e.title, { x: e.x + 30, y: e.y, size: 14, font: bold });
    const lines = [
      'Find the largest possible area.',
      'The diagram below gives the shape.',
      'Explain the variables in your model.',
      'Show each step of the calculation.',
    ];
    lines.forEach((text, j) => p.drawText(text, { x: e.x + 24, y: e.y - 24 - 15 * j, size: 11, font: body }));
    const points = e.shape === 'triangle'
      ? [[e.x + 45, e.y - 142], [e.x + 120, e.y - 142], [e.x + 82, e.y - 96]]
      : [[e.x + 45, e.y - 142], [e.x + 130, e.y - 142], [e.x + 130, e.y - 96], [e.x + 45, e.y - 96]];
    points.forEach(([x, y], j) => {
      const end = points[(j + 1) % points.length];
      p.drawLine({ start: { x, y }, end: { x: end[0], y: end[1] }, thickness: 1.2, color: rgb(0, 0, 0) });
    });
    e.figure = points.map(([x, y]) => ({ x, y: 792 - y }));
  }
  if (laterPage) {
    const later = doc.addPage([612, 792]);
    later.drawText('Further exercises', { x: 44, y: 750, size: 18, font: bold });
    for (const [i, n] of [61, 62].entries()) {
      const y = 684 - 160 * i;
      later.drawText(`${n}. Rate of change`, { x: 44, y, size: 14, font: bold });
      later.drawText('Find the rate of change of the area as the shape grows.', { x: 68, y: y - 24, size: 11, font: body });
      later.drawText('Explain the variables and show each step of the calculation.', { x: 68, y: y - 39, size: 11, font: body });
    }
  }
  return doc.save();
}

const addPdf = (page, bytes, name = 'raster-labels.pdf') => page.evaluate(async ({ bytes, name }) => {
  const file = new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
  await window.__syw.addFiles([file]);
}, { bytes: [...bytes], name });
const selected = page => page.evaluate(() => [...window.__syw.state.selected.values()].map(p => p.number).sort((a, b) => a - b));
const readVisually = async page => {
  await page.locator('#read-page').click();
  await page.waitForFunction(() => !document.querySelector('#read-page').disabled, null, { timeout: 240_000 });
};

const HOST = process.env.E2E_HOST || 'localhost';
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(0, HOST === 'localhost' ? undefined : HOST);
await once(server, 'listening');
const BASE = `http://${HOST}:${server.address().port}`;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
let browser;
const errors = [], networkFailures = [], ocrRequests = [];
try {
  browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', request => networkFailures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('request', request => { if (/tesseract|traineddata/i.test(request.url())) ocrRequests.push(request.url()); });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => !!window.__syw);
  const bytes = await textbook(page, { laterPage: true });
  await writeFile(`${out}/raster-labels.pdf`, bytes);
  await addPdf(page, bytes);

  const textLayer = await page.evaluate(async () => {
    const { pageWords } = await import('/src/textlayer.js');
    const { analyzePage } = await import('/src/analyze.js');
    const source = window.__syw.state.sources[0];
    const words = await pageWords(await source.doc.getPage(1));
    return {
      proseWords: words.filter(w => /[a-z]{2}/i.test(w.text)).length,
      digitWords: words.filter(w => /\d/.test(w.text)).map(w => w.text),
      anchors: analyzePage({ words, width: 612, height: 792 }).anchors.map(a => a.number),
    };
  });
  assert.ok(textLayer.proseWords >= 12, 'the PDF has enough prose to pass the old text-layer threshold');
  assert.deepEqual(textLayer.digitWords, [], 'visible exercise numbers have no text-layer representation');
  assert.deepEqual(textLayer.anchors, [], 'text-only analysis cannot find the exercise numbers');
  console.log(`Fixture: ${textLayer.proseWords} prose words, no digit words, zero text-only anchors`);

  if (process.env.OCR_DIAGNOSTIC === '1') {
    const diagnostic = await page.evaluate(async () => {
      const { ocrWords } = await import('/src/ocr.js');
      const { analyzePage } = await import('/src/analyze.js');
      const { findFigures } = await import('/src/raster.js');
      const model = window.__syw.state.sources[0].pages[0];
      const words = await ocrWords(model.canvas, model.scale);
      const plain = analyzePage({ words, width: model.width, height: model.height, ocr: true });
      const figures = findFigures(model.img, model.scale, words, plain.bodySize);
      const masked = analyzePage({ words, width: model.width, height: model.height, figures, ocr: true });
      return { words, figures, anchors: masked.anchors.map(a => a.number), unmasked: plain.anchors.map(a => a.number) };
    });
    await writeFile(`${out}/ocr-diagnostic.json`, JSON.stringify(diagnostic, null, 2));
    console.log(`Real OCR diagnostic: anchors=${diagnostic.anchors.join(',')}; without figure masks=${diagnostic.unmasked.join(',')}`);
  }

  await page.locator('#ask-input').fill('42, 47, 52');
  await page.locator('#ask button').click();
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled, null, { timeout: 240_000 });
  const result = await page.evaluate(() => {
    const state = window.__syw.state, model = state.sources[0].pages[0];
    return { selected: [...state.selected.values()].map(p => p.number).sort((a, b) => a - b),
      detected: model.problems.map(p => p.number), ocr: model.ocr,
      toast: document.querySelector('#toast').textContent };
  });
  await page.screenshot({ path: `${out}/app.png`, fullPage: false });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.selected, [42, 47, 52], 'the request recovers visible exercise labels through OCR');
  assert.ok(ocrRequests.length, 'the real browser OCR code was loaded');
  assert.equal(await page.evaluate(() => {
    const model = window.__syw.state.sources[0].pages[0];
    return model.nativeWords.length > 100 && model.nativeWords.every(w => model.words.includes(w));
  }), true, 'native prose and its exact geometry survive the visual label cross-check');
  assert.equal(await page.evaluate(() => window.__syw.state.sources[0].pages[1].ocrAttempted), false,
    'a complete later native-text page does not need an OCR download/read');

  const crops = await page.evaluate(async exercises => {
    const { cropImage } = await import('/src/document.js');
    const state = window.__syw.state, model = state.sources[0].pages[0];
    const out = [];
    for (const e of exercises.filter(e => [42, 47, 52].includes(e.number))) {
      const p = [...state.selected.values()].find(p => p.number === e.number);
      const crop = await cropImage(model, p.rect, { parts: p.parts });
      const pixels = crop.canvas.getContext('2d').getImageData(0, 0, crop.canvas.width, crop.canvas.height);
      const origin = { x: Math.max(0, Math.floor(p.rect.x0 * model.scale)), y: Math.max(0, Math.floor(p.rect.y0 * model.scale)) };
      const hasInk = e.figure.map(v => {
        const cx = Math.round(v.x * model.scale) - origin.x, cy = Math.round(v.y * model.scale) - origin.y;
        for (let y = Math.max(0, cy - 4); y <= Math.min(pixels.height - 1, cy + 4); y++) {
          for (let x = Math.max(0, cx - 4); x <= Math.min(pixels.width - 1, cx + 4); x++) {
            if (pixels.data[(y * pixels.width + x) * 4] < 150) return true;
          }
        }
        return false;
      });
      // Compare the source's actual dark pixels at each known prose-line position
      // against the crop. OCR text alone cannot prove that a parts mask kept ink.
      const lineInk = Array.from({ length: 4 }, (_, j) => {
        const base = 792 - e.y + 24 + 15 * j;
        const bounds = { x0: e.x + 24, x1: e.x + 245, y0: base - 10, y1: base + 3 };
        let source = 0, retained = 0;
        for (let y = Math.floor(bounds.y0 * model.scale); y < Math.ceil(bounds.y1 * model.scale); y++) {
          for (let x = Math.floor(bounds.x0 * model.scale); x < Math.ceil(bounds.x1 * model.scale); x++) {
            const from = (y * model.img.width + x) * 4;
            if (Math.max(model.img.data[from], model.img.data[from + 1], model.img.data[from + 2]) >= 100) continue;
            source++;
            const cx = x - origin.x, cy = y - origin.y;
            if (cx >= 0 && cy >= 0 && cx < pixels.width && cy < pixels.height && pixels.data[(cy * pixels.width + cx) * 4] < 180) retained++;
          }
        }
        return { line: j + 1, bounds, source, retained };
      });
      out.push({ number: e.number, text: p.text, rect: p.rect, figure: e.figure, hasInk, lineInk, png: crop.canvas.toDataURL('image/png') });
    }
    return out;
  }, exercises);
  for (const crop of crops) {
    await writeFile(`${out}/problem-${crop.number}.png`, Buffer.from(crop.png.split(',')[1], 'base64'));
    assert.match(crop.text, /calculation/i, `problem ${crop.number}: the final sentence is retained`);
    for (const line of crop.lineInk) {
      assert.ok(line.source > 100, `problem ${crop.number}, line ${line.line}: the source contains visible prose ink`);
      assert.ok(line.retained / line.source >= 0.99,
        `problem ${crop.number}, line ${line.line}: crop preserves prose pixels (${line.retained}/${line.source})`);
    }
    for (const vertex of crop.figure) {
      assert.ok(vertex.x >= crop.rect.x0 && vertex.x <= crop.rect.x1 && vertex.y >= crop.rect.y0 && vertex.y <= crop.rect.y1,
        `problem ${crop.number}: the full figure lies inside the crop`);
    }
    assert.ok(crop.hasInk.every(Boolean), `problem ${crop.number}: every figure vertex survives cropping`);
  }
  console.log(`Prose pixels: ${JSON.stringify(crops.map(c => ({ number: c.number, lines: c.lineInk.map(l => `${l.retained}/${l.source}`) })))}`);

  await page.waitForFunction(() => !!window.__syw.state.pdf && /^3 problems on/.test(document.querySelector('#exam-status').textContent), null, { timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(`${out}/recovered-exam.pdf`);
  const exam = await PDFDocument.load(await readFile(`${out}/recovered-exam.pdf`));
  assert.equal(exam.getPageCount(), 2, 'recovered exercises export to a valid two-sided PDF');
  console.log('OCR RECOVERY OK: exact selection, complete problem text and figures, valid downloaded PDF');
  const rasterPage = await page.evaluate(() => window.__syw.state.sources[0].pages[0].canvas.toDataURL('image/png'));
  await page.close();

  // An unavailable OCR download must leave the page usable and allow later pages
  // to finish. Retrying after the connection recovers must work in the same tab.
  const retry = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  retry.on('pageerror', e => errors.push(`retry: ${e.message}`));
  const blockedOcr = /tesseract|traineddata/i;
  const retryRequests = [];
  retry.on('request', request => { if (blockedOcr.test(request.url())) retryRequests.push(request.url()); });
  await retry.route(blockedOcr, route => route.abort('failed'));
  await retry.goto(`${BASE}/`);
  await retry.waitForFunction(() => !!window.__syw);
  await addPdf(retry, bytes);
  const failed = await retry.evaluate(() => {
    const state = window.__syw.state;
    return { pages: state.sources[0].pages.map(p => ({ numbers: p.problems.map(p => p.number),
      rendered: p.canvas.width > 0 && p.canvas.height > 0, warning: p.readWarning })),
      status: document.querySelector('#page-status').textContent };
  });
  assert.equal(failed.pages.length, 2, 'OCR failure does not stop later pages being prepared');
  assert.ok(failed.pages.every(p => p.rendered), 'every rendered page is retained after OCR failure');
  assert.deepEqual(failed.pages[0].numbers, []);
  assert.deepEqual(failed.pages[1].numbers, [61, 62], 'later text-layer exercises remain available');
  assert.ok(failed.pages[0].warning, 'the affected page stores a retryable OCR warning');
  assert.ok(failed.status.trim(), 'the reading warning remains visible after loading');
  await retry.evaluate(() => window.__syw.selectNumbers('61'));
  assert.deepEqual(await selected(retry), [61]);
  await retry.unroute(blockedOcr);
  const attemptsBeforeRetry = retryRequests.length;
  await readVisually(retry);
  const recovered = await retry.evaluate(() => {
    const model = window.__syw.state.sources[0].pages[0];
    return { numbers: model.problems.map(p => p.number), warning: model.readWarning };
  });
  console.log(`Retry result: ${JSON.stringify({ ...recovered, requestsBefore: attemptsBeforeRetry, requestsAfter: retryRequests.length })}`);
  assert.deepEqual(recovered.numbers, [42, 47, 52, 53], 'manual retry recovers the page in the same tab');
  assert.ok(!recovered.warning, 'the successful retry clears the reading warning');
  assert.deepEqual(await selected(retry), [61], 'recovery preserves selections from another page');
  await retry.screenshot({ path: `${out}/retried-page.png`, fullPage: false });
  console.log('OCR RETRY OK: retained page, continued later pages, same-tab recovery, selection preserved');
  await retry.close();

  // A partially readable page already has one anchor, so a manual visual read
  // must add the missing anchors and refresh the selected problem's crop safely.
  const mixed = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  mixed.on('pageerror', e => errors.push(`mixed: ${e.message}`));
  await mixed.goto(`${BASE}/`);
  await mixed.waitForFunction(() => !!window.__syw);
  const mixedBytes = await textbook(mixed, { nativeFirst: true });
  await writeFile(`${out}/mixed-labels.pdf`, mixedBytes);
  await addPdf(mixed, mixedBytes, 'mixed-labels.pdf');
  assert.deepEqual(await mixed.evaluate(() => window.__syw.state.sources[0].pages[0].problems.map(p => p.number)), [42],
    'the original partial text layer detects only the native label');
  await mixed.evaluate(() => window.__syw.selectNumbers('42'));
  await mixed.evaluate(async () => {
    const { manualProblem } = await import('/src/document.js');
    const state = window.__syw.state, model = state.sources[0].pages[0];
    const detected = model.problems.find(p => p.number === 42);
    state.aids.set(detected.group, { kind: 'xy', parts: ['a'] });
    const manual = manualProblem(model, { x0: 68, y0: 374, x1: 255, y1: 430 }, 99);
    state.selected.set(manual.id, manual);
    window.__manualBeforeRead = { id: manual.id, rect: { ...manual.rect } };
  });
  await readVisually(mixed);
  const augmented = await mixed.evaluate(() => {
    const state = window.__syw.state, model = state.sources[0].pages[0];
    const current = model.problems.find(p => p.number === 42);
    const manual = state.selected.get(window.__manualBeforeRead.id);
    return { numbers: model.problems.map(p => p.number),
      selectedIsCurrent: state.selected.get(current.id) === current,
      selectedWidth: current.rect.x1 - current.rect.x0,
      aid: state.aids.get(current.group),
      manualBefore: window.__manualBeforeRead,
      manualAfter: manual && { id: manual.id, rect: manual.rect } };
  });
  assert.deepEqual(augmented.numbers, [42, 47, 52, 53], 'visual reading retains the old anchor and adds missing ones');
  assert.deepEqual((await selected(mixed)).filter(n => n != null), [42], 'existing selected exercise remains selected');
  assert.ok(augmented.selectedIsCurrent, 'selected exercise now uses the recovered crop');
  assert.ok(augmented.selectedWidth < 270, 'the recovered left-column crop does not include the other column');
  assert.deepEqual(augmented.aid, { kind: 'xy', parts: ['a'] }, 'an unambiguous work-area choice is preserved');
  assert.deepEqual(augmented.manualAfter, augmented.manualBefore, 'manual selection identity and crop are preserved');
  console.log('PARTIAL OCR OK: prior anchors retained, missing anchors added, selected crop refreshed, manual box and work area preserved');
  await mixed.close();

  // A declared range with observed labels on both sides of a gap is suspicious
  // even though native prose and some native exercise numbers are readable.
  const ranged = await browser.newPage({ ignoreHTTPSErrors: true });
  ranged.on('pageerror', e => errors.push(`ranged: ${e.message}`));
  await ranged.goto(`${BASE}/`);
  await ranged.waitForFunction(() => !!window.__syw);
  await addPdf(ranged, await textbook(ranged, { nativeNumbers: [42, 53], declaredRange: true }), 'range-with-raster-labels.pdf');
  const checked = await ranged.evaluate(() => {
    const model = window.__syw.state.sources[0].pages[0];
    return { native: model.nativeAnalysis.anchors.map(a => a.number), numbers: model.problems.map(p => p.number),
      attempted: model.ocrAttempted, preserved: model.nativeWords.every(w => model.words.includes(w)) };
  });
  assert.deepEqual(checked.native, [42, 53]);
  assert.deepEqual(checked.numbers, [42, 47, 52, 53], 'only independently visible labels fill the declared range; no absent labels are invented');
  assert.equal(checked.attempted, true, 'an internal declared-range gap triggers an automatic cross-check');
  assert.equal(checked.preserved, true);
  await ranged.close();
  console.log('RANGE CROSS-CHECK OK: native anchors and geometry retained, observed raster labels recovered automatically');

  // Simulate a stale misread stored by an earlier scan reader. A real visual
  // retry must return to the pixels, not protect cached OCR as native PDF text.
  const scan = await browser.newPage({ ignoreHTTPSErrors: true });
  scan.on('pageerror', e => errors.push(`scan: ${e.message}`));
  await scan.goto(`${BASE}/`);
  await scan.waitForFunction(() => !!window.__syw);
  await scan.evaluate(async dataUrl => {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
    await window.__syw.addFiles([new File([bytes], 'scanned-exercises.png', { type: 'image/png' })]);
    const model = window.__syw.state.sources[0].pages[0];
    const old = model.analysis.anchors.find(a => a.number === 42);
    if (!old) throw new Error('The generated scan did not initially detect label 42');
    old.number = 99; old.word.text = '99.';
  }, rasterPage);
  await readVisually(scan);
  const reread = await scan.evaluate(() => {
    const model = window.__syw.state.sources[0].pages[0];
    return { numbers: model.problems.map(p => p.number), nativeCount: model.nativeWords.length,
      stale: model.words.some(w => w.text === '99.'), notice: model.readNotice };
  });
  assert.deepEqual(reread.numbers, [42, 47, 52, 53], 'fresh scan OCR can correct a cached misread label');
  assert.equal(reread.nativeCount, 0);
  assert.equal(reread.stale, false, 'cached OCR words are not merged into the new scan forever');
  assert.doesNotMatch(reread.notice, /PDF text/i);
  await scan.close();
  console.log('SCAN REREAD OK: fresh visual evidence replaces stale OCR without pretending it is native text');
  assert.deepEqual(errors, [], 'no browser application errors');
} finally {
  if (networkFailures.length) console.error(`Network failures:\n${networkFailures.join('\n')}`);
  if (errors.length) console.error(`Browser errors:\n${errors.join('\n')}`);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
