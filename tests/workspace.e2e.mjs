// Real source PDF, UI controls, printed axis labels, and stale-export protection.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createStaticServer } from '../scripts/serve.mjs';

const out = process.env.OUT || 'tests/output/workspace';
await mkdir(out, { recursive: true });
const server = createStaticServer(process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined).listen(0);
await once(server, 'listening');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const selected = () => page.evaluate(() => [...window.__syw.state.selected.values()].map(p => p.number).sort((a, b) => a - b));
const waitPdf = () => page.waitForFunction(() => !!window.__syw.state.pdf && !document.querySelector('#download').disabled);
const ask = async text => {
  await page.locator('#ask-input').fill(text);
  await page.locator('#ask button').click();
  await page.waitForFunction(() => !document.querySelector('#ask button').disabled);
};
async function exportText() {
  await waitPdf();
  const bytes = new Uint8Array(await page.evaluate(() => [...window.__syw.state.pdf]));
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const text = [];
  for (let n = 1; n <= doc.numPages; n++) text.push(...(await (await doc.getPage(n)).getTextContent()).items.map(i => i.str));
  await doc.destroy();
  return { bytes, text: text.join(' ') };
}
try {
  await page.goto(`http://localhost:${server.address().port}`);
  await page.locator('#sample').click();
  await waitPdf();
  const green = [2, 3, 5, 10, 12, 17, 19, 22, 26, 29, 34];
  assert.deepEqual(await selected(), green, 'all and only green sample marks');
  assert.equal(await page.locator('#set-pages').inputValue(), '0');
  assert.equal(await page.locator('#set-space').inputValue(), 'compact');
  await ask('add 4, 31');
  await page.locator('#colors button').filter({ hasText: 'Green' }).click();
  assert.deepEqual(await selected(), green, 'color click removes unrelated prior choices');
  await page.locator('#colors button').filter({ hasText: 'Green' }).click();
  assert.deepEqual(await selected(), green, 'repeating a color selection is idempotent');
  await page.locator('#colors button').filter({ hasText: 'Yellow' }).click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), [...green, 31].sort((a, b) => a - b), 'shift adds a second color');
  await page.locator('#colors button').filter({ hasText: 'Yellow' }).click();
  assert.deepEqual(await selected(), [31], 'plain click selects only that color');

  await ask('only 17, 19, 22');
  await waitPdf();
  const workArea = page.getByLabel('Work area for this group');
  await workArea.selectOption('complex');
  await page.getByLabel('Range ± for this group').waitFor();
  const range = page.getByLabel('Range ± for this group');
  await range.fill('10');
  await range.dispatchEvent('change');
  assert.equal(await page.locator('#download').isDisabled(), true, 'old PDF cannot be exported after a change');
  const complex = await exportText();
  assert.match(complex.text, /Re/);
  assert.match(complex.text, /Im/);
  assert.match(complex.text, /10/);
  assert.match(complex.text, /-10/);
  await writeFile(`${out}/complex-plane.pdf`, complex.bytes);
  await page.screenshot({ path: `${out}/complex-plane.png`, fullPage: true });
  await page.getByLabel('Range ± for this group').fill('');
  await page.getByLabel('Range ± for this group').dispatchEvent('change');
  await waitPdf();
  assert.ok(await page.evaluate(() => [...window.__syw.state.aids.values()].every(a => a.extent === undefined)), 'clearing range restores auto');

  for (const aid of ['numberline', 'lined', 'dot', 'polar', 'xy', 'blank', 'line']) {
    await page.getByLabel('Work area for this group').selectOption(aid);
    await waitPdf();
    assert.equal(await page.getByLabel('Work area for this group').inputValue(), aid);
  }
  await ask('complex planes, radius 10');
  await waitPdf();
  assert.equal(await page.getByLabel('Work area for this group').inputValue(), 'complex');
  assert.equal(await page.getByLabel('Range ± for this group').inputValue(), '10');
  assert.deepEqual(await selected(), [17, 19, 22], 'graph range is never an exercise number');
  await page.locator('#set-pages').selectOption('4');
  await page.locator('#set-space').selectOption('large');
  await page.locator('#save-paper').click();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await waitPdf();
  assert.equal(await page.locator('#set-pages').inputValue(), '0');
  assert.equal(await page.locator('#set-space').inputValue(), 'compact');
  assert.match(await page.locator('#selection-summary').textContent(), /17, 19, 22/);
  assert.deepEqual(errors, []);
  console.log('Workspace UI: green selection, color replacement/addition, all work aids, graph ranges, compact settings, PDF labels, and stale-export protection passed.');
} finally {
  await browser.close();
  server.close();
}
