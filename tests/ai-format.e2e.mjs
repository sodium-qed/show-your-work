import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { imageClipIntervals } from './helpers/pdf-inspection.mjs';

// Deterministic local-helper mocks verify the optional Ollama integration and
// source-image preservation. No live model runs and this is not an accuracy test.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.BASE_URL || 'http://localhost:4173';
const target = new URL(origin);
const offline = target.protocol === 'file:';
const bundled = process.env.E2E_DIST === '1';
const mode = offline ? 'standalone-offline' : bundled ? 'bundled-http-mock' : 'source-http-mock';
const output = resolve(root, process.env.E2E_OUTPUT || (offline ? 'tests/output/ai-offline' : bundled ? 'tests/output/ai-bundled' : 'tests/output/ai'));
const results = [], errors = [], externalRequests = [];
const audit = { offline, mocked: !offline, httpRequests: [], workerUrls: [], expectedApiErrors: [], statusRequests: 0 };
const apiCalls = [];
let mockPlan, mockMode = 'success', statusAvailable = true;
let formatRelease, formatArrived, expectedAbort = false;
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
  context.on('requestfailed', request => {
    const message = `request: ${request.url().slice(0, 250)} ${request.failure()?.errorText}`;
    if (expectedAbort && new URL(request.url()).pathname === '/api/ai/format' && /ERR_ABORTED/.test(request.failure()?.errorText || '')) audit.expectedApiErrors.push({ aborted: true, message });
    else errors.push(message);
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol)) {
      audit.httpRequests.push(request.url());
      if (url.origin !== target.origin) externalRequests.push(request.url());
    }
  });
  if (!offline) await context.route('**/api/ai/**', mockApi);
  page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('Browser page crashed.'));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource:.*status of 502/.test(message.text()) && audit.expectedApiErrors.some(item => item.status === 502)) audit.expectedApiErrors.push({ console: message.text() });
    else errors.push(message.text());
  });
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

async function mockApi(route) {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/ai/status') {
    assert.equal(request.method(), 'GET');
    audit.statusRequests++;
    return route.fulfill({ json: { available: statusAvailable, provider: 'Ollama', model: 'mock-local-ollama',
      ...(!statusAvailable ? { message: 'Ollama is not running. Start Ollama and download the local vision model.' } : {}) } });
  }
  assert.equal(path, '/api/ai/format', 'Only the documented local-helper endpoints are requested.');
  assert.equal(request.method(), 'POST');
  const body = request.postDataJSON();
  assert.ok(Array.isArray(body.images) && body.images.length > 0);
  const images = body.images.map(image => {
    assert.match(image.dataUrl, /^data:image\/png;base64,/);
    assert.equal(typeof image.text, 'string');
    assert.ok(Number.isInteger(image.width) && image.width > 0 && image.width <= 1600);
    assert.ok(Number.isInteger(image.height) && image.height > 0 && image.height <= 1600);
    assert.ok(image.width * image.height <= 2_000_000);
    const png = Buffer.from(image.dataUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), image.width);
    assert.equal(png.readUInt32BE(20), image.height);
    return { width: image.width, height: image.height, text: image.text, bytes: png.length,
      pngHash: createHash('sha256').update(png).digest('hex') };
  });
  const call = { mocked: true, response: mockMode, images };
  apiCalls.push(call);
  if (mockMode === 'pending') await new Promise(resolve => { formatRelease = resolve; formatArrived?.(); });
  if (mockMode === 'error') {
    audit.expectedApiErrors.push({ status: 502, message: 'Mock Ollama unavailable; original work is safe.' });
    return route.fulfill({ status: 502, json: { error: 'Mock Ollama unavailable; original work is safe.' } });
  }
  const plan = mockMode === 'invalid' ? {
    blocks: [{ kind: 'image', source: 99, rect: { x: 0, y: 0, w: 1, h: 1 }, text: '' }], warnings: [],
  } : mockPlan || fixture.plan;
  await route.fulfill({ json: { plan, model: 'mock-local-ollama', usage: { inputTokens: 123, outputTokens: 45 } } });
}

function imageBytes(pdf, crop) {
  const [number, generation] = crop.image.split(' ').map(Number);
  const image = pdf.context.lookup(PDFRef.of(number, generation));
  assert.equal(String(image.dict.lookup(PDFName.of('ColorSpace'))), '/DeviceRGB');
  assert.equal(String(image.dict.lookup(PDFName.of('BitsPerComponent'))), '8');
  const pixels = Buffer.from(decodePDFRawStream(image).decode());
  assert.equal(pixels.length, crop.pixelWidth * crop.pixelHeight * 3);
  return pixels;
}

// The original PNG is the source of truth. Independently crop its RGB samples
// at rounded source-pixel boundaries; never compare against the resized API PNG.
function exactImageSubcrop(originalExport, original, formattedExport, actual, rect, scale = 1) {
  const x0 = Math.round(rect.x * original.pixelWidth), y0 = Math.round(rect.y * original.pixelHeight);
  const x1 = Math.round((rect.x + rect.w) * original.pixelWidth), y1 = Math.round((rect.y + rect.h) * original.pixelHeight);
  const width = x1 - x0, height = y1 - y0;
  const originalPixels = imageBytes(originalExport.pdf, original), actualPixels = imageBytes(formattedExport.pdf, actual);
  const expected = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const begin = ((y0 + y) * original.pixelWidth + x0) * 3;
    originalPixels.copy(expected, y * width * 3, begin, begin + width * 3);
  }
  assert.equal(actual.pixelWidth, width); assert.equal(actual.pixelHeight, height);
  assert.equal(Buffer.compare(actualPixels, expected), 0, 'Retained math is an exact original-pixel submatrix without resampling.');
  const pointWidth = original.width * width / original.pixelWidth * scale;
  const pointHeight = original.height * height / original.pixelHeight * scale;
  assert.ok(Math.abs(actual.width - pointWidth) < 1e-7, 'Retained image width follows rounded source pixels.');
  assert.ok(Math.abs(actual.height - pointHeight) < 1e-7, 'Retained image height follows rounded source pixels.');
  assert.ok(Math.abs(actual.sourceTop) < 1e-7); assert.ok(Math.abs(actual.sourceHeight - 1) < 1e-7);
  return { sourcePixelBounds: { x0, y0, x1, y1 }, pixelWidth: width, pixelHeight: height,
    width: actual.width, height: actual.height, exactSourcePixels: true,
    pixelHash: createHash('sha256').update(expected).digest('hex') };
}

async function openAi(problemId, { available = true } = {}) {
  await (problemId ? card(problemId).locator('[data-action="ai-format"]') : page.locator('#ai-format')).click();
  await page.locator('#ai-dialog').waitFor({ state: 'visible' });
  if (!offline && available) await page.waitForFunction(() => !document.querySelector('#ai-run').disabled);
  else await page.locator('#ai-setup').waitFor({ state: 'visible' });
}
async function generated() {
  await page.locator('#ai-run').click();
  await page.waitForFunction(() => !document.querySelector('#ai-apply').disabled);
  await page.locator('#ai-preview-pages canvas').first().waitFor({ state: 'visible' });
}
async function cancelAi() {
  await page.locator('#ai-cancel').click();
  await page.locator('#ai-dialog').waitFor({ state: 'hidden' });
}
async function applyAi() {
  await page.locator('#ai-apply').click(); await idle();
  await page.locator('#ai-dialog').waitFor({ state: 'hidden' });
}
async function draftHash(selector = '#ai-preview-pages canvas') {
  return page.locator(selector).evaluateAll(async canvases => {
    const hashes = [];
    for (const canvas of canvases) {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join(''));
    }
    return hashes;
  });
}
async function showAdjustments() {
  if (!(await page.locator('#ai-adjustments').evaluate(node => node.open))) await page.locator('#ai-adjustments summary').click();
}
async function refreshDraft() {
  await page.locator('#ai-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#ai-apply').disabled);
}
async function localRuntimeGuidance() {
  const disclosure = await page.locator('#ai-disclosure').textContent();
  assert.match(disclosure, /Ollama/i);
  assert.match(disclosure, /local|computer|device/i);
  assert.doesNotMatch(disclosure, /OpenAI|charges apply|(?:enter|paste|set|provide).{0,20}API key/i);
  const setup = await page.locator('#ai-setup').textContent();
  assert.match(setup, /Ollama/i);
  assert.match(setup, /qwen3-vl:4b-instruct/);
  assert.doesNotMatch(setup, /OPENAI_API_KEY|OpenAI/);
}

let failure, originalExport, formattedExport, originalWhole, originalId, formattedId, approvedDraftHash;
try {
  fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/ai-plan.json'), 'utf8'));
  manifest = JSON.parse(await readFile(resolve(root, 'tests/fixtures/manifest.json'), 'utf8'));
  assert.equal(fixture.metadata.mock, true, 'This suite must identify its hand-authored API fixture as a mock.');
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  if (offline) {
    await step('Standalone AI explains its local-helper requirement without a network attempt', async () => {
      await fresh(); await upload(fixture.pdf); await selectCrop(fixture.wholeCrop.rect);
      const before = await cropValues();
      await openAi();
      await page.locator('#ai-setup').waitFor({ state: 'visible' });
      assert.match(await page.locator('#ai-setup').textContent(), /local|helper|server|localhost/i);
      await localRuntimeGuidance();
      assert.equal(await page.locator('#ai-run').isDisabled(), true);
      assert.equal(await page.locator('#ai-apply').isDisabled(), true);
      assert.equal(await cards().count(), 0);
      await page.keyboard.press('q'); assert.equal(await cards().count(), 0);
      await page.screenshot({ path: resolve(output, 'ai-offline-setup.png'), fullPage: true });
      await cancelAi(); assert.deepEqual(await cropValues(), before);
      assert.deepEqual(audit.httpRequests, []);
      return { localHelperExplanation: true, httpRequests: 0, cardsUnchanged: true };
    });
    await step('Standalone manual crop and reviewed text still export an exact PDF preview', async () => {
      await selectCrop(fixture.mathOriginalRect.rect); await page.locator('#add-problem').click(); await idle(); await count(1);
      const id = (await cardIds())[0]; await field(id, 'space', 0.5);
      await openReflow(fixture.wholeCrop.rect);
      assert.match(words(await page.locator('#problem-text').inputValue()), /garden club is testing a small water pump/);
      await page.locator('#problem-text').fill(fixture.expectedWording); await page.locator('#text-target').selectOption('append'); await submitText();
      assert.equal((await regionIds(id)).length, 2);
      const snapshot = await queueSnapshot();
      await openAi(id); await page.locator('#ai-setup').waitFor({ state: 'visible' }); await cancelAi();
      assert.deepEqual(await queueSnapshot(), snapshot);
      const exported = await exportPdf('ai-offline-manual.pdf');
      assert.equal(exported.pages, 1);
      return { pages: exported.pages, exactPreview: exported.pixels, manualRegionCount: 2 };
    });
  } else {
    await step('Missing Ollama runtime keeps manual tools available and a later local model can be used', async () => {
      statusAvailable = false; await fresh(); await upload(fixture.pdf); await selectCrop(fixture.wholeCrop.rect);
      await openAi(null, { available: false });
      assert.match(await page.locator('#ai-status').textContent(), /Ollama is not running\. Start Ollama/);
      await localRuntimeGuidance();
      assert.equal(await page.locator('#ai-run').isDisabled(), true); assert.equal(await page.locator('#ai-apply').isDisabled(), true);
      assert.equal(apiCalls.length, 0); await cancelAi();
      await page.locator('#add-problem').click(); await idle(); await count(1);
      const snapshot = await queueSnapshot();
      await openAi(snapshot[0].id, { available: false });
      const checks = audit.statusRequests; statusAvailable = true;
      await page.locator('#ai-recheck').click();
      await page.waitForFunction(() => !document.querySelector('#ai-run').disabled);
      assert.equal(audit.statusRequests, checks + 1, 'Check Ollama again retries status within the same open review dialog.');
      assert.match(await page.locator('#ai-status').textContent(), /mock-local-ollama/);
      assert.equal(await page.locator('#ai-setup').isVisible(), false); assert.equal(apiCalls.length, 0);
      await cancelAi(); assert.deepEqual(await queueSnapshot(), snapshot);
      return { runtime: 'Ollama', unavailableThenAvailable: true, retriedInSameDialog: true, manualCropRetained: true, formatRequests: 0 };
    });
    await step('One whole selection opens local originals without sending data before Generate', async () => {
      await fresh(); await upload(fixture.pdf); await selectCrop(fixture.wholeCrop.rect);
      await page.locator('#add-problem').click(); await idle(); await count(1);
      originalId = (await cardIds())[0]; await field(originalId, 'space', 0);
      originalExport = await exportPdf('ai-original-whole.pdf'); assert.equal(originalExport.pages, 1);
      assert.equal(originalExport.crops.length, 1); originalWhole = originalExport.crops[0];
      assert.ok(Math.abs(originalWhole.width - fixture.wholeCrop.rectPt.w) < 1e-7);
      assert.ok(Math.abs(originalWhole.height - fixture.wholeCrop.rectPt.h) < 1e-7);
      await page.locator('#back-to-edit').click();
      await field(originalId, 'space', 1.5); await field(originalId, 'scale', 30); await field(originalId, 'fit', 'shrink');
      await card(originalId).locator('[data-action="remove"]').click(); await count(0);
      await selectCrop(fixture.wholeCrop.rect); const crop = await cropValues();
      const requests = apiCalls.length; await openAi();
      assert.equal(await page.locator('#ai-originals img').count(), 1);
      assert.equal(apiCalls.length, requests, 'Opening review never sends selected content to the helper.');
      assert.equal(await cards().count(), 0); assert.deepEqual(await cropValues(), crop);
      return { pages: originalExport.pages, exactPreview: originalExport.pixels, sourceDimensions: originalWhole, formatRequestsBeforeGenerate: 0 };
    });
    await step('One mocked generation produces editable text and an actual draft PDF before Apply', async () => {
      const before = apiCalls.length; await generated();
      assert.equal(apiCalls.length, before + 1); assert.equal(apiCalls.at(-1).images.length, 1);
      assert.equal(await cards().count(), 0, 'A generated draft cannot silently alter the worksheet.');
      assert.equal(await page.locator('.ai-block').count(), 2);
      await showAdjustments();
      const input = page.locator('textarea[data-ai-field="text"]').first();
      assert.equal(await input.inputValue(), fixture.expectedWording);
      assert.equal(await input.isEditable(), true);
      assert.match(await page.locator('#ai-usage').textContent(), /123/); assert.match(await page.locator('#ai-usage').textContent(), /45/);
      assert.match(await page.locator('#ai-usage').textContent(), /local|Ollama/i);
      assert.doesNotMatch(await page.locator('#ai-usage').textContent(), /incurs|charges apply|billing|OpenAI/i);
      const originalHash = await draftHash();
      await input.fill(`${fixture.expectedWording} Check your units before you finish.`);
      assert.equal(await page.locator('#ai-apply').isDisabled(), true, 'Unrendered changes cannot be applied as a clean draft.');
      await refreshDraft(); assert.notDeepEqual(await draftHash(), originalHash, 'Editing text regenerates the visible draft PDF.');
      await input.fill(fixture.expectedWording); await refreshDraft();
      assert.deepEqual(await draftHash(), originalHash, 'Restoring exact wording restores the draft pixels.');
      approvedDraftHash = originalHash;
      assert.equal(apiCalls.length, before + 1, 'Local review edits do not make another model request.');
      await page.keyboard.press('q'); assert.equal(await cards().count(), 0);
      await page.screenshot({ path: resolve(output, 'ai-dialog.png'), fullPage: true });
      return { mocked: true, providerRequests: 1, draftPages: originalHash.length, editable: true, localRefresh: true };
    });
    await step('Apply creates a readable problem and retains exact original equation and graph pixels', async () => {
      await applyAi(); await count(1); formattedId = (await cardIds())[0];
      assert.deepEqual(await draftHash('#preview-pages canvas'), approvedDraftHash, 'The approved draft is carried unchanged into the final preview cache.');
      assert.deepEqual(await values(formattedId), { space: 1.5, scale: 100, fit: 'flow', pageBreak: false });
      const ids = await regionIds(formattedId); assert.equal(ids.length, 2);
      await editText(formattedId, ids[0]).click(); assert.equal(await page.locator('#problem-text').inputValue(), fixture.expectedWording); await cancelText();
      formattedExport = await exportPdf('ai-formatted.pdf'); assert.equal(formattedExport.pages, 1);
      assert.equal(formattedExport.crops.length, 2);
      const preserved = exactImageSubcrop(originalExport, originalWhole, formattedExport, formattedExport.crops[1], fixture.plan.blocks[1].rect);
      assert.ok(Math.abs(preserved.width - fixture.reviewExpectations.mathPrintSizePt.width) <= originalWhole.width / originalWhole.pixelWidth);
      assert.ok(Math.abs(preserved.height - fixture.reviewExpectations.mathPrintSizePt.height) <= originalWhole.height / originalWhole.pixelHeight);
      assert.ok(formattedExport.crops[0].width > originalWhole.width, 'Reflowed prose uses the wider printable column.');
      await page.screenshot({ path: resolve(output, 'ai-preview.png'), fullPage: true });
      await page.locator('#preview-pages canvas').first().screenshot({ path: resolve(output, 'ai-formatted-canvas.png') });
      return { pages: formattedExport.pages, exactPreview: formattedExport.pixels, preservedImage: preserved, scale: 100, wording: 'exact hand-authored fixture' };
    });
    await step('Existing multi-region replacement preserves identity and restores every original region and setting', async () => {
      await fresh(); mockMode = 'success';
      const source = JSON.parse(await readFile(resolve(root, fixture.sourceManifest), 'utf8'));
      await upload(fixture.pdf); await selectCrop(source.crops.prose.rect); await page.locator('#add-problem').click(); await idle(); await count(1);
      const id = (await cardIds())[0];
      await selectCrop(fixture.mathOriginalRect.rect); await page.locator('#append-region').click(); await idle();
      await field(id, 'space', 0.75); await field(id, 'scale', 65); await field(id, 'fit', 'shrink'); await field(id, 'pageBreak', true);
      const original = await queueSnapshot();
      const before = await exportPdf('ai-existing-original.pdf'); assert.equal(before.crops.length, 2);
      await page.locator('#back-to-edit').click();
      mockPlan = { blocks: [
        { kind: 'text', source: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: fixture.expectedWording },
        { kind: 'image', source: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, text: '' },
      ], warnings: [] };
      await openAi(id); assert.equal(await page.locator('#ai-originals img').count(), 2); await generated();
      assert.equal(apiCalls.at(-1).images.length, 2); assert.deepEqual(await queueSnapshot(), original);
      await applyAi(); assert.deepEqual(await cardIds(), [id]);
      assert.deepEqual(await values(id), { space: 0.75, scale: 100, fit: 'flow', pageBreak: true });
      assert.notDeepEqual(await regionIds(id), original[0].regions.map(region => region.id));
      const after = await exportPdf('ai-existing-formatted.pdf');
      const preserved = exactImageSubcrop(before, before.crops[1], after, after.crops[1], { x: 0, y: 0, w: 1, h: 1 }, 1 / 0.65);
      await page.locator('#back-to-edit').click(); await card(id).locator('[data-action="restore-original"]').click(); await idle();
      assert.deepEqual(await queueSnapshot(), original, 'Restore recovers IDs, ordering, thumbnails, scale, fit, space and page break.');
      const restored = await exportPdf('ai-existing-restored.pdf');
      assert.equal(restored.pages, before.pages); assert.deepEqual(restored.pixels.detail.map(page => page.renderHash), before.pixels.detail.map(page => page.renderHash));
      await page.locator('#back-to-edit').click(); mockPlan = null;
      return { pages: [before.pages, after.pages, restored.pages], exactPreview: [before.pixels, after.pixels, restored.pixels], preservedImage: preserved, restoration: 'exact original worksheet pixels and DOM settings' };
    });
    await step('Cancel, helper failure, and invalid plans leave the existing worksheet unchanged', async () => {
      const snapshot = await queueSnapshot(), id = snapshot[0].id;
      const requests = apiCalls.length; await openAi(id); await cancelAi();
      assert.equal(apiCalls.length, requests); assert.deepEqual(await queueSnapshot(), snapshot);
      mockPlan = { blocks: [{ kind: 'text', source: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: 'A mocked draft that will be cancelled.' }], warnings: ['Mock review warning: check every original part.'] };
      await openAi(id); await generated();
      assert.match(await page.locator('#ai-warnings').textContent(), /Mock review warning/);
      await cancelAi(); assert.deepEqual(await queueSnapshot(), snapshot);
      for (const mode of ['error', 'invalid']) {
        mockMode = mode; await openAi(id); await page.locator('#ai-run').click();
        await page.waitForFunction(mode => {
          const status = document.querySelector('#ai-status').textContent;
          const matched = mode === 'error' ? status.includes('Mock Ollama unavailable') : status.includes('Invalid AI layout plan:');
          return matched && document.querySelector('#ai-apply').disabled && !document.querySelector('#ai-run').disabled;
        }, mode);
        assert.deepEqual(await queueSnapshot(), snapshot);
        await cancelAi(); assert.deepEqual(await queueSnapshot(), snapshot);
      }
      mockMode = 'pending'; expectedAbort = true;
      const arrived = new Promise(resolve => { formatArrived = resolve; });
      await openAi(id); await page.locator('#ai-run').click(); await arrived;
      assert.equal(await page.locator('#ai-apply').isDisabled(), true);
      await cancelAi(); formatRelease();
      assert.deepEqual(await queueSnapshot(), snapshot, 'Cancelling an in-flight helper request cannot commit a draft.');
      mockMode = 'success'; mockPlan = null;
      await openAi(id); await cancelAi(); assert.deepEqual(await queueSnapshot(), snapshot);
      return { cancelledBeforeRequest: true, cancelledDraft: true, cancelledInFlight: true, serverError: 502, rejectedInvalidSource: 99, originalUnchanged: true };
    });
    await step('Image-only PDF uses a vision-input mock and still preserves its source pixels', async () => {
      await fresh(); await upload('public/samples/sample.pdf');
      for (let index = 0; index < 3; index++) { await page.locator('#next-page').click(); await idle(); }
      const rect = manifest.crops.find(crop => crop.id === 'q10').rect;
      await selectCrop(rect); await page.locator('#add-problem').click(); await idle(); await count(1);
      const id = (await cardIds())[0]; await field(id, 'space', 0);
      const before = await exportPdf('ai-scan-original.pdf'); assert.equal(before.crops.length, 1);
      await page.locator('#back-to-edit').click();
      const retained = { x: 0, y: 0.5, w: 1, h: 0.5 };
      mockPlan = { blocks: [
        { kind: 'text', source: 0, rect: { x: 0, y: 0, w: 1, h: 0.5 }, text: 'Mock vision review: preserve the original diagram below and check this wording before applying.' },
        { kind: 'image', source: 0, rect: retained, text: '' },
      ], warnings: ['Synthetic vision response for integration testing; not a transcription accuracy result.'] };
      await openAi(id); await generated();
      assert.equal(apiCalls.at(-1).images.length, 1); assert.equal(apiCalls.at(-1).images[0].text, '', 'An image-only page supplies pixels without invented native text.');
      assert.match(await page.locator('#ai-warnings').textContent(), /not a transcription accuracy result/);
      await applyAi();
      const exported = await exportPdf('ai-scan-formatted.pdf'); assert.equal(exported.pages, 1);
      const preserved = exactImageSubcrop(before, before.crops[0], exported, exported.crops[1], retained);
      return { mockedVision: true, nativeTextCharacters: 0, pages: [before.pages, exported.pages], exactPreview: [before.pixels, exported.pixels], preservedImage: preserved };
    });
  }

  await step('Network audit confirms only mocked helper traffic and no unexpected browser errors', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    if (offline) { assert.deepEqual(audit.httpRequests, []); assert.deepEqual(apiCalls, []); }
    return { mode, mocked: !offline, liveProviderRequests: 0, httpRequests: audit.httpRequests.length, formatRequests: apiCalls.length,
      externalRequests: 0, browserErrors: 0, expectedMockHttpErrors: audit.expectedApiErrors.filter(item => item.status).length, workers: audit.workerUrls.length };
  });
} catch (error) {
  failure = error; console.error(error.stack || error);
} finally {
  await writeFile(resolve(output, 'ai-format-results.json'), JSON.stringify({ passed: !failure, runAt: new Date().toISOString(), origin, mode,
    runtime: 'Ollama', mockDisclaimer: 'All local-model responses are hand-authored integration mocks. No live model execution or accuracy assessment was performed.',
    results, errors, externalRequests, networkAudit: audit, apiCalls,
    ...(failure ? { failure: failure.stack || String(failure) } : {}) }, null, 2));
  await browser?.close(); if (server) server.kill('SIGTERM');
}
if (failure) process.exitCode = 1;
else console.log(`All ${results.length} ${mode} AI integration checks passed. Artifacts: ${output}`);

