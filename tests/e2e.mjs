// End-to-end check in headless Chromium: open a textbook page with green highlights,
// confirm the right problems are picked up, and save the exam PDF and screenshots.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { resolve } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';
import { mkdir, readFile } from 'node:fs/promises';

const input = process.argv[2] || 'samples/sample.pdf';
const expect = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
const out = process.env.OUT || 'tests/output';
await mkdir(out, { recursive: true });
// The sandbox proxy refuses plain-HTTP loopback requests, so serve on a LAN address when one is set.
const HOST = process.env.E2E_HOST || 'localhost';
const BASE = `http://${HOST}:4199`;
const root = process.env.E2E_ROOT ? resolve(process.env.E2E_ROOT) : undefined;
const server = createStaticServer(root).listen(4199, HOST === 'localhost' ? undefined : HOST);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
const browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
try {
  await page.goto(`${BASE}/`);
  await page.setInputFiles('#file', input);
  await page.waitForFunction(() => { const s = window.__syw?.state.sources[0]; return !!s && s.pages.filter(Boolean).length === s.pageCount; }, null, { timeout: 240_000 });
  await page.waitForFunction(() => !!window.__syw.state.pdf, null, { timeout: 120_000 });
  if (process.env.ASK) {
    // Optional request typed into the box, e.g. ASK="clear, then 85 and 86".
    await page.evaluate(async text => { await window.__syw.ask(text); await window.__syw.rebuild(); }, process.env.ASK);
  }
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const s = window.__syw.state;
    return {
      selected: [...s.selected.values()].map(p => p.number).sort((a, b) => a - b),
      pages: s.sources[0].pages.map(p => ({ problems: p.problems.length, ocr: p.ocr, marks: p.marks.map(m => `${m.color}:${m.anchor}`), directions: p.directions.map(d => [d.text.slice(0, 50), d.printable, d.aid.kind, !!d.figure]) })),
      status: document.querySelector('#exam-status').textContent,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  assert.ok(await page.locator('#download').isEnabled(), 'PDF download is available');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download').click(),
  ]);
  assert.equal(await download.failure(), null, 'PDF download succeeds');
  await download.saveAs(`${out}/exam.pdf`);
  const pdf = await PDFDocument.load(await readFile(`${out}/exam.pdf`));
  assert.ok(pdf.getPageCount() > 0, 'downloaded PDF contains pages');
  console.log(`PDF EXPORT OK: ${pdf.getPageCount()} page(s)`);
  await page.screenshot({ path: `${out}/app.png`, fullPage: false });
  if (expect) {
    const miss = expect.filter(n => !info.selected.includes(n)), extra = info.selected.filter(n => !expect.includes(n));
    console.log(miss.length || extra.length ? `MISMATCH missing=${miss} extra=${extra}` : 'SELECTION OK');
    if (miss.length || extra.length) process.exitCode = 1;
  }
  assert.ok(!logs.some(l => l.startsWith('[pageerror]')), 'no browser application errors');
} finally {
  if (logs.some(l => /error/i.test(l))) console.log(logs.filter(l => /error|warn/i.test(l)).slice(0, 20).join('\n'));
  await browser.close(); server.close();
}
