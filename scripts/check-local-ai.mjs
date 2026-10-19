#!/usr/bin/env node
// Opt-in real inference check. This never starts Ollama or installs a model.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createWorksheetServer, loadOptionalEnv } from './serve.mjs';
import { OLLAMA_METADATA_TIMEOUT_MS, OLLAMA_TIMEOUT_MS } from './ai-service.mjs';
import { validateAiPlan } from '../src/ai-plan.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'tests/output/local-ai/plan.json');
const input = resolve(root, 'public/samples/example.png');
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Local AI check cancelled.'));

async function readJson(response) {
  try { return await response.json(); }
  catch { throw new Error('The local helper returned an unreadable response.'); }
}

async function main() {
  loadOptionalEnv(root);
  const png = await readFile(input);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('The synthetic sample PNG is missing or invalid.');
  }
  const image = { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20), text: '' };
  const server = createWorksheetServer({ root, host: 'localhost' });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, 'localhost', () => { server.off('error', reject); resolve(); });
    });
    const origin = `http://localhost:${server.address().port}`;
    const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    const statusResponse = await fetch(`${origin}/api/ai/status`, {
      headers, redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(OLLAMA_METADATA_TIMEOUT_MS * 3 + 2000)]),
    });
    const status = await readJson(statusResponse);
    if (!statusResponse.ok || status.available !== true) {
      throw new Error(status.message || status.error || 'Local Ollama formatting is unavailable.');
    }
    if (status.provider !== 'Ollama') throw new Error('This check requires the local Ollama provider.');
    console.log(`Checking installed local model ${status.model} with the synthetic sample…`);
    const started = performance.now();
    const response = await fetch(`${origin}/api/ai/format`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ images: [image] }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS + 15_000)]),
    });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || 'Local inference failed.');
    const plan = validateAiPlan(result.plan, 1);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n');
    console.log(`Passed: ${result.model || status.model}; ${plan.blocks.length} blocks; ${((performance.now() - started) / 1000).toFixed(1)} seconds.`);
    console.log('Saved tests/output/local-ai/plan.json.');
    console.log('This checks a real local request and the plan schema, not transcription quality. Review the wording and image boundaries yourself.');
  } finally {
    controller.abort();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

try { await main(); }
catch (error) {
  console.error(`Local AI check failed: ${error.message || error}`);
  process.exitCode = 1;
}
