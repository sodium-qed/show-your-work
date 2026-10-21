import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('local server starts and serves from a path containing spaces, # and non-ASCII characters', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'show-your-work space # café-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, 'scripts'));
  const script = join(directory, 'scripts', 'serve.mjs');
  await copyFile(new URL('../scripts/serve.mjs', import.meta.url), script);
  const html = '<!doctype html><title>Release startup check</title><p>Served from the correct directory.</p>';
  await writeFile(join(directory, 'index.html'), html);

  // A different cwd ensures the server resolves its own location, not the caller's.
  child = spawn(process.execPath, [script], {
    cwd: tmpdir(),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 5000);
    t.after(() => clearTimeout(timer));
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup (${code}): ${errors}`));
    });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(await response.text(), html);
});
