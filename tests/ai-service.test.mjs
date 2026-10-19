import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorksheetServer, loadOptionalEnv } from '../scripts/serve.mjs';
import { AI_LIMITS, DEFAULT_OPENAI_MODEL, validateAiRequest } from '../scripts/ai-service.mjs';
import { AI_PLAN_SCHEMA, AI_SYSTEM_PROMPT } from '../src/ai-plan.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEST_KEY = 'unit-test-key-never-use-for-live-requests';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFKsAAAAASUVORK5CYII=';
const image = (extra = {}) => ({ dataUrl: PNG, width: 1, height: 1, ...extra });
const plan = () => ({ blocks: [{ kind: 'text', source: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: 'Find the value. Keep the original equation below.' }], warnings: [] });
const provider = (extra = {}) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan()) }] }], usage: { input_tokens: 1234, output_tokens: 56 }, ...extra });
const success = () => new Response(JSON.stringify(provider()), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function running(t, options = {}) {
  const server = createWorksheetServer({ root, env: { OPENAI_API_KEY: TEST_KEY }, fetchImpl: async () => success(), ...options });
  server.listen(0, 'localhost'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, port: server.address().port, origin: `http://localhost:${server.address().port}` };
}

function exchange(app, { method = 'POST', path = '/api/ai/format', headers = {}, body = JSON.stringify({ images: [image()] }), chunks, finish = true } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...(method === 'POST' ? { Origin: app.origin, 'Content-Type': 'application/json' } : {}), ...headers };
    for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === null) delete finalHeaders[key];
    const req = httpRequest({ hostname: 'localhost', port: app.port, method, path, headers: finalHeaders, agent: false }, res => {
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.once('end', () => {
        const text = Buffer.concat(data).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        if (!finish) req.destroy();
      });
      res.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local test request timed out.')));
    req.once('error', reject);
    if (method !== 'GET' && method !== 'HEAD') {
      if (chunks) for (const chunk of chunks) req.write(chunk);
      else if (body) req.write(body);
    }
    if (finish) req.end(); else req.flushHeaders();
  });
}

test('status reports configuration without a key or provider call; static app works unconfigured', async t => {
  let calls = 0;
  const app = await running(t, { env: {}, fetchImpl: async () => { calls++; throw new Error('Must not call OpenAI.'); } });
  const status = await exchange(app, { method: 'GET', path: '/api/ai/status' });
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(status.data).sort(), ['available', 'message', 'model', 'provider']);
  assert.equal(status.data.available, false); assert.equal(status.data.provider, 'OpenAI');
  assert.equal(status.data.model, 'gpt-5.6-terra'); assert.match(status.data.message, /OPENAI_API_KEY/);
  assert.equal(status.headers['cache-control'], 'no-store'); assert.equal(status.headers['access-control-allow-origin'], undefined);
  const format = await exchange(app);
  assert.equal(format.status, 503); assert.equal(format.data.code, 'unconfigured');
  assert.equal((await exchange(app, { method: 'GET', path: '/' })).status, 200);
  assert.equal(calls, 0);
});

test('a successful request sends vision input and a strict Responses schema exactly once', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return success(); } });
  const status = await exchange(app, { method: 'GET', path: '/api/ai/status' });
  assert.deepEqual(status.data, { available: true, provider: 'OpenAI', model: DEFAULT_OPENAI_MODEL });
  const result = await exchange(app, { body: JSON.stringify({ images: [image({ text: 'A text-layer hint.' }), image()] }) });
  assert.equal(result.status, 200); assert.deepEqual(result.data, { plan: plan(), model: DEFAULT_OPENAI_MODEL, usage: { inputTokens: 1234, outputTokens: 56 } });
  assert.equal(calls.length, 1);
  const [{ url, options }] = calls, payload = JSON.parse(options.body);
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(options.headers['Content-Type'], 'application/json'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(payload.model, DEFAULT_OPENAI_MODEL); assert.equal(payload.store, false); assert.equal(payload.max_output_tokens, 8192);
  assert.equal(payload.instructions, AI_SYSTEM_PROMPT);
  assert.deepEqual(payload.text.format, { type: 'json_schema', name: 'worksheet_layout', strict: true, schema: AI_PLAN_SCHEMA });
  assert.equal(payload.input[0].role, 'user');
  assert.deepEqual(payload.input[0].content.filter(part => part.type === 'input_image'), [1, 2].map(() => ({ type: 'input_image', image_url: PNG, detail: 'high' })));
  assert.match(payload.input[0].content[1].text, /Source 0: 1 by 1 pixels/); assert.match(payload.input[0].content[1].text, /A text-layer hint/);
  assert.match(payload.input[0].content[3].text, /Source 1:/);
  assert.equal(options.body.includes(TEST_KEY), false); assert.equal(result.text.includes(TEST_KEY), false);
  assert.equal(Object.hasOwn(payload, 'tools'), false); assert.equal(Object.hasOwn(payload, 'reasoning'), false);
});

test('model configuration is server-owned and invalid configuration never exposes credentials', async t => {
  const app = await running(t, { env: { OPENAI_API_KEY: TEST_KEY, OPENAI_MODEL: 'gpt-5.6-terra-2026-09-10' }, fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).model, 'gpt-5.6-terra-2026-09-10'); return success();
  } });
  assert.equal((await exchange(app)).data.model, 'gpt-5.6-terra-2026-09-10');
  const invalid = await running(t, { env: { OPENAI_API_KEY: TEST_KEY, OPENAI_MODEL: TEST_KEY } });
  const status = await exchange(invalid, { method: 'GET', path: '/api/ai/status' });
  assert.equal(status.data.available, false); assert.equal(status.text.includes(TEST_KEY), false);
  assert.equal((await exchange(invalid)).status, 503);
});

test('request validation accepts six PNG sources and bounded text hints without mutating input', () => {
  const request = { images: Array.from({ length: 6 }, (_, index) => image({ text: String(index) })) };
  const copy = structuredClone(request), accepted = validateAiRequest(request);
  assert.deepEqual(request, copy); assert.equal(accepted.length, 6); assert.notEqual(accepted[0], request.images[0]);
  assert.equal(validateAiRequest({ images: [image({ text: '𝑥'.repeat(6000) })] })[0].text.length, 12000);
});

test('PNG/JPEG headers must match declared dimensions, and JPEG marker parsing always advances', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 217]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  assert.equal(validateAiRequest({ images: [{ dataUrl, width: 3, height: 2 }] }).length, 1);
  for (const bytes of [[255, 216, 255, 224, 0, 0], [255, 216, 255], [255, 216, 255, 224, 255, 255]]) {
    assert.throws(() => validateAiRequest({ images: [image({ dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}` })] }), /image header/);
  }
});

test('invalid request shapes, encodings, dimensions, and hint sizes are rejected before paid work', () => {
  const cases = [null, [], {}, { images: [] }, { images: Array(7).fill(image()) }, { images: [image()], model: 'arbitrary-model' },
    { images: [null] }, { images: [image({ extra: true })] }, { images: [image({ width: '1' })] }, { images: [image({ width: 0 })] },
    { images: [image({ width: 1.5 })] }, { images: [image({ width: 14_001 })] }, { images: [image({ width: 5000, height: 5000 })] },
    { images: [image({ width: 2 })] }, { images: [image({ dataUrl: 'https://example.test/image.png' })] },
    { images: [image({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })] }, { images: [image({ dataUrl: 'data:image/png;base64,!!!!' })] },
    { images: [image({ dataUrl: 'data:image/png;base64,AB==' })] }, { images: [image({ dataUrl: 'data:image/jpeg;base64,' + PNG.split(',')[1] })] },
    { images: [image({ text: 42 })] }, { images: [image({ text: 'x'.repeat(6001) })] },
    { images: Array(5).fill(image({ text: 'x'.repeat(6000) })) }];
  for (const value of cases) assert.throws(() => validateAiRequest(value), { status: 400 });
});

test('HTTP JSON validation fails without a provider request and releases the request slot', async t => {
  let calls = 0;
  const app = await running(t, { fetchImpl: async () => { calls++; return success(); } });
  for (const body of ['{', 'null', JSON.stringify({ images: [] }), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
    const result = await exchange(app, { body });
    assert.equal(result.status, 400); assert.equal(result.data.code, 'invalid_request');
  }
  assert.equal(calls, 0); assert.equal((await exchange(app)).status, 200); assert.equal(calls, 1);
});

test('exact Host and Origin checks block cross-origin and rebinding requests without CORS', async t => {
  let calls = 0;
  const app = await running(t, { fetchImpl: async () => { calls++; return success(); } });
  const cases = [ { Host: `evil.test:${app.port}` }, { Host: `LOCALHOST:${app.port}` }, { Host: 'localhost:1' },
    { Origin: null }, { Origin: 'null' }, { Origin: 'https://example.test' }, { Origin: app.origin + '.evil.test' },
    { Origin: `https://localhost:${app.port}` }, { 'Sec-Fetch-Site': 'cross-site' } ];
  for (const headers of cases) {
    const response = await exchange(app, { headers });
    assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await exchange(app, { method: 'GET', path: '/api/ai/status', headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await exchange(app, { method: 'OPTIONS', headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal(calls, 0);
});

test('a non-localhost configuration leaves static routes working and disables AI', async t => {
  let calls = 0;
  const app = await running(t, { host: 'example.test', fetchImpl: async () => { calls++; return success(); } });
  const status = await exchange(app, { method: 'GET', path: '/api/ai/status' });
  assert.equal(status.data.available, false); assert.match(status.data.message, /HOST=localhost/);
  assert.equal((await exchange(app)).status, 403);
  assert.equal((await exchange(app, { method: 'GET', path: '/' })).status, 200); assert.equal(calls, 0);
});

test('methods, content type, and content encoding are checked before provider calls', async t => {
  let calls = 0;
  const app = await running(t, { fetchImpl: async () => { calls++; return success(); } });
  assert.equal((await exchange(app, { method: 'GET' })).status, 405);
  assert.equal((await exchange(app, { path: '/api/ai/unknown' })).status, 404);
  for (const value of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=utf-16']) {
    assert.equal((await exchange(app, { headers: { 'Content-Type': value } })).status, 415);
  }
  assert.equal((await exchange(app, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal(calls, 0);
  assert.equal((await exchange(app, { headers: { 'Content-Type': 'application/json; charset=UTF-8' } })).status, 200);
});

test('declared and streamed bodies above 12 MiB are rejected before any paid request', async t => {
  let calls = 0;
  const app = await running(t, { fetchImpl: async () => { calls++; return success(); } });
  assert.equal((await exchange(app, { headers: { 'Content-Length': String(AI_LIMITS.bodyBytes + 1) }, body: '' })).status, 413);
  const large = await exchange(app, { chunks: [' '.repeat(AI_LIMITS.bodyBytes), ' '] });
  assert.equal(large.status, 413); assert.equal(large.data.code, 'too_large'); assert.equal(calls, 0);
  assert.equal((await exchange(app)).status, 200);
});

test('provider HTTP failures use useful fixed messages, never raw provider errors or paid retries', async t => {
  for (const [status, expected, code] of [[401, 502, 'provider_auth'], [403, 502, 'provider_auth'], [429, 429, 'provider_limit'], [500, 503, 'provider_unavailable'], [400, 502, 'provider_request']]) {
    let calls = 0;
    const app = await running(t, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: TEST_KEY, request: PNG } }), { status }); } });
    const result = await exchange(app);
    assert.equal(result.status, expected); assert.equal(result.data.code, code); assert.equal(calls, 1);
    assert.equal(result.text.includes(TEST_KEY), false); assert.equal(result.text.includes(PNG), false);
  }
});

test('network errors and redirects never expose transport details or credentials', async t => {
  const app = await running(t, { fetchImpl: async (_, options) => { assert.equal(options.redirect, 'error'); throw new Error(`Transport detail ${TEST_KEY}`); } });
  const result = await exchange(app);
  assert.equal(result.status, 503); assert.match(result.data.error, /could not reach OpenAI/); assert.equal(result.text.includes(TEST_KEY), false);
});

test('multiple output_text parts are joined; reasoning and raw response fields are not returned', async t => {
  const text = JSON.stringify(plan()), midpoint = Math.floor(text.length / 2);
  const app = await running(t, { fetchImpl: async () => new Response(JSON.stringify(provider({
    model: TEST_KEY, private_field: TEST_KEY, usage: { input_tokens: -1, output_tokens: '56', secret: TEST_KEY },
    output: [{ type: 'reasoning', summary: [TEST_KEY] }, { type: 'message', content: [{ type: 'output_text', text: text.slice(0, midpoint) }, { type: 'output_text', text: text.slice(midpoint) }] }],
  }))) });
  const result = await exchange(app);
  assert.equal(result.status, 200); assert.deepEqual(result.data.plan, plan());
  assert.deepEqual(result.data.usage, { inputTokens: null, outputTokens: null }); assert.equal(result.text.includes(TEST_KEY), false);
});

test('refusals, unfinished results, invalid plans, and malformed provider JSON never reach the review UI as a plan', async t => {
  const badSource = plan(); badSource.blocks[0].source = 5;
  const leakedKey = plan(); leakedKey.blocks[0].text = TEST_KEY;
  const cases = [
    [provider({ output: [{ content: [{ type: 'refusal', refusal: TEST_KEY }] }] }), 422, 'refused'],
    [provider({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 502, 'incomplete'],
    [provider({ status: 'failed', error: { message: TEST_KEY } }), 502, 'incomplete'],
    [provider({ output: [] }), 502, 'invalid_plan'],
    [provider({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(badSource) }] }] }), 502, 'invalid_plan'],
    [provider({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(leakedKey) }] }] }), 502, 'invalid_response'],
    ['not json ' + TEST_KEY, 502, 'invalid_response'],
  ];
  for (const [value, status, code] of cases) {
    const app = await running(t, { fetchImpl: async () => new Response(typeof value === 'string' ? value : JSON.stringify(value)) });
    const result = await exchange(app);
    assert.equal(result.status, status); assert.equal(result.data.code, code); assert.equal(Object.hasOwn(result.data, 'plan'), false);
    assert.equal(result.text.includes(TEST_KEY), false);
  }
});

test('provider response size is bounded', async t => {
  const app = await running(t, { fetchImpl: async () => new Response(' '.repeat(AI_LIMITS.responseBytes + 1)) });
  const result = await exchange(app);
  assert.equal(result.status, 502); assert.equal(result.data.code, 'invalid_response'); assert.match(result.data.error, /oversized/);
});

test('only one request is in flight; a completed request releases the slot', async t => {
  let signal, calls = 0;
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const app = await running(t, { fetchImpl: async (_, options) => { calls++; signal = options.signal; started.resolve(); return calls === 1 ? finish.promise : success(); } });
  const first = exchange(app); await started.promise;
  const second = await exchange(app);
  assert.equal(second.status, 429); assert.equal(second.data.code, 'busy'); assert.equal(calls, 1); assert.equal(signal.aborted, false);
  finish.resolve(success()); assert.equal((await first).status, 200);
  assert.equal((await exchange(app)).status, 200); assert.equal(calls, 2);
});

test('timeout aborts the provider, never retries, and frees the slot', async t => {
  let signal, calls = 0;
  const app = await running(t, { timeoutMs: 35, fetchImpl: async (_, options) => { calls++; signal = options.signal; return calls === 1 ? new Promise(() => {}) : success(); } });
  const result = await exchange(app);
  assert.equal(result.status, 504); assert.equal(result.data.code, 'timeout'); assert.equal(signal.aborted, true); assert.equal(calls, 1);
  assert.equal((await exchange(app)).status, 200); assert.equal(calls, 2);
});

test('the timeout also bounds a client that never finishes uploading JSON', async t => {
  let calls = 0;
  const app = await running(t, { timeoutMs: 35, fetchImpl: async () => { calls++; return success(); } });
  const result = await exchange(app, { body: '{', finish: false });
  assert.equal(result.status, 504); assert.equal(calls, 0);
  assert.equal((await exchange(app)).status, 200);
});

test('timeout cancels a stalled provider response body after its headers arrive', async t => {
  let calls = 0, cancelled = false;
  const app = await running(t, { timeoutMs: 35, fetchImpl: async () => {
    calls++;
    if (calls > 1) return success();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); },
      cancel() { cancelled = true; },
    }));
  } });
  const result = await exchange(app);
  assert.equal(result.status, 504); assert.equal(cancelled, true); assert.equal(calls, 1);
  assert.equal((await exchange(app)).status, 200);
});

test('disconnecting during upload frees the slot without contacting OpenAI', async t => {
  let calls = 0;
  const app = await running(t, { fetchImpl: async () => { calls++; return success(); } });
  const incoming = once(app.server, 'request');
  const req = httpRequest({ hostname: 'localhost', port: app.port, method: 'POST', path: '/api/ai/format', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.write('{'); req.flushHeaders();
  const [received] = await incoming;
  const abandoned = once(received, 'aborted');
  req.destroy(); await abandoned;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal((await exchange(app)).status, 200); assert.equal(calls, 1);
});

test('client disconnection aborts the provider and permits a later request', async t => {
  let calls = 0;
  const started = Promise.withResolvers(), aborted = Promise.withResolvers();
  const app = await running(t, { fetchImpl: async (_, options) => {
    calls++;
    if (calls > 1) return success();
    options.signal.addEventListener('abort', () => aborted.resolve(options.signal.reason), { once: true });
    started.resolve(); return new Promise(() => {});
  } });
  const req = httpRequest({ hostname: 'localhost', port: app.port, method: 'POST', path: '/api/ai/format', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.end(JSON.stringify({ images: [image()] }));
  await started.promise; req.destroy();
  assert.equal((await aborted.promise).code, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await exchange(app)).status, 200); assert.equal(calls, 2);
});

test('dev and dist static routes deny secrets, scripts, tests, and symlink escapes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worksheet-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(['src', 'scripts', 'tests'].map(name => mkdir(join(dir, name))));
  await Promise.all([
    writeFile(join(dir, 'index.html'), 'public app'), writeFile(join(dir, 'src/index.html'), 'public app'),
    writeFile(join(dir, '.env'), TEST_KEY), writeFile(join(dir, '.env.example'), TEST_KEY),
    writeFile(join(dir, 'scripts/private.mjs'), TEST_KEY), writeFile(join(dir, 'tests/private.json'), TEST_KEY),
    symlink(join(dir, '.env'), join(dir, 'src/leak.txt')),
  ]);
  for (const prod of [false, true]) {
    const app = await running(t, { root: dir, prod, env: {} });
    for (const path of ['/.env', '/%2eenv', '/.env.example', '/scripts/private.mjs', '/tests/private.json', '/src/leak.txt']) {
      const result = await exchange(app, { method: 'GET', path });
      assert.equal(result.status, 403, `${prod ? 'dist' : 'dev'} ${path}`); assert.equal(result.text.includes(TEST_KEY), false);
    }
    const index = await exchange(app, { method: 'GET', path: '/' });
    assert.equal(index.status, 200); assert.equal(index.text, 'public app'); assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal((await exchange(app, { method: 'HEAD', path: '/' })).text, '');
  }
});

test('optional .env loads before configuration and does not override existing environment values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worksheet-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(loadOptionalEnv(dir), false);
  await writeFile(join(dir, '.env'), `OPENAI_API_KEY=${TEST_KEY}\nOPENAI_MODEL=from-file\n`);
  const script = `import {loadOptionalEnv} from ${JSON.stringify(pathToFileURL(resolve(root, 'scripts/serve.mjs')).href)}; const loaded=loadOptionalEnv(${JSON.stringify(dir)}); console.log(JSON.stringify({loaded,keyMatches:process.env.OPENAI_API_KEY===${JSON.stringify(TEST_KEY)},model:process.env.OPENAI_MODEL}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { OPENAI_MODEL: 'existing-model' } });
  assert.deepEqual(JSON.parse(stdout), { loaded: true, keyMatches: true, model: 'existing-model' });
  assert.equal(stdout.includes(TEST_KEY), false);
});
