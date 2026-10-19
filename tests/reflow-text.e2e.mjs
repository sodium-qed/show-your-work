import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { imageClipIntervals } from './helpers/pdf-inspection.mjs';

// Real browser actions exercise reviewed prose reflow and mixed text/image
// problems. PDF checks inspect downloaded bytes independently of app state.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.BASE_URL || 'http://localhost:4173';
const target = new URL(origin);
const offline = target.protocol === 'file:';
const output = resolve(root, process.env.E2E_OUTPUT || (offline ? 'tests/output/text-offline' : 'tests/output/text'));
const results = [], errors = [], externalRequests = [];
const audit = { offline, httpRequests: [], workerUrls: [] };
let browser, context, page, server, fixture, manifest;
await mkdir(output, { recursive: true });

async function serverReady() {
  try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
async function startServer() {
  if (offline || await serverReady()) return;
  assert.equal(target.hostname, 'localhost');
  server = spawn(process.execPath, ['scripts/serve.mjs', ...(process.env.E2E_DIST === '1' ? ['--dist'] : [])], {
    cwd: root, env: { ...process.env, HOST: 'localhost', PORT: target.port || '4173' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
  const started = Date.now();
  while (!(await serverReady())) {
    if (server.exitCode !== null || Date.now() - started > 10000) throw new Error(`Test server failed: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    results.push({ name, status: 'passed', milliseconds: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    const diagnostics = {};
    for (const [key, selector] of [['notice', '#notice'], ['busy', '#busy-text']]) {
      try { diagnostics[key] = await page.locator(selector).textContent({ timeout: 2000 }); }
      catch (failure) { diagnostics[key] = failure.message.split('\n')[0]; }
    }
    results.push({ name, status: 'failed', error: error.stack || String(error), diagnostics });
    await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    throw error;
  }
}
async function fresh() {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true, offline });
  await context.addInitScript(() => { try { localStorage.removeItem('show-your-work.preferences.v1'); } catch {} });
  context.on('requestfailed', request => errors.push(`request: ${request.url().slice(0, 250)} ${request.failure()?.errorText}`));
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol)) {
      audit.httpRequests.push(request.url());
      if (url.origin !== target.origin) externalRequests.push(request.url());
    }
  });
  page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('Browser page crashed.'));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('worker', worker => audit.workerUrls.push(worker.url().slice(0, 250)));
  page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(30000);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.trim());
  assert.equal(await page.locator('.problem-card').count(), 0);
}
const idle = () => page.locator('#busy').waitFor({ state: 'hidden' });
const cards = () => page.locator('.problem-card');
const card = id => page.locator(`.problem-card[data-id="${id}"]`);
const cardIds = () => cards().evaluateAll(nodes => nodes.map(node => node.dataset.id));
const regionIds = id => card(id).locator('[data-action="remove-region"]').evaluateAll(nodes => nodes.map(node => node.dataset.region));
const editText = (problem, region) => card(problem).locator(`[data-action="edit-text"][data-region="${region}"]`);
async function count(expected) {
  await page.waitForFunction(value => document.querySelectorAll('.problem-card').length === value, expected);
}
async function upload(path) {
  await page.locator('#file-input').setInputFiles(resolve(root, path));
  await idle(); await page.locator('#source-workspace').waitFor({ state: 'visible' });
}
async function selectCrop(rect) {
  await page.locator('#full-page-button').click();
  for (const field of ['x', 'y', 'w', 'h']) {
    await page.locator(`#crop-${field}`).fill(String(rect[field] * 100));
    await page.locator(`#crop-${field}`).press('Tab');
  }
}
const cropValues = () => page.locator('#crop-editor input').evaluateAll(nodes => nodes.map(node => [node.id, node.value]));
async function field(id, name, value) {
  const input = card(id).locator(`[data-field="${name}"]`);
  if (typeof value === 'boolean') await input.setChecked(value);
  else if (name === 'fit') await input.selectOption(value);
  else { await input.fill(String(value)); await input.press('Tab'); }
}
const values = id => card(id).evaluate(node => ({
  space: Number(node.querySelector('[data-field="space"]').value), scale: Number(node.querySelector('[data-field="scale"]').value),
  fit: node.querySelector('[data-field="fit"]').value, pageBreak: node.querySelector('[data-field="pageBreak"]').checked,
}));
async function queueSnapshot() {
  const state = await cards().evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.id,
    controls: [...node.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.type === 'checkbox' ? input.checked : input.value]),
    regions: [...node.querySelectorAll('.region-thumb')].map(region => ({ id: region.querySelector('[data-action="remove-region"]').dataset.region, thumbnail: region.querySelector('img').src })),
  })));
  for (const problem of state) for (const region of problem.regions) region.thumbnail = createHash('sha256').update(region.thumbnail).digest('hex');
  return state;
}
async function openReflow(rect) {
  await selectCrop(rect); await page.locator('#reflow-text').click(); await idle();
  await page.locator('#text-dialog').waitFor({ state: 'visible' });
}
async function submitText() {
  await page.locator('#add-text').click(); await idle(); await page.locator('#text-dialog').waitFor({ state: 'hidden' });
}
async function cancelText() {
  await page.locator('#text-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#text-dialog').waitFor({ state: 'hidden' });
}
const words = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function geometry(pdf) {
  const rectangles = [];
  for (const [index, pdfPage] of pdf.getPages().entries()) {
    const contents = pdfPage.node.Contents();
    for (let i = 0; i < contents.size(); i++) {
      const operators = Buffer.from(decodePDFRawStream(pdf.context.lookup(contents.get(i))).decode()).toString();
      for (const match of operators.matchAll(/^([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re$/gm)) {
        const [x, y, width, height] = match.slice(1).map(Number);
        rectangles.push({ page: index + 1, x, y, width, height });
      }
    }
  }
  const intervals = imageClipIntervals(pdf);
  assert.equal(rectangles.length, intervals.length);
  return intervals.map((source, index) => {
    const [number, generation] = source.image.split(' ').map(Number);
    const image = pdf.context.lookup(PDFRef.of(number, generation));
    assert.equal(rectangles[index].page, source.page);
    return { ...rectangles[index], ...source, imageHash: createHash('sha256').update(image.getContents()).digest('hex') };
  });
}
async function exactPreview(bytes) {
  const comparison = await page.evaluate(async bytes => {
    const embedded = globalThis.MARGIN_EMBEDDED;
    const pdfjs = await import(embedded?.pdfjsURL || '/vendor/pdfjs/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', isEvalSupported: false,
      ...(embedded?.pdfOptions || {}) }).promise;
    try {
      const actual = [...document.querySelectorAll('#preview-pages canvas')];
      if (actual.length !== pdf.numPages) return { equal: false, pages: pdf.numPages, shown: actual.length };
      const detail = [];
      for (let index = 0; index < actual.length; index++) {
        const source = await pdf.getPage(index + 1), expected = document.createElement('canvas');
        const viewport = source.getViewport({ scale: 1 });
        expected.width = actual[index].width; expected.height = actual[index].height;
        const ctx = expected.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, expected.width, expected.height);
        await source.render({ canvasContext: ctx, viewport, transform: [expected.width / viewport.width, 0, 0, expected.height / viewport.height, 0, 0], intent: 'print' }).promise;
        const left = actual[index].getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
        const right = ctx.getImageData(0, 0, expected.width, expected.height).data;
        let mismatched = 0, ink = 0;
        for (let p = 0; p < left.length; p++) if (left[p] !== right[p]) mismatched++;
        for (let p = 0; p < right.length; p += 4) if (Math.min(right[p], right[p + 1], right[p + 2]) < 180) ink++;
        const text = (await source.getTextContent()).items.map(item => item.str);
        const renderHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', right))].map(value => value.toString(16).padStart(2, '0')).join('');
        detail.push({ page: index + 1, width: expected.width, height: expected.height, mismatched, ink, continued: text.includes('Continued'), renderHash });
        expected.width = expected.height = 1;
      }
      return { pages: pdf.numPages, equal: detail.every(item => item.mismatched === 0), detail };
    } finally { await pdf.destroy(); }
  }, [...bytes]);
  assert.equal(comparison.equal, true, 'Every downloaded PDF page exactly matches the rendered preview.');
  assert.ok(comparison.detail.every(item => item.ink > 100), 'Every exported page has visible content.');
  return comparison;
}
async function exportPdf(filename, { immediate = false } = {}) {
  console.log(`Exporting ${filename}`);
  if (!immediate) { await page.locator('#preview-button').click(); await idle(); }
  const download = page.waitForEvent('download');
  await page.locator(immediate ? '#export-top' : '#export-button').click();
  const item = await download, path = resolve(output, filename); await item.saveAs(path); await idle();
  if (immediate) { await page.locator('#preview-tab').click(); await idle(); }
  const bytes = await readFile(path), pdf = await PDFDocument.load(bytes);
  const pixels = await exactPreview(bytes);
  return { pdf, pixels, crops: geometry(pdf), pages: pdf.getPageCount() };
}
function unchangedImage(crops, original) {
  const matches = crops.filter(crop => crop.imageHash === original.imageHash);
  assert.equal(matches.length, 1, 'An original source crop remains present exactly once.');
  const image = matches[0];
  for (const key of ['width', 'height', 'pixelWidth', 'pixelHeight', 'sourceTop', 'sourceHeight']) {
    assert.ok(Math.abs(image[key] - original[key]) < 1e-7, `Text operations preserve the original crop ${key}.`);
  }
}

let failure, originalId, originalRegion, mixedId, proseRegion, equationRegion, appendedRegion, originalSnapshot, firstExport, editedExport;
let reviewedText, finalText;
try {
  fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/reflow.json'), 'utf8'));
  manifest = JSON.parse(await readFile(resolve(root, 'tests/fixtures/manifest.json'), 'utf8'));
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  await step('Selected digital prose opens an editable review without changing the original crop', async () => {
    await fresh(); await upload('tests/fixtures/reflow.pdf');
    await page.locator('#page-margin').selectOption('54');
    await selectCrop(fixture.crops.prose.rect); await page.locator('#add-problem').click(); await idle(); await count(1);
    originalId = (await cardIds())[0]; originalRegion = (await regionIds(originalId))[0];
    await field(originalId, 'space', 0.5); await field(originalId, 'scale', 30); await field(originalId, 'fit', 'shrink');
    originalSnapshot = (await queueSnapshot())[0];
    await openReflow(fixture.crops.prose.rect);
    assert.equal(words(await page.locator('#problem-text').inputValue()), words(fixture.proseText || fixture.sourceText));
    assert.equal(await cards().count(), 1, 'Reading selected text never bypasses mandatory review.');
    assert.deepEqual((await queueSnapshot())[0], originalSnapshot);
    assert.equal(await page.locator('#problem-text').isEditable(), true);
    assert.match(await page.locator('#text-dialog').textContent(), /review|check/i);
    await page.screenshot({ path: resolve(output, 'review-dialog.png'), fullPage: true });
    return { extractedWords: words(await page.locator('#problem-text').inputValue()).split(' ').length, originalRegion };
  });

  await step('Reviewed prose starts at readable full width and Q appends its original equation crop', async () => {
    reviewedText = `${words(fixture.proseText || fixture.sourceText)} Explain your reasoning in two sentences.`;
    await page.locator('#problem-text').fill(reviewedText); await page.locator('#text-target').selectOption('new');
    await submitText(); await count(2); mixedId = (await cardIds())[1]; proseRegion = (await regionIds(mixedId))[0];
    assert.deepEqual(await values(mixedId), { space: 0.5, scale: 100, fit: 'flow', pageBreak: false }, 'A newly reflowed problem avoids inherited tiny scale and shrink settings.');
    assert.equal(await editText(mixedId, proseRegion).count(), 1);
    await selectCrop(fixture.crops.equation.rect); await page.locator('#crop-layer').focus(); await page.keyboard.press('q'); await idle();
    await count(2); const ids = await regionIds(mixedId); assert.equal(ids.length, 2); [proseRegion, equationRegion] = ids;
    assert.equal(await card(mixedId).locator(`[data-action="edit-region"][data-region="${equationRegion}"]`).count(), 1);
    firstExport = await exportPdf('reflow-initial.pdf');
    assert.equal(firstExport.crops.length, 3);
    const prose = firstExport.crops[1];
    assert.ok(Math.abs(prose.width - (612 - 2 * 54)) < 1e-7, 'Reviewed prose uses the actual printable width.');
    assert.ok(prose.width > firstExport.crops[0].width * 3, 'The narrow original paragraph is genuinely reflowed across the page.');
    assert.ok(prose.pixelWidth > prose.pixelHeight, 'The reviewed paragraph wraps into a broad text region.');
    await page.screenshot({ path: resolve(output, 'reflow-preview.png'), fullPage: true });
    await page.locator('#back-to-edit').click();
    return { pages: firstExport.pages, pixelComparison: firstExport.pixels, proseDimensions: [prose.width, prose.height], originalImageHashes: [firstExport.crops[0].imageHash, firstExport.crops[2].imageHash] };
  });

  await step('Appending and editing text preserve problem IDs, region order, and individual writing settings', async () => {
    await field(mixedId, 'space', 1.25); await field(mixedId, 'scale', 85); await field(mixedId, 'fit', 'shrink');
    const beforeValues = await values(mixedId), beforeIds = await regionIds(mixedId);
    await openReflow(fixture.crops.prose.rect); await page.locator('#text-target').selectOption('append');
    assert.match(await page.locator('#text-dialog').textContent(), /85\s*%/, 'Appending explains the selected problem’s current scale.');
    await page.locator('#problem-text').fill('Explain why √9 = 3 and check the pump model at t = 0.'); await submitText();
    await count(2); const appended = await regionIds(mixedId); assert.deepEqual(appended.slice(0, 2), beforeIds); assert.equal(appended.length, 3); appendedRegion = appended[2];
    assert.deepEqual(await values(mixedId), beforeValues);
    await editText(mixedId, proseRegion).click(); await page.locator('#text-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#problem-text').inputValue(), reviewedText);
    assert.equal(await page.locator('#text-target').isVisible(), false);
    assert.match(await page.locator('#add-text').textContent(), /Save text/);
    finalText = reviewedText.replace('two sentences', 'three clear sentences');
    await page.locator('#problem-text').fill(finalText); await submitText();
    assert.deepEqual(await cardIds(), [originalId, mixedId]); assert.deepEqual(await regionIds(mixedId), appended);
    assert.deepEqual(await values(mixedId), beforeValues); assert.deepEqual((await queueSnapshot())[0], originalSnapshot);
    await editText(mixedId, proseRegion).click(); assert.equal(await page.locator('#problem-text').inputValue(), finalText); await cancelText();
    editedExport = await exportPdf('reflow-edited.pdf', { immediate: true });
    unchangedImage(editedExport.crops, firstExport.crops[0]);
    // The equation follows the selected card's deliberate 85% size change, but
    // its original image bytes, source coverage, and aspect ratio stay intact.
    const equation = editedExport.crops.find(crop => crop.imageHash === firstExport.crops[2].imageHash);
    assert.ok(equation); assert.equal(equation.pixelWidth, firstExport.crops[2].pixelWidth); assert.equal(equation.pixelHeight, firstExport.crops[2].pixelHeight);
    assert.ok(Math.abs(equation.width / equation.height - firstExport.crops[2].width / firstExport.crops[2].height) < 1e-7);
    assert.ok(Math.abs(equation.width - firstExport.crops[2].width * 0.85) < 1e-7);
    assert.notEqual(editedExport.crops[1].imageHash, firstExport.crops[1].imageHash, 'Saving edited prose regenerates its exported image.');
    await page.locator('#back-to-edit').click();
    return { pages: editedExport.pages, pixelComparison: editedExport.pixels, regionOrder: appended, settings: beforeValues };
  });

  await step('Cancel, validation failures, and P/Q in a review dialog never mutate crops or saved text', async () => {
    await selectCrop(fixture.crops.prose.rect); const beforeCrop = await cropValues(), before = await queueSnapshot();
    await page.locator('#reflow-text').click(); await idle(); await page.locator('#text-dialog').waitFor({ state: 'visible' });
    await page.locator('#problem-text').fill('Unsubmitted pq draft.');
    await page.locator('#text-dialog').getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('p'); await page.keyboard.press('q');
    assert.deepEqual(await queueSnapshot(), before);
    await cancelText(); assert.deepEqual(await queueSnapshot(), before); assert.deepEqual(await cropValues(), beforeCrop);
    await editText(mixedId, proseRegion).click(); await page.locator('#problem-text').fill(''); await page.locator('#add-text').click();
    assert.equal(await page.locator('#text-dialog').isVisible(), true); assert.deepEqual(await queueSnapshot(), before);
    await page.keyboard.press('Escape'); await page.locator('#text-dialog').waitFor({ state: 'hidden' });
    await editText(mixedId, proseRegion).click(); assert.equal(await page.locator('#problem-text').inputValue(), finalText);
    await page.locator('#problem-text').fill('Cancelled replacement.'); await cancelText();
    assert.deepEqual(await queueSnapshot(), before); assert.deepEqual(await cropValues(), beforeCrop);
    await editText(mixedId, proseRegion).click(); assert.equal(await page.locator('#problem-text').inputValue(), finalText); await cancelText();
    const oversizedDraft = Array.from({ length: 150 }, (_, index) => `Draft line ${index + 1}`).join('\n');
    assert.ok(oversizedDraft.length < 6000, 'The draft passes the textarea length limit but exceeds the renderer’s line capacity.');
    await editText(mixedId, proseRegion).click(); await page.locator('#problem-text').fill(oversizedDraft);
    await page.locator('#add-text').click(); await idle(); await page.locator('#text-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#problem-text').inputValue(), oversizedDraft, 'A rendering failure keeps the complete editable draft.');
    assert.match(await page.locator('#text-review-note').textContent(), /too long|split.*multiple|split.*smaller/i, 'The reopened modal itself explains the rendering failure.');
    assert.match(await page.locator('#add-text').textContent(), /Save text/);
    assert.equal(await page.locator('#text-target').isVisible(), false, 'Failure recovery preserves the editing target.');
    assert.deepEqual(await queueSnapshot(), before); assert.deepEqual(await cropValues(), beforeCrop);
    await cancelText(); await editText(mixedId, proseRegion).click();
    assert.equal(await page.locator('#problem-text').inputValue(), finalText); await cancelText();
  });

  await step('Long edited prose continues through the exported pages without losing source rows or equations', async () => {
    await field(mixedId, 'scale', 100); await field(mixedId, 'fit', 'flow');
    const settings = await values(mixedId), ids = await regionIds(mixedId);
    const longText = Array.from({ length: 42 }, (_, index) => `Step ${String(index + 1).padStart(2, '0')}. Explain how the garden pump changes the volume.`).join('\n');
    await editText(mixedId, proseRegion).click(); await page.locator('#problem-text').fill(longText); await submitText();
    assert.deepEqual(await regionIds(mixedId), ids); assert.deepEqual(await values(mixedId), settings);
    await editText(mixedId, proseRegion).click(); assert.equal(await page.locator('#problem-text').inputValue(), longText); await cancelText();
    const exported = await exportPdf('reflow-continuation.pdf', { immediate: true });
    assert.ok(exported.pages > firstExport.pages, 'Long prose flows onto additional pages at its chosen print size.');
    assert.ok(exported.pixels.detail.some(item => item.continued));
    unchangedImage(exported.crops, firstExport.crops[0]); unchangedImage(exported.crops, firstExport.crops[2]);
    const longHash = exported.crops.find(crop => crop.imageHash !== firstExport.crops[0].imageHash).imageHash;
    const fragments = exported.crops.filter(crop => crop.imageHash === longHash);
    assert.ok(fragments.length > 1, 'The edited text itself crosses a page boundary.');
    let end = 0;
    for (const fragment of fragments) {
      assert.ok(Math.abs(fragment.sourceTop - end) < 1e-7, 'Every source text row is included once, in order.');
      assert.ok(Math.abs(fragment.width - 504) < 1e-7, 'Continuation never shrinks the reviewed prose.');
      end = fragment.sourceTop + fragment.sourceHeight;
    }
    assert.ok(Math.abs(end - 1) < 1e-7);
    assert.deepEqual((await queueSnapshot())[0], originalSnapshot);
    await page.screenshot({ path: resolve(output, 'reflow-continuation.png'), fullPage: true });
    return { pages: exported.pages, pixelComparison: exported.pixels, fragments, retainedRegionOrder: [proseRegion, equationRegion, appendedRegion] };
  });

  for (const kind of ['scan', 'image']) {
    await step(`${kind === 'scan' ? 'Image-only PDF' : 'Uploaded image'} offers manual reviewed text without inventing OCR output`, async () => {
      await fresh(); await upload(kind === 'scan' ? 'public/samples/sample.pdf' : 'public/samples/example.png');
      if (kind === 'scan') for (let index = 0; index < 3; index++) { await page.locator('#next-page').click(); await idle(); }
      const rect = kind === 'scan' ? manifest.crops.find(crop => crop.id === 'q10').rect : { x: 0.05, y: 0.08, w: 0.7, h: 0.3 };
      await openReflow(rect);
      assert.equal(await page.locator('#problem-text').inputValue(), ''); assert.equal(await cards().count(), 0);
      assert.match(`${await page.locator('#text-dialog').textContent()} ${await page.locator('#notice').textContent()}`, /paste|type|manual|no readable|no text|image/i);
      assert.equal(await page.locator('#text-target option[value="append"]').evaluate(option => option.disabled), true);
      const text = `Manually reviewed ${kind}: Find x when x² = 9. Explain why √9 = 3.`;
      await page.locator('#problem-text').fill(text); await page.locator('#text-target').selectOption('new'); await submitText(); await count(1);
      const id = (await cardIds())[0], region = (await regionIds(id))[0]; await field(id, 'space', 0);
      await editText(id, region).click(); assert.equal(await page.locator('#problem-text').inputValue(), text); await cancelText();
      const exported = await exportPdf(`reflow-${kind}-manual.pdf`); assert.equal(exported.pages, 1);
      return { pages: exported.pages, pixelComparison: exported.pixels };
    });
  }

  await step('Reflow stays local with no browser errors or external requests', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    if (offline) assert.deepEqual(audit.httpRequests, [], 'The standalone HTML reflows and exports text without HTTP(S), including workers.');
    return { errors: 0, externalRequests: 0, offline, httpRequests: audit.httpRequests.length, workers: audit.workerUrls.length };
  });
} catch (error) {
  failure = error; console.error(error.stack || error);
} finally {
  await writeFile(resolve(output, 'reflow-text-results.json'), JSON.stringify({ passed: !failure, runAt: new Date().toISOString(), origin, results, errors, externalRequests, networkAudit: audit,
    ...(failure ? { failure: failure.stack || String(failure) } : {}) }, null, 2));
  await browser?.close(); if (server) server.kill('SIGTERM');
}
if (failure) process.exitCode = 1;
else console.log(`All ${results.length} text reflow checks passed. Artifacts: ${output}`);
