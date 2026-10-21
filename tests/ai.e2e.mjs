// Browser check of the local model path: load the AI, send requests through the box,
// and confirm what changed. Downloads the model (~0.5 GB) on first run and needs WebGPU.
// Without WebGPU (e.g. CI), exercise the same code path with a CPU-friendly model:
//   AI_MODEL='{"id":"onnx-community/Qwen3-0.6B-ONNX","dtype":"quantized","device":"wasm"}' node tests/ai.e2e.mjs
import { chromium } from 'playwright';
import { createStaticServer } from '../scripts/serve.mjs';

const HOST = process.env.E2E_HOST || 'localhost';
const BASE = `http://${HOST}:4198`;
const server = createStaticServer().listen(4198, HOST === 'localhost' ? undefined : HOST);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: HOST } : undefined;
const browser = await chromium.launch({ proxy, args: [`--unsafely-treat-insecure-origin-as-secure=${BASE}`, '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
page.on('pageerror', e => console.log('[pageerror]', e.message));
const t0 = Date.now();
try {
  await page.goto(`${BASE}/`);
  if (process.env.AI_MODEL) await page.evaluate(m => localStorage.setItem('syw.model', m), process.env.AI_MODEL);
  await page.setInputFiles('#file', 'samples/sample.pdf');
  await page.waitForFunction(() => window.__syw?.state.selected.size > 0, null, { timeout: 120_000 });
  await page.click('#ai-load');
  await page.waitForFunction(() => /Local AI (on|unavailable|needs)/.test(document.querySelector('#ai-status').textContent), null, { timeout: 1_200_000, polling: 2000 });
  if (!/on/.test(await page.textContent('#ai-status'))) throw new Error(`${await page.textContent('#ai-status')}: ${await page.getAttribute('#ai-status', 'title')}`);
  console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, await page.textContent('#ai-status'));
  const cases = [
    ['start over with only the yellow ones', s => s.selected.join() === '31'],
    ['请帮我把所有绿色的问题全部都提取出来，考试风格，紧凑一些。一页double side。', s => s.selected.length === 11 && s.pages === 2 && s.space === 'fill'],
    ['get rid of number 5 and 10', s => !s.selected.includes(5) && !s.selected.includes(10) && s.selected.length === 9],
    ['put three problems on each line and print on European paper', s => s.columns === 3 && s.paper === 'a4'],
  ];
  let ok = 0;
  for (const [text, check] of cases) {
    const s0 = Date.now();
    await page.fill('#ask-input', text);
    await page.click('#ask button');
    await page.waitForFunction(() => document.querySelector('#ask button').textContent === 'Apply', null, { timeout: 300_000 });
    const s = await page.evaluate(() => ({ selected: [...window.__syw.state.selected.values()].map(p => p.number).sort((a, b) => a - b), ...window.__syw.state.settings, toast: document.querySelector('#toast').textContent }));
    const pass = check(s); ok += pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${((Date.now() - s0) / 1000).toFixed(1)}s  ${text.slice(0, 40)}  →  ${s.toast}`);
  }
  console.log(`${ok}/${cases.length}`);
  if (ok < cases.length) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
