// Regression checks for requests spanning textbook pages, uncommon exercise labels,
// and missing-number feedback. All textbook content here is generated for this test.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createStaticServer } from '../scripts/serve.mjs';

const out = process.env.OUT || 'tests/output/selection';
await mkdir(out, { recursive: true });

async function textbook(titled) {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  for (const first of [41, 53]) {
    const p = doc.addPage([612, 792]);
    p.drawText('Practice exercises', { x: 50, y: 738, size: 17, font: bold });
    p.drawText(`Exer. ${first}\u2013${first + 5}: Evaluate each expression and show the steps.`, { x: 50, y: 700, size: 11, font: italic });
    for (let i = 0; i < 6; i++) {
      const n = first + i, x = i % 2 ? 320 : 50, y = 650 - Math.floor(i / 2) * 110;
      if (!titled) {
        p.drawText(String(n), { x, y, size: 11, font: bold });
        p.drawText('Evaluate f(x) = x^2 + 3.14.', { x: x + 26, y, size: 11, font: body });
      } else if (n === 54) {
        // Separate PDF text runs and fonts must still form one visible label.
        p.drawText('54', { x, y, size: 11, font: bold });
        p.drawText('.', { x: x + bold.widthOfTextAtSize('54', 11) + 0.2, y, size: 11, font: body });
        p.drawText('Storage bin', { x: x + 18, y, size: 11, font: bold });
      } else {
        // PDF text layers and OCR can join punctuation to a word-problem title.
        const label = n === 57 ? '57.Open-top box' : `${n}. Area of a triangle`;
        p.drawText(label, { x, y, size: 11, font: bold });
      }
      if (titled) p.drawText('Find the required value and explain.', { x: x + 26, y: y - 15, size: 11, font: body });
      // These ordinary constants must not turn into exercise-number anchors.
      p.drawText('2 + x = 4; use 54 as a check.', { x: x + 26, y: y - (titled ? 30 : 15), size: 11, font: body });
    }
  }
  return doc.save();
}

const HOST = process.env.E2E_HOST || 'localhost';
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(0, HOST === 'localhost' ? undefined : HOST);
await once(server, 'listening');
const BASE = `http://${HOST}:${server.address().port}`;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
let browser;
const errors = [];
const selected = page => page.evaluate(() => [...window.__syw.state.selected.values()].map(p => p.number).sort((a, b) => a - b));
const ask = (page, text) => page.evaluate(text => window.__syw.ask(text), text);

try {
  browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
  for (const titled of [false, true]) {
    const name = titled ? 'titled-labels' : 'plain-labels';
    const bytes = await textbook(titled);
    await writeFile(`${out}/${name}.pdf`, bytes);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => !!window.__syw);

    // Start a request while the file is still being read. Releasing this explicit
    // barrier is deterministic and verifies that selection waits for every page.
    await page.evaluate(({ bytes, name }) => {
      const file = new File([new Uint8Array(bytes)], `${name}.pdf`, { type: 'application/pdf' });
      const read = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => new Promise((resolve, reject) => {
        window.__releaseTextbook = () => read().then(resolve, reject);
      });
      window.__textbookLoading = window.__syw.addFiles([file]);
      window.__requestDone = false;
      window.__pendingRequest = window.__syw.ask('Problems 43, 45, 57').then(() => { window.__requestDone = true; });
    }, { bytes: [...bytes], name });
    assert.equal(await page.evaluate(() => window.__requestDone), false, 'a number request waits for an in-progress file read');
    await page.evaluate(async () => {
      await window.__releaseTextbook();
      await Promise.all([window.__textbookLoading, window.__pendingRequest]);
    });
    const detected = await page.evaluate(() => window.__syw.state.sources[0].pages.map(p => ({
      numbers: p.problems.map(p => p.number), ocr: p.ocr,
      ranges: p.directions.map(d => d.range),
    })));
    assert.deepEqual(detected.map(p => p.numbers), [[41, 42, 43, 44, 45, 46], [53, 54, 55, 56, 57, 58]], `${name}: all exercise labels, no mathematical constants`);
    assert.deepEqual(detected.map(p => p.ranges), [[{ from: 41, to: 46 }], [{ from: 53, to: 58 }]], `${name}: abbreviated exercise directions`);
    assert.deepEqual(await selected(page), [43, 45, 57], `${name}: first screenshot request`);
    assert.ok(detected.every(p => !p.ocr), `${name}: readable PDF text does not require OCR`);

    await ask(page, 'clear');
    await page.locator('#ask-input').fill('42, 54, 57');
    await page.locator('#ask button').click();
    await page.waitForFunction(() => [...window.__syw.state.selected.values()].map(p => p.number).sort((a, b) => a - b).join(',') === '42,54,57');
    assert.deepEqual(await selected(page), [42, 54, 57], `${name}: second screenshot request`);
    await page.waitForFunction(() => !!window.__syw.state.pdf && /^3 problems on/.test(document.querySelector('#exam-status').textContent), null, { timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    assert.equal(await download.failure(), null);
    await download.saveAs(`${out}/${name}-exam.pdf`);
    const exam = await PDFDocument.load(await readFile(`${out}/${name}-exam.pdf`));
    assert.equal(exam.getPageCount(), 2, `${name}: a valid two-sided exam downloads`);

    await ask(page, '45, 99');
    assert.deepEqual(await selected(page), [42, 45, 54, 57], `${name}: partial request adds only found problems`);
    let feedback = await page.locator('#toast').textContent();
    assert.match(feedback, /99/);
    assert.match(feedback, /not found|could not find|missing/i);
    assert.equal(await page.locator('#toast').evaluate(t => t.classList.contains('bad')), true, 'partial selection is reported as a warning');
    await ask(page, '99');
    assert.deepEqual(await selected(page), [42, 45, 54, 57], `${name}: missing request preserves existing selection`);
    feedback = await page.locator('#toast').textContent();
    assert.match(feedback, /99/);
    assert.match(feedback, /not found|could not find|missing/i);
    assert.doesNotMatch(feedback, /added nothing/i);
    assert.equal(await page.locator('#toast').evaluate(t => t.classList.contains('bad')), true, 'missing request is not reported as success');

    await page.evaluate(() => window.__syw.selectNumbers('46, 98'));
    assert.deepEqual(await selected(page), [42, 45, 46, 54, 57], `${name}: direct number selector adds only found problems`);
    feedback = await page.locator('#toast').textContent();
    assert.match(feedback, /98/);
    assert.match(feedback, /not found|could not find|missing/i);
    assert.equal(await page.locator('#toast').evaluate(t => t.classList.contains('bad')), true, 'direct partial selection reports a warning');
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`${name}: both screenshot requests, loading barrier, missing feedback, and PDF download passed`);
    await page.close();
  }
  assert.deepEqual(errors, [], 'no browser application errors');
} finally {
  if (errors.length) console.error(errors.join('\n'));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
