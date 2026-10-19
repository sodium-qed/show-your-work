import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { imageClipIntervals } from './helpers/pdf-inspection.mjs';

// Real UI actions exercise the preference and shortcut contract. Storage fault
// cases deliberately replace only the browser storage boundary, never app state.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.BASE_URL || 'http://localhost:4173';
const target = new URL(origin);
const offline = target.protocol === 'file:';
const output = resolve(root, process.env.E2E_OUTPUT || (offline ? 'tests/output/preferences-offline' : 'tests/output/preferences'));
const key = 'show-your-work.preferences.v1';
const defaultWorksheet = { title: 'Math practice', paper: 'letter', margin: '36', nameLine: true, alignment: 'center' };
const defaultProblem = { space: 2, scale: 100, fit: 'flow', pageBreak: false };
const results = [], errors = [], httpRequests = [], externalRequests = [];
let browser, context, page, server;
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
  const began = Date.now();
  while (!(await serverReady())) {
    if (server.exitCode !== null || Date.now() - began > 10000) throw new Error(`Test server failed: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function step(name, action) {
  const start = Date.now();
  try {
    const detail = await action();
    results.push({ name, status: 'passed', milliseconds: Date.now() - start, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack || String(error) });
    await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  }
}
async function fresh({ storageValue, blockedStorage } = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true, offline });
  if (storageValue !== undefined || blockedStorage) await context.addInitScript(({ key, storageValue, blockedStorage }) => {
    if (storageValue !== undefined) localStorage.setItem(key, storageValue);
    if (blockedStorage === 'getter') Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
    if (blockedStorage === 'write') Storage.prototype.setItem = function () { throw new DOMException('Storage quota reached', 'QuotaExceededError'); };
  }, { key, storageValue, blockedStorage });
  context.on('requestfailed', request => errors.push(`request: ${request.url().slice(0, 250)} ${request.failure()?.errorText}`));
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol)) {
      httpRequests.push(request.url());
      if (url.origin !== target.origin) externalRequests.push(request.url());
    }
  });
  page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.setDefaultTimeout(20000);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#question-alignment').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.problem-card').count(), 0);
}
const idle = () => page.locator('#busy').waitFor({ state: 'hidden' });
const cards = () => page.locator('.problem-card');
const card = id => page.locator(`.problem-card[data-id="${id}"]`);
const ids = () => cards().evaluateAll(nodes => nodes.map(node => node.dataset.id));
async function count(expected) {
  await page.waitForFunction(value => document.querySelectorAll('.problem-card').length === value, expected);
}
async function upload() {
  await page.locator('#file-input').setInputFiles(resolve(root, 'public/samples/sample.pdf'));
  await idle(); await page.locator('#source-workspace').waitFor({ state: 'visible' });
}
const rect = { x: 0.08, y: 0.19, w: 0.5, h: 0.2 };
async function selectCrop(value = rect) {
  await page.locator('#full-page-button').click();
  for (const field of ['x', 'y', 'w', 'h']) {
    await page.locator(`#crop-${field}`).fill(String(value[field] * 100));
    await page.locator(`#crop-${field}`).press('Tab');
  }
}
async function focusCrop() { await page.locator('#crop-layer').focus(); }
async function addCrop(shortcut) {
  const previous = await cards().count();
  await selectCrop();
  if (shortcut) { await focusCrop(); await page.keyboard.press(shortcut); }
  else await page.locator('#add-problem').click();
  await idle(); await count(previous + 1);
  return (await ids()).at(-1);
}
async function addText(text = 'Determine all real x for which x² = 9.') {
  const previous = await cards().count();
  await page.locator(await page.locator('#source-workspace').isVisible() ? '#text-button-2' : '#text-button').click();
  await page.locator('#problem-text').fill(text); await page.locator('#add-text').click();
  await idle(); await count(previous + 1);
  return (await ids()).at(-1);
}
async function field(id, name, value) {
  const input = card(id).locator(`[data-field="${name}"]`);
  if (typeof value === 'boolean') await input.setChecked(value);
  else if (name === 'fit') await input.selectOption(value);
  else { await input.fill(String(value)); await input.press('Tab'); }
}
async function values(id) {
  return card(id).evaluate(node => ({
    space: Number(node.querySelector('[data-field="space"]').value), scale: Number(node.querySelector('[data-field="scale"]').value),
    fit: node.querySelector('[data-field="fit"]').value, pageBreak: node.querySelector('[data-field="pageBreak"]').checked,
  }));
}
const worksheet = () => page.evaluate(() => ({
  title: document.querySelector('#worksheet-title').value, paper: document.querySelector('#paper-size').value,
  margin: document.querySelector('#page-margin').value, nameLine: document.querySelector('#name-line').checked,
  alignment: document.querySelector('#question-alignment').value,
}));
const queueShape = () => cards().evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.id, regions: node.querySelectorAll('.region-thumb').length })));
async function noMutation(action, message) {
  const before = await queueShape(); await action(); await idle();
  assert.deepEqual(await queueShape(), before, message);
}
async function savePdf(filename) {
  const download = page.waitForEvent('download'); await page.locator('#export-top').click();
  const file = await download; const path = resolve(output, filename); await file.saveAs(path); await idle();
  const bytes = await readFile(path); const pdf = await PDFDocument.load(bytes);
  const text = await page.evaluate(async data => {
    const embedded = globalThis.MARGIN_EMBEDDED;
    const pdfjs = await import(embedded?.pdfjsURL || '/vendor/pdfjs/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', isEvalSupported: false,
      ...(embedded?.pdfOptions || {}) }).promise;
    try {
      const pages = [];
      for (let number = 1; number <= doc.numPages; number++) pages.push((await (await doc.getPage(number)).getTextContent()).items.map(item => item.str));
      return pages;
    } finally { await doc.destroy(); }
  }, [...bytes]);
  return { pdf, text, bytes };
}
function geometry(pdf) {
  const clips = [];
  for (const page of pdf.getPages()) {
    const content = page.node.Contents();
    for (let i = 0; i < content.size(); i++) {
      const stream = Buffer.from(decodePDFRawStream(pdf.context.lookup(content.get(i))).decode()).toString();
      for (const match of stream.matchAll(/^([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re$/gm)) clips.push(match.slice(1).map(Number));
    }
  }
  const source = imageClipIntervals(pdf)[0];
  const [number, generation] = source.image.split(' ').map(Number);
  const image = pdf.context.lookup(PDFRef.of(number, generation));
  return { clips, pixelWidth: source.pixelWidth, pixelHeight: source.pixelHeight,
    imageHash: createHash('sha256').update(image.getContents()).digest('hex') };
}

let failure;
try {
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  await step('P adds, Q appends, uppercase works, and drawing restores shortcut focus', async () => {
    await fresh(); await upload();
    await focusCrop();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'No crop means no shortcut action.');
    await selectCrop(); await focusCrop();
    await noMutation(() => page.keyboard.press('q'), 'Q without a selected problem is harmless.');
    await page.keyboard.press('p'); await idle(); await count(1);
    const first = (await ids())[0];
    await selectCrop({ x: 0.08, y: 0.42, w: 0.5, h: 0.1 }); await focusCrop();
    await page.keyboard.press('q'); await idle(); await count(1);
    assert.equal(await card(first).locator('.region-thumb').count(), 2);
    await addCrop('Shift+P');
    await selectCrop({ x: 0.08, y: 0.6, w: 0.5, h: 0.1 }); await focusCrop();
    await page.keyboard.press('Shift+Q'); await idle(); await count(2);
    assert.equal(await cards().last().locator('.region-thumb').count(), 2);
    await selectCrop(); await page.locator('#clear-crop').click();
    await page.locator('#worksheet-title').focus();
    const layer = page.locator('#crop-layer'); await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.05); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.13, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'crop-layer');
    await page.keyboard.press('p'); await idle(); await count(3);
    await page.screenshot({ path: resolve(output, 'shortcuts.png'), fullPage: true });
  });

  await step('Shortcut guards protect typing, dialogs, modifiers, repeats, editing, preview, and busy work', async () => {
    await fresh(); await upload(); const first = await addCrop(); await selectCrop();
    await page.locator('#worksheet-title').focus();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'Typing in a text input must not add or append.');
    await page.locator('#question-alignment').focus();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'Select controls own their keyboard input.');
    await page.locator('#text-button-2').click(); await page.locator('#problem-text').focus();
    await noMutation(async () => { await page.keyboard.type('pq'); }, 'Textareas and open text dialogs protect typing.');
    assert.equal(await page.locator('#problem-text').inputValue(), 'pq'); await page.keyboard.press('Escape');
    await page.locator('#help-button').click(); await page.locator('#close-help').focus();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'An open non-text dialog blocks global shortcuts.');
    await page.locator('#close-help').click();
    await page.evaluate(() => { const editor = document.createElement('div'); editor.id = 'test-contenteditable'; editor.contentEditable = 'true'; document.body.append(editor); editor.focus(); });
    await noMutation(() => page.keyboard.type('pq'), 'Editable rich text must not trigger worksheet actions.');
    await page.locator('#test-contenteditable').evaluate(node => node.remove());
    await focusCrop();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'repeat']) {
      await noMutation(async () => {
        for (const letter of ['p', 'q']) await page.locator('#crop-layer').dispatchEvent('keydown', { key: letter, code: `Key${letter.toUpperCase()}`, bubbles: true, [modifier]: true });
      }, `${modifier} prevents the P and Q shortcuts.`);
    }
    await card(first).locator('[data-action="edit-region"]').click(); await idle(); await focusCrop();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'Saved-region edits use Update rather than creating duplicate regions.');
    await selectCrop(); await page.locator('#preview-button').click(); await idle();
    await noMutation(async () => { await page.keyboard.press('p'); await page.keyboard.press('q'); }, 'Preview cannot modify an offscreen selection.');
    await page.locator('#back-to-edit').click();
    const busyObserved = await page.evaluate(() => {
      document.querySelector('#add-problem').click();
      const busy = !document.querySelector('#busy').hidden;
      for (const key of ['p', 'q']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      return busy;
    });
    assert.equal(busyObserved, true); await idle(); await count(2);
    assert.equal(await card(first).locator('.region-thumb').count(), 1);
    assert.equal(await cards().last().locator('.region-thumb').count(), 1);
  });

  const preferredWorksheet = { title: 'Remember these settings', paper: 'a4', margin: '72', nameLine: false, alignment: 'left' };
  await step('Defaults inherit through every creation path while existing cards stay independent', async () => {
    await fresh(); await upload(); const first = await addCrop();
    for (const [name, value] of Object.entries({ space: 2.75, scale: 75, fit: 'shrink', pageBreak: true })) await field(first, name, value);
    await page.locator('#worksheet-title').fill(preferredWorksheet.title);
    await page.locator('#paper-size').selectOption('a4'); await page.locator('#page-margin').selectOption('72');
    await page.locator('#name-line').uncheck(); await page.locator('#question-alignment').selectOption('left');
    const second = await addCrop('p');
    assert.deepEqual(await values(second), { space: 2.75, scale: 75, fit: 'shrink', pageBreak: true });
    await field(second, 'scale', 125);
    assert.equal((await values(first)).scale, 75);
    const expected = { space: 2.75, scale: 125, fit: 'shrink', pageBreak: true };
    assert.deepEqual(await values(await addText()), expected);
    assert.deepEqual(await values(await addCrop()), expected);
    await page.locator('#next-page').click(); await idle(); await page.locator('#detect-button').click(); await idle();
    const before = await cards().count(); const suggested = await page.locator('.suggestion').count(); assert.equal(suggested, 4);
    await page.locator('#accept-all').click(); await idle(); await count(before + suggested);
    for (const id of (await ids()).slice(before)) assert.deepEqual(await values(id), expected);
    // Editing only space on an older card must keep the newer scale default.
    await field(first, 'space', 1);
    assert.deepEqual(await values(await addText()), { ...expected, space: 1 });
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.deepEqual(Object.keys(stored).sort(), ['problem', 'version', 'worksheet']);
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.worksheet, { ...preferredWorksheet, margin: 72 });
    assert.deepEqual(stored.problem, { space: 72, scale: 125, fit: 'shrink', pageBreak: true });
    return { creationPaths: ['P', 'Add as a problem', 'Add all suggestions', 'Pasted text'], persisted: stored };
  });

  await step('Reload restores settings and future defaults without persisting worksheet files', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    assert.deepEqual(await worksheet(), preferredWorksheet);
    await count(0); assert.equal(await page.locator('#empty-source').isVisible(), true);
    assert.deepEqual(await values(await addText()), { space: 1, scale: 125, fit: 'shrink', pageBreak: true });
  });

  await step('Scale reset affects one card and future defaults; preference reset preserves existing cards', async () => {
    const first = (await ids())[0]; const second = await addText(); await field(first, 'scale', 175);
    await card(first).locator('[data-action="reset-scale"]').click();
    assert.equal((await values(first)).scale, 100); assert.equal((await values(second)).scale, 125);
    assert.equal((await values(await addText())).scale, 100);
    const existing = await Promise.all((await ids()).map(async id => [id, await values(id)]));
    await page.locator('#reset-preferences').click();
    assert.deepEqual(await worksheet(), defaultWorksheet);
    for (const [id, value] of existing) assert.deepEqual(await values(id), value);
    assert.deepEqual(await values(await addText()), defaultProblem);
    await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual(await worksheet(), defaultWorksheet);
    assert.deepEqual(await values(await addText()), defaultProblem);
  });

  await step('Corrupt, denied, and quota-limited storage never blocks local worksheet editing', async () => {
    await fresh({ storageValue: '{invalid-json' }); assert.deepEqual(await worksheet(), defaultWorksheet);
    await field(await addText(), 'scale', 150);
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).version, key), 1);
    for (const blockedStorage of ['getter', 'write']) {
      await fresh({ blockedStorage }); assert.deepEqual(await worksheet(), defaultWorksheet);
      const first = await addText(); await field(first, 'scale', 150);
      await page.locator('#worksheet-title').fill('Still works without storage');
      assert.equal((await values(await addText())).scale, 150);
      await page.locator('#reset-preferences').click(); assert.deepEqual(await worksheet(), defaultWorksheet);
      assert.equal((await values(first)).scale, 150);
    }
  });

  await step('Center and left export geometry preserve crop pixels, aspect, pagination, and numeric labels', async () => {
    await fresh(); await upload(); const id = await addCrop(); await field(id, 'space', 0.5); await field(id, 'scale', 75);
    assert.equal(await page.locator('#question-alignment').inputValue(), 'center');
    await page.locator('#worksheet-title').fill('Aligned practice');
    const centered = await savePdf('centered.pdf'); const center = geometry(centered.pdf);
    assert.equal(centered.pdf.getPageCount(), 1); assert.equal(center.clips.length, 1);
    assert.ok(centered.text[0].includes('1.')); assert.ok(centered.text.flat().every(text => !/^Problem \d/.test(text)));
    const [centerX, centerY, width, height] = center.clips[0];
    assert.ok(Math.abs(width - 612 * rect.w * 0.75) < 1e-6);
    assert.ok(Math.abs(height - 792 * rect.h * 0.75) < 1e-6);
    assert.ok(Math.abs(centerX - (612 - width) / 2) < 1e-6);
    await page.locator('#question-alignment').selectOption('left');
    const leftAligned = await savePdf('left-aligned.pdf'); const left = geometry(leftAligned.pdf);
    assert.equal(leftAligned.pdf.getPageCount(), 1);
    assert.deepEqual(left.clips[0], [36, centerY, width, height]);
    assert.equal(center.imageHash, left.imageHash, 'Alignment cannot rewrite original crop pixels.');
    assert.equal(center.pixelWidth, left.pixelWidth); assert.equal(center.pixelHeight, left.pixelHeight);
    assert.ok(Math.abs(width / height - center.pixelWidth / center.pixelHeight) < 0.005);
    await field(id, 'space', 10); const continued = await savePdf('numeric-continuation.pdf');
    assert.ok(continued.pdf.getPageCount() > 1); assert.ok(continued.text.flat().includes('1. (continued)'));
    assert.ok(continued.text.flat().every(text => !/^Problem \d/.test(text)));
    await page.locator('#preview-tab').click(); await idle();
    await page.screenshot({ path: resolve(output, 'numeric-preview.png'), fullPage: true });
    return { centered: center.clips[0], left: left.clips[0], unchangedImageHash: center.imageHash, continuationPages: continued.pdf.getPageCount() };
  });

  await step('No runtime errors or external requests during preference and shortcut workflows', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    if (offline) assert.deepEqual(httpRequests, []);
    return { errors: 0, externalRequests: 0, offline, httpRequests: httpRequests.length };
  });
} catch (error) {
  failure = error; console.error(error.stack || error);
} finally {
  await writeFile(resolve(output, 'preferences-shortcuts-results.json'), JSON.stringify({ passed: !failure, runAt: new Date().toISOString(), origin, results, errors, httpRequests, externalRequests, ...(failure ? { failure: failure.stack || String(failure) } : {}) }, null, 2));
  await browser?.close(); if (server) server.kill('SIGTERM');
}
if (failure) process.exitCode = 1;
else console.log(`All ${results.length} preferences and shortcuts checks passed. Artifacts: ${output}`);
