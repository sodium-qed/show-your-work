// Standalone ranges describe the requested numbered set; explicit additions and
// removals remain incremental. This uses the real UI and real PDF extraction.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createStaticServer } from '../scripts/serve.mjs';

const out = process.env.OUT || 'tests/output/range-selection';
await mkdir(out, { recursive: true });

async function exercises(numbers, reviewNumbers = []) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const addPage = (items, review = false) => {
    const page = doc.addPage([612, 792]);
    page.drawText(review ? 'Quick Review' : 'Evaluate each expression.', {
      x: 40, y: 746, size: review ? 16 : 12, font: review ? bold : regular,
    });
    items.forEach((n, i) => {
      const x = i % 2 ? 320 : 40, y = 700 - Math.floor(i / 2) * 58;
      page.drawText(`${n}.`, { x, y, size: 11, font: bold });
      page.drawText('Find the value of the expression.', { x: x + 27, y, size: 11, font: regular });
      page.drawText('Show the steps in your calculation.', { x: x + 27, y: y - 15, size: 11, font: regular });
    });
  };
  for (let offset = 0; offset < numbers.length; offset += 22) addPage(numbers.slice(offset, offset + 22));
  if (reviewNumbers.length) addPage(reviewNumbers, true);
  return doc.save();
}

const HOST = process.env.E2E_HOST || 'localhost';
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(0, HOST === 'localhost' ? undefined : HOST);
await once(server, 'listening');
const BASE = `http://${HOST}:${server.address().port}`;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
const errors = [];
let browser;
const selectedNumbers = page => page.evaluate(() => [...window.__syw.state.selected.values()]
  .map(p => p.number).filter(n => n != null).sort((a, b) => a - b));
const ask = async (page, text) => {
  await page.locator('#ask-input').fill(text);
  await page.locator('#ask button').click();
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled);
};
const addFile = (page, bytes, name) => page.evaluate(async ({ bytes, name }) => {
  await window.__syw.addFiles([new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })]);
}, { bytes: [...bytes], name });

try {
  browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(e.message));
  // The model state is real; only its expensive inference worker is replaced.
  // Literal ranges must bypass this worker regardless of what it would propose.
  await page.route('**/src/agent-worker.js', route => route.fulfill({
    contentType: 'application/javascript', body: `self.onmessage = ({ data }) => {
      if (data.type === 'load') self.postMessage({ type: 'ready', device: 'webgpu' });
      else if (data.type === 'run') self.postMessage({ type: 'result', id: data.id,
        calls: [{ name: 'update_worksheet', args: { pages: 1, remove_numbers: '1-50' } }], raw: 'bad model proposal' });
    };`,
  }));
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => !!window.__syw);
  const numbers = Array.from({ length: 50 }, (_, i) => i + 1);
  const bytes = await exercises(numbers);
  await writeFile(`${out}/numbered-exercises.pdf`, bytes);
  await addFile(page, bytes, 'numbered-exercises.pdf');
  assert.deepEqual(await page.evaluate(() => window.__syw.state.sources[0].pages.flatMap(p => p.problems.map(p => p.number))), numbers);
  await page.locator('#ai-load').click();
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent === 'Local AI on');
  await ask(page, 'add 7, 9, 41, 42');
  assert.deepEqual(await selectedNumbers(page), [7, 9, 41, 42]);

  const laterBytes = await exercises([101, 102]);
  await page.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'later-exercises.pdf', { type: 'application/pdf' });
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => new Promise((resolve, reject) => { window.__releaseLaterRead = () => read().then(resolve, reject); });
    window.__laterRead = window.__syw.addFiles([file]);
  }, [...laterBytes]);
  await page.locator('#ask-input').fill('1-40 even');
  await page.locator('#ask button').click();
  assert.equal(await page.locator('#ask button').isDisabled(), true, 'the range waits for queued reading');
  assert.deepEqual(await selectedNumbers(page), [7, 9, 41, 42], 'selection is unchanged while reading');
  await page.evaluate(async () => { await window.__releaseLaterRead(); await window.__laterRead; });
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled);
  const evens = Array.from({ length: 20 }, (_, i) => 2 * (i + 1));
  assert.deepEqual(await selectedNumbers(page), evens, 'a standalone even range replaces stale odd and out-of-range selections');
  await page.screenshot({ path: `${out}/even-range.png`, fullPage: false });

  const omitted = new Set([1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42]);
  const expected = numbers.filter(n => !omitted.has(n));
  const omitRequest = '1- 50, omit (1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42), look at all pages';
  await ask(page, omitRequest);
  assert.equal(expected.length, 38);
  assert.deepEqual(await selectedNumbers(page), expected, 'range exclusions select all 38 desired exercises across pages');
  assert.equal(await page.evaluate(() => window.__syw.state.settings.pages), 2, 'all source pages does not change the printed side count');
  assert.doesNotMatch(await page.locator('#toast').textContent(), /not detected|not selected|local AI/i);
  await page.screenshot({ path: `${out}/range-with-exclusions.png`, fullPage: false });
  await ask(page, '1-40 even');

  await ask(page, 'add 41');
  assert.deepEqual(await selectedNumbers(page), [...evens, 41], 'explicit add is incremental');
  await ask(page, 'remove 4, 41');
  assert.deepEqual(await selectedNumbers(page), evens.filter(n => n !== 4), 'explicit remove is incremental');

  // A numbered manual crop takes precedence over the automatic crop of the same
  // source exercise; unnumbered manual work is unaffected by a numbered request.
  await page.evaluate(async () => {
    const { manualProblem } = await import('/src/document.js');
    const state = window.__syw.state, model = state.sources[0].pages[0];
    const problem = model.problems.find(p => p.number === 8);
    const manual = manualProblem(model, { ...problem.rect }, 501);
    if (manual.number !== 8) throw new Error('Fixture manual box did not adopt exercise 8');
    state.selected.delete(problem.id); state.selected.set(manual.id, manual);
    const unnumbered = { ...manual, id: `${model.source.id}:0:m502`, number: null, label: '#502' };
    state.selected.set(unnumbered.id, unnumbered);
    window.__manualSelections = { numbered: { id: manual.id, rect: { ...manual.rect } }, unnumbered: unnumbered.id };
  });
  await ask(page, '8, 12');
  assert.deepEqual(await selectedNumbers(page), [8, 12]);
  assert.deepEqual(await page.evaluate(() => {
    const state = window.__syw.state, before = window.__manualSelections;
    return { numbered: { id: state.selected.get(before.numbered.id)?.id, rect: state.selected.get(before.numbered.id)?.rect },
      unnumbered: state.selected.has(before.unnumbered) };
  }), await page.evaluate(() => ({ numbered: window.__manualSelections.numbered, unnumbered: true })), 'matching manual crop and unnumbered manual box survive');

  await ask(page, '4, 99');
  assert.deepEqual(await selectedNumbers(page), [4], 'a partial standalone request selects its detected subset');
  let feedback = await page.locator('#toast').textContent();
  assert.match(feedback, /Not detected.*99/i);
  assert.doesNotMatch(feedback, /not detected.*(?:\b8\b|\b12\b)/i, 'warning lists missing requested labels only');
  assert.equal(await page.locator('#toast').evaluate(t => t.classList.contains('bad')), true);
  assert.equal(await page.evaluate(() => window.__syw.state.selected.has(window.__manualSelections.unnumbered)), true);
  await ask(page, '99');
  assert.deepEqual(await selectedNumbers(page), [4], 'an entirely missing standalone request preserves the selection');
  assert.equal(await page.evaluate(() => window.__syw.state.selected.has(window.__manualSelections.unnumbered)), true);
  await ask(page, '1-4, omit (1-4), look at all pages');
  assert.deepEqual(await selectedNumbers(page), [], 'an explicitly empty desired set clears only numbered choices');
  assert.equal(await page.evaluate(() => window.__syw.state.selected.has(window.__manualSelections.unnumbered)), true);

  await page.locator('[data-mode="numbers"]').click();
  await page.locator('#numbers').fill('2, 6, 98');
  await page.locator('#numbers-form button').click();
  await page.waitForFunction(() => !document.querySelector('#numbers-form button').disabled);
  assert.deepEqual(await selectedNumbers(page), [2, 6], 'the Numbers selector also sets the desired numbered selection');
  feedback = await page.locator('#toast').textContent();
  assert.match(feedback, /Not detected.*98/i);
  await page.waitForFunction(() => !!window.__syw.state.pdf && /^3 problems on/.test(document.querySelector('#exam-status').textContent));
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(`${out}/range-selection-exam.pdf`);
  const exam = await PDFDocument.load(await readFile(`${out}/range-selection-exam.pdf`));
  assert.equal(exam.getPageCount(), 2);

  // Use original generated pages to exercise duplicate section numbering without
  // embedding the user's textbook in the repository or suppressing other sources.
  const reviewPage = await browser.newPage({ ignoreHTTPSErrors: true });
  reviewPage.on('pageerror', e => errors.push(e.message));
  await reviewPage.goto(`${BASE}/`);
  await reviewPage.waitForFunction(() => !!window.__syw);
  await addFile(reviewPage, await exercises([1], [1, 2]), 'main-and-review.pdf');
  await addFile(reviewPage, await exercises([], [1]), 'review-only.pdf');
  const duplicateDoc = await PDFDocument.create();
  const singlePage = await PDFDocument.load(await exercises([1]));
  for (const copy of await duplicateDoc.copyPages(singlePage, [0, 0])) duplicateDoc.addPage(copy);
  await addFile(reviewPage, await duplicateDoc.save(), 'ordinary-duplicates.pdf');
  assert.deepEqual(await reviewPage.evaluate(() => window.__syw.state.sources[0].pages.map(p => p.problems.map(p => [p.number, p.review]))),
    [[[1, false]], [[1, true], [2, true]]], 'explicit Quick Review heading survives into problem metadata');
  await ask(reviewPage, '1, 2');
  assert.deepEqual(await selectedNumbers(reviewPage), [1, 1, 1, 1, 2]);
  assert.deepEqual(await reviewPage.evaluate(() => {
    const state = window.__syw.state;
    return state.sources.map(s => [...state.selected.values()].filter(p => p.sourceId === s.id).map(p => [p.number, p.review]));
  }), [[[1, false], [2, true]], [[1, true]], [[1, false], [1, false]]],
  'main exercise replaces its own review duplicate; review-only labels and ordinary duplicates survive');
  await reviewPage.close();
  assert.deepEqual(errors, []);
  console.log('RANGE SELECTION OK: exact ranges and exclusions, queued reads, Local AI on, add/remove, manual choices, section duplicates, partial/missing feedback, PDF download');
} finally {
  if (errors.length) console.error(errors.join('\n'));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
