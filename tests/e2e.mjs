import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { imageClipIntervals } from './helpers/pdf-inspection.mjs';

// These are real browser workflows: no app state injection, network mocks, or
// test-only exports. Run with npm run test:e2e after npm install and
// npx playwright install chromium. A local dev server is started if necessary.
// BASE_URL=file:///absolute/path/dist/index.html tests the offline HTML with
// networking disabled. E2E_DIST=1 serves that same bundled HTML over localhost.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.BASE_URL || 'http://localhost:4173';
const targetUrl = new URL(origin);
const offlineFile = targetUrl.protocol === 'file:';
const output = resolve(root, process.env.E2E_OUTPUT || (offlineFile ? 'tests/output/offline' : 'tests/output'));
const results = [];
const browserErrors = [];
const externalRequests = [];
const networkAudit = { offline: offlineFile, requests: 0, schemes: {}, resourceTypes: {}, httpRequests: [], workerUrls: [] };
let server;
let browser;
let page;
let fixture;

await mkdir(output, { recursive: true });

async function isServerUp() {
  try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

async function startServer() {
  if (offlineFile) {
    console.log(`Offline HTML: ${origin} (no server; browser networking disabled)`);
    return;
  }
  if (await isServerUp()) return;
  assert.equal(targetUrl.hostname, 'localhost', 'Set BASE_URL to an already running server when using another host.');
  server = spawn(process.execPath, ['scripts/serve.mjs', ...(process.env.E2E_DIST === '1' ? ['--dist'] : [])], {
    cwd: root,
    env: { ...process.env, PORT: targetUrl.port || '4173', HOST: 'localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', data => { log += data; });
  server.stderr.on('data', data => { log += data; });
  const started = Date.now();
  while (!(await isServerUp())) {
    if (server.exitCode !== null || Date.now() - started > 10000) throw new Error(`Local server failed to start: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(`Local server: ${origin} (owned by E2E; stopped on exit)`);
}

async function step(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'passed', milliseconds: Date.now() - start, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name} (${Date.now() - start} ms)`);
    return detail;
  } catch (error) {
    results.push({ name, status: 'failed', milliseconds: Date.now() - start, error: error.stack || String(error) });
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  }
}

async function idle() {
  await page.locator('#busy').waitFor({ state: 'hidden' });
}

async function fresh() {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.trim());
  await page.locator('#empty-source').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#problem-count').textContent(), '0');
  assert.equal(await page.locator('#number-problems').isChecked(), false, 'Fresh worksheets preserve original source numbering by default.');
}

async function upload(path) {
  await page.locator('#file-input').setInputFiles(resolve(root, path));
  await idle();
  await page.locator('#source-workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#source-canvas').width > 10);
}

const cards = () => page.locator('.problem-card');
const cardIds = () => cards().evaluateAll(nodes => nodes.map(node => node.dataset.id));
const card = id => page.locator(`.problem-card[data-id="${id}"]`);

async function cardCount(expected) {
  await page.waitForFunction(count => document.querySelectorAll('.problem-card').length === count, expected);
  assert.equal(Number(await page.locator('#problem-count').textContent()), expected);
}

async function sourcePage(number) {
  const current = Number((await page.locator('#page-label').textContent()).match(/\d+/)?.[0]);
  const direction = number > current ? '#next-page' : '#prev-page';
  for (let index = current; index !== number; index += Math.sign(number - current)) {
    await page.locator(direction).click();
    await idle();
  }
  assert.match(await page.locator('#page-label').textContent(), new RegExp(`Page ${number} of`));
}

async function setCrop(rect) {
  // Start a valid selection through the UI, then exercise the precise editor.
  if (!(await page.locator('#crop-editor').isVisible())) await page.locator('#full-page-button').click();
  for (const key of ['x', 'y', 'w', 'h']) {
    await page.locator(`#crop-${key}`).fill(String(rect[key] * 100));
    await page.locator(`#crop-${key}`).press('Tab');
  }
}

async function dragCrop(rect) {
  await page.locator('#crop-layer').scrollIntoViewIfNeeded();
  const box = await page.locator('#crop-layer').boundingBox();
  assert.ok(box?.width && box?.height, 'Source crop layer has a measurable rectangle.');
  await page.mouse.move(box.x + box.width * rect.x, box.y + box.height * rect.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (rect.x + rect.w), box.y + box.height * (rect.y + rect.h), { steps: 12 });
  await page.mouse.up();
  await page.locator('#crop-editor').waitFor({ state: 'visible' });
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(Number(await page.locator(`#crop-${key}`).inputValue()) / 100 - rect[key]) < 0.007,
      `Pointer drag preserves the expected ${key} coordinate.`);
  }
}

async function addCrop(rect) {
  if (rect) await setCrop(rect);
  const before = await cards().count();
  await page.locator('#add-problem').click();
  await idle();
  await cardCount(before + 1);
  return (await cardIds()).at(-1);
}

async function field(id, name, value) {
  const control = card(id).locator(`[data-field="${name}"]`);
  if (typeof value === 'boolean') await control.setChecked(value);
  else if (name === 'fit') await control.selectOption(String(value));
  else { await control.fill(String(value)); await control.press('Tab'); }
}

async function preview() {
  await page.locator('#preview-button').click();
  await idle();
  await page.locator('#preview-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#preview-pages canvas').length > 0);
  assert.ok(await page.locator('#export-button').isEnabled(), 'Export is enabled only after a usable PDF is ready.');
  return page.locator('#preview-pages canvas').count();
}

async function exportPdf(filename, button = '#export-button') {
  const download = page.waitForEvent('download');
  await page.locator(button).click();
  const item = await download;
  assert.match(item.suggestedFilename(), /\.pdf$/i);
  const path = resolve(output, filename);
  await item.saveAs(path);
  await idle();
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() > 0, 'The downloaded PDF has printable pages.');
  assert.match(pdf.getCreator(), /Margin/);
  return { path, bytes, pdf };
}

async function exactPreview(bytes) {
  // Render the downloaded PDF independently with the same local PDF renderer.
  // Byte-for-byte pixel equality proves the screen preview matches the actual
  // downloadable document, including all continuation pages.
  const comparison = await page.evaluate(async data => {
    const embedded = globalThis.MARGIN_EMBEDDED;
    const pdfjs = await import(embedded?.pdfjsURL || '/vendor/pdfjs/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(data), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
      isEvalSupported: false,
      ...(embedded?.pdfOptions || {}),
    }).promise;
    try {
      const canvases = [...document.querySelectorAll('#preview-pages canvas')];
      if (pdf.numPages !== canvases.length) return { pages: pdf.numPages, shown: canvases.length, equal: false, reason: 'page count' };
      const pages = [];
      for (let index = 0; index < canvases.length; index++) {
        const actual = canvases[index];
        const source = await pdf.getPage(index + 1);
        const initial = source.getViewport({ scale: 1 });
        const expected = document.createElement('canvas');
        expected.width = actual.width; expected.height = actual.height;
        const expectedContext = expected.getContext('2d', { alpha: false });
        expectedContext.fillStyle = '#ffffff'; expectedContext.fillRect(0, 0, expected.width, expected.height);
        await source.render({ canvasContext: expectedContext, viewport: initial,
          transform: [expected.width / initial.width, 0, 0, expected.height / initial.height, 0, 0], intent: 'print' }).promise;
        const left = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
        const right = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
        let mismatched = 0; let ink = 0;
        for (let pixel = 0; pixel < left.length; pixel++) if (left[pixel] !== right[pixel]) mismatched++;
        for (let pixel = 0; pixel < right.length; pixel += 4) if (Math.min(right[pixel], right[pixel + 1], right[pixel + 2]) < 180) ink++;
        const generatedLabels = (await source.getTextContent()).items.map(item => item.str).filter(text => /^\d+\.(?: \(continued\))?$/.test(text));
        pages.push({ number: index + 1, width: expected.width, height: expected.height, mismatched, ink, generatedLabels });
        expected.width = expected.height = 1;
      }
      return { pages: pdf.numPages, shown: canvases.length, equal: pages.every(item => item.mismatched === 0), detail: pages };
    } finally { await pdf.destroy(); }
  }, [...bytes]);
  assert.equal(comparison.equal, true, `Downloaded PDF differs from preview: ${JSON.stringify(comparison)}`);
  assert.ok(comparison.detail.every(item => item.ink > 100), 'Every exported page contains rendered content.');
  assert.ok(comparison.detail.every(item => item.generatedLabels.length === 0), 'Default exports add no duplicate numeric question labels.');
  return comparison;
}

function crop(id) {
  const entry = fixture.crops.find(item => item.id === id);
  assert.ok(entry, `Fixture manifest includes ${id}.`);
  return entry.rect;
}

async function mainWorkflow() {
  let first;
  let suggested;
  let combined;
  let imageProblem;
  let textProblem;
  let initialPages;
  await step('Landing, source PDF upload, pointer crop, and precise crop correction', async () => {
    await fresh();
    assert.ok(await page.locator('#export-top').isDisabled());
    await page.screenshot({ path: resolve(output, '01-landing.png'), fullPage: true });
    await upload('public/samples/sample.pdf');
    assert.match(await page.locator('#page-label').textContent(), /Page 1 of 4/);
    await dragCrop(crop('q1'));
    await setCrop(crop('q1'));
    first = await addCrop();
    assert.ok(await card(first).locator('img').count() > 0, 'Selected original content has a thumbnail.');
  });

  await step('Two-column automatic suggestions are selectable and correctable', async () => {
    await sourcePage(2);
    await page.locator('#detect-button').click();
    await idle();
    await page.locator('#suggestion-bar').waitFor({ state: 'visible' });
    const suggestions = page.locator('.suggestion');
    await suggestions.first().waitFor({ state: 'visible' });
    const rectangles = await suggestions.evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); const page = node.parentElement.getBoundingClientRect();
      return { x: (box.x - page.x) / page.width, width: box.width / page.width };
    }));
    assert.ok(rectangles.some(rect => rect.x < 0.3) && rectangles.some(rect => rect.x > 0.45), 'Suggestions cover both columns.');
    assert.ok(rectangles.every(rect => rect.width < 0.58), 'No two-column suggestion swallows both columns.');
    await suggestions.first().click();
    const suggestedWidth = Number(await page.locator('#crop-w').inputValue());
    await page.locator('#crop-w').fill(String(Math.max(1, suggestedWidth - 0.5)));
    await page.locator('#crop-w').press('Tab');
    assert.equal(Number(await page.locator('#crop-w').inputValue()), Math.max(1, suggestedWidth - 0.5));
    suggested = await addCrop();
    return { suggestions: rectangles.length };
  });

  await step('Scanned continuation is cropped manually and appended across source pages', async () => {
    await sourcePage(3);
    combined = await addCrop(crop('q9-start'));
    await sourcePage(4);
    await page.locator('#detect-button').click();
    await idle();
    assert.equal(await page.locator('.suggestion').count(), 0, 'Image-only scans produce no invented OCR suggestions.');
    assert.match(`${await page.locator('#notice').textContent()} ${await page.locator('#suggestion-bar').textContent()}`, /manual|scan|no .*question|no .*number/i);
    if (await page.locator('#clear-crop').isVisible()) await page.locator('#clear-crop').click();
    await dragCrop(crop('q9-continuation'));
    await page.locator('#append-region').click();
    await idle();
    await cardCount(3);
    assert.equal(await card(combined).locator('[data-action="edit-region"]').count(), 2, 'Both source regions remain in the same problem.');
    assert.match(await card(combined).textContent(), /[Pp]age 3|p\. 3/);
    assert.match(await card(combined).textContent(), /[Pp]age 4|p\. 4/);
    // Region reordering and deletion are separate from worksheet card ordering.
    const editButtons = card(combined).locator('[data-action="edit-region"]');
    const regionIds = await editButtons.evaluateAll(nodes => nodes.map(node => node.dataset.region));
    await card(combined).locator('[data-action="region-up"]').last().click();
    assert.deepEqual(await editButtons.evaluateAll(nodes => nodes.map(node => node.dataset.region)), [...regionIds].reverse());
    await card(combined).locator('[data-action="region-down"]').first().click();
    assert.deepEqual(await editButtons.evaluateAll(nodes => nodes.map(node => node.dataset.region)), regionIds);
    await setCrop(crop('q9-continuation'));
    await page.locator('#append-region').click();
    await idle();
    assert.equal(await editButtons.count(), 3);
    await card(combined).locator('[data-action="remove-region"]').last().click();
    assert.equal(await editButtons.count(), 2);
  });

  await step('Image and Unicode text inputs join the same worksheet', async () => {
    await upload('public/samples/example.png');
    assert.equal(await page.locator('#source-select option').count(), 2);
    await page.locator('#full-page-button').click();
    imageProblem = await addCrop();
    await page.locator('#text-button-2').click();
    await page.locator('#problem-text').fill('Solve x² − 5x + 6 = 0.\nExplain why √9 = 3 and 2π > 6.');
    await page.locator('#add-text').click();
    await idle();
    await page.locator('#text-dialog').waitFor({ state: 'hidden' });
    await cardCount(5);
    textProblem = (await cardIds()).at(-1);
    assert.match(await card(textProblem).textContent(), /[Tt]ext/);
  });

  await step('Worksheet card ordering, removal, and existing-region edits persist', async () => {
    const initial = await cardIds();
    await card(textProblem).locator('[data-action="up"]').click();
    assert.deepEqual(await cardIds(), [first, suggested, combined, textProblem, imageProblem]);
    await card(textProblem).locator('[data-action="down"]').click();
    assert.deepEqual(await cardIds(), initial);
    await card(imageProblem).locator('[data-action="remove"]').click();
    await cardCount(4);
    assert.deepEqual(await cardIds(), [first, suggested, combined, textProblem]);
    await card(first).locator('[data-action="edit-region"]').first().click();
    await idle();
    const width = Number(await page.locator('#crop-w').inputValue());
    await page.locator('#crop-w').fill(String(width - 0.2));
    await page.locator('#crop-w').press('Tab');
    await page.locator('#update-region').click();
    await idle();
    await cardCount(4);
    await card(first).locator('[data-action="edit-region"]').first().click();
    await idle();
    assert.ok(Math.abs(Number(await page.locator('#crop-w').inputValue()) - (width - 0.2)) < 0.11);
    await page.locator('#clear-crop').click();
  });

  await step('Writing-space, scale, page-break, and print settings affect the exact PDF preview', async () => {
    await field(first, 'space', 1.75);
    await field(first, 'scale', 125);
    await field(suggested, 'space', 0.5);
    await field(suggested, 'scale', 70);
    await field(combined, 'space', 2);
    await field(combined, 'pageBreak', true);
    await field(textProblem, 'space', 1);
    await page.locator('#worksheet-title').fill('Integration worksheet — α');
    await page.locator('#worksheet-title').press('Tab');
    await page.locator('#page-margin').selectOption('54');
    await page.screenshot({ path: resolve(output, 'workspace.png'), fullPage: true });
    initialPages = await preview();
    assert.ok(initialPages >= 2, 'Page-break and writing-space choices create multiple printable pages.');
    assert.match(await page.locator('#layout-warnings').textContent(), /Problem 3[^.]*dpi/i,
      'The scanned continuation warns about its actual embedded-image print resolution.');
    const exported = await exportPdf('workflow.pdf');
    assert.equal(exported.pdf.getPageCount(), initialPages);
    assert.equal(exported.pdf.getTitle(), 'Integration worksheet — α');
    for (const pdfPage of exported.pdf.getPages()) assert.deepEqual(pdfPage.getSize(), { width: 612, height: 792 });
    const pixels = await exactPreview(exported.bytes);
    await page.screenshot({ path: resolve(output, 'preview.png'), fullPage: true });
    return { pdf: 'workflow.pdf', bytes: exported.bytes.length, pages: initialPages, pixelComparison: pixels };
  });

  await step('Editing after preview regenerates a fresh export with updated title and writing space', async () => {
    await page.locator('#back-to-edit').click();
    await field(first, 'space', 10);
    await page.locator('#worksheet-title').fill('Revised worksheet');
    await page.locator('#worksheet-title').press('Tab');
    const exported = await exportPdf('workflow-revised.pdf', '#export-top');
    assert.equal(exported.pdf.getTitle(), 'Revised worksheet');
    assert.ok(exported.pdf.getPageCount() > initialPages, 'Increasing requested writing space regenerates pagination.');
    await page.locator('#preview-tab').click();
    await idle();
    const pixels = await exactPreview(exported.bytes);
    return { pdf: 'workflow-revised.pdf', pages: exported.pdf.getPageCount(), pixelComparison: pixels };
  });
}

async function oversizedWorkflow() {
  await step('Oversized source flows without clipping, then explicitly fits to one page', async () => {
    await fresh();
    await upload('public/samples/oversize.pdf');
    await page.locator('#full-page-button').click();
    const id = await addCrop();
    await field(id, 'space', 0);
    const pages = await preview();
    assert.ok(pages > 1, 'Tall original content continues onto additional output pages.');
    assert.match(await page.locator('#layout-warnings').textContent(), /continu|split|overflow/i);
    const flowing = await exportPdf('oversize-flow.pdf');
    assert.equal(flowing.pdf.getPageCount(), pages);
    const fragments = imageClipIntervals(flowing.pdf);
    assert.equal(fragments.length, pages, 'Every continuation page contains a source-image clip.');
    assert.equal(new Set(fragments.map(fragment => fragment.image)).size, 1, 'Continuations reuse one intact embedded source image.');
    assert.ok(Math.abs(fragments[0].pixelHeight / fragments[0].pixelWidth - fixture.oversize.heightPt / fixture.oversize.widthPt) < 0.003,
      'The embedded crop retains the original source aspect ratio.');
    let sourceEnd = 0;
    for (const fragment of fragments) {
      assert.ok(Math.abs(fragment.sourceTop - sourceEnd) < 1e-8, 'Continuation clips contain no missing or duplicated source interval.');
      sourceEnd = fragment.sourceTop + fragment.sourceHeight;
    }
    assert.ok(Math.abs(sourceEnd - 1) < 1e-8, 'The exported clips include the complete bottom of the original source.');
    const flowPixels = await exactPreview(flowing.bytes);
    await page.screenshot({ path: resolve(output, '04-oversize-flow.png'), fullPage: true });
    await page.locator('#back-to-edit').click();
    await field(id, 'fit', 'shrink');
    assert.equal(await preview(), 1, 'Fit to one page is an explicit, visible scaling choice.');
    assert.match(await page.locator('#layout-warnings').textContent(), /scal|readab|small|%/i);
    const fitted = await exportPdf('oversize-fit.pdf');
    assert.equal(fitted.pdf.getPageCount(), 1);
    const fitPixels = await exactPreview(fitted.bytes);
    await page.screenshot({ path: resolve(output, '05-oversize-fit.png'), fullPage: true });
    return { flowPages: pages, fitPages: 1, fragments, flowPixelComparison: flowPixels, fitPixelComparison: fitPixels };
  });
}

async function recoveryWorkflow() {
  await step('Standalone image content survives crop, preview, and PDF export', async () => {
    await fresh();
    await upload('public/samples/example.png');
    const id = await addCrop({ x: 0.05, y: 0.08, w: 0.55, h: 0.35 });
    await field(id, 'space', 0);
    await field(id, 'scale', 200);
    assert.equal(await preview(), 1);
    assert.match(await page.locator('#layout-warnings').textContent(), /about 150 dpi/i,
      'Enlarging the image warns about its effective printed resolution.');
    const exported = await exportPdf('image-input.pdf');
    assert.equal(exported.pdf.getPageCount(), 1);
    const pixels = await exactPreview(exported.bytes);
    return { pdf: 'image-input.pdf', pages: 1, pixelComparison: pixels };
  });

  await step('Corrupt PDF reports an actionable error and a subsequent valid upload recovers', async () => {
    await fresh();
    await page.locator('#file-input').setInputFiles(resolve(root, 'tests/fixtures/corrupt.pdf'));
    await idle();
    await page.locator('#notice').waitFor({ state: 'visible' });
    assert.match(await page.locator('#notice').textContent(), /Unable to open PDF|invalid PDF|PDF.*(fail|error)/i);
    await cardCount(0);
    await upload('public/samples/rotated.pdf');
    const dimensions = await page.locator('#source-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    assert.ok(dimensions.width > dimensions.height, 'Rotated PDF respects its displayed page orientation.');
    await page.locator('#full-page-button').click();
    const id = await addCrop();
    await field(id, 'space', 0);
    await page.locator('#paper-size').selectOption('a4');
    await page.locator('#name-line').uncheck();
    await preview();
    const exported = await exportPdf('rotated-a4.pdf');
    for (const pdfPage of exported.pdf.getPages()) {
      assert.ok(Math.abs(pdfPage.getWidth() - 595.276) < 0.001);
      assert.ok(Math.abs(pdfPage.getHeight() - 841.89) < 0.001);
    }
    await exactPreview(exported.bytes);
    return { pdf: 'rotated-a4.pdf', pages: exported.pdf.getPageCount(), sourceCanvas: dimensions };
  });

  await step('Sample shortcut and narrow-screen editing remain usable', async () => {
    await fresh();
    await page.locator('#sample-button').click();
    await idle();
    await page.locator('#source-workspace').waitFor({ state: 'visible' });
    assert.match(await page.locator('#page-label').textContent(), /Page 1 of 4/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#full-page-button').click();
    const id = await addCrop();
    await field(id, 'space', 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true,
      'The narrow-screen app does not cause horizontal page overflow.');
    await page.screenshot({ path: resolve(output, '06-mobile-editor.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
  });
}

let failed;
try {
  fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/manifest.json'), 'utf8'));
  await startServer();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true, offline: offlineFile });
  // Each fresh() navigation is an independent fixture scenario. Persistence is
  // exercised separately by preferences-shortcuts.e2e.mjs, so its user defaults
  // must not carry writing-space or page-break choices into another scenario.
  await context.addInitScript(() => {
    try { localStorage.removeItem('show-your-work.preferences.v1'); } catch {}
  });
  // Context-level auditing includes requests from the page and its workers.
  // Keep only short network URLs; embedded data/blob assets can be megabytes.
  context.on('requestfailed', request => browserErrors.push({ type: 'requestfailed', message: `${request.url().slice(0, 300)} ${request.failure()?.errorText}` }));
  context.on('request', request => {
    const url = new URL(request.url());
    networkAudit.requests++;
    networkAudit.schemes[url.protocol] = (networkAudit.schemes[url.protocol] || 0) + 1;
    networkAudit.resourceTypes[request.resourceType()] = (networkAudit.resourceTypes[request.resourceType()] || 0) + 1;
    if (['http:', 'https:'].includes(url.protocol)) {
      networkAudit.httpRequests.push(request.url());
      if (url.origin !== targetUrl.origin) externalRequests.push(request.url());
    }
  });
  page = await context.newPage();
  page.on('worker', worker => networkAudit.workerUrls.push(worker.url().slice(0, 300)));
  page.on('dialog', dialog => dialog.accept());
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => browserErrors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push({ type: 'console', message: message.text() }); });
  await mainWorkflow();
  await oversizedWorkflow();
  await recoveryWorkflow();
  await step('No uncaught browser errors, failed requests, or external file uploads', async () => {
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(externalRequests, []);
    if (offlineFile) assert.deepEqual(networkAudit.httpRequests, [], 'The standalone file works without any HTTP(S) request, including worker resources.');
    return { browserErrors: 0, externalRequests: 0, ...networkAudit };
  });
} catch (error) {
  failed = error;
  console.error(error.stack || error);
} finally {
  await writeFile(resolve(output, 'e2e-results.json'), JSON.stringify({
    passed: !failed, runAt: new Date().toISOString(), origin, results, browserErrors, externalRequests, networkAudit,
    ...(failed ? { failure: failed.stack || String(failed) } : {}),
  }, null, 2));
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
}
if (failed) process.exitCode = 1;
else console.log(`All ${results.length} browser workflow checks passed. Artifacts: ${output}`);
