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
import { deflateSync } from 'node:zlib';
import { createWorksheetServer, loadOptionalEnv } from '../scripts/serve.mjs';
import { AI_LIMITS, DEFAULT_OLLAMA_MODEL, OLLAMA_TIMEOUT_MS, OLLAMA_METADATA_TIMEOUT_MS, validateAiRequest } from '../scripts/ai-service.mjs';
import { AI_PLAN_SCHEMA, AI_SYSTEM_PROMPT } from '../src/ai-plan.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE_MARKER = 'private-test-detail-never-display';
const OLLAMA = 'http://localhost:11434';
// Generate real grayscale PNGs, including their checksums, so size-boundary
// tests do not depend on a misleading edited header or image libraries.
function pngImage(width, height) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), content = Buffer.concat([name, bytes]);
    let checksum = 0xffffffff;
    for (const byte of content) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height };
}
const PNG = pngImage(32, 32).dataUrl;
const image = (extra = {}) => ({ dataUrl: PNG, width: 32, height: 32, ...extra });
const plan = () => ({ blocks: [{ kind: 'text', source: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: 'Find the value. Keep the original equation below.' }], warnings: [] });
const metadata = (extra = {}) => ({ capabilities: ['completion', 'vision'], ...extra });
const provider = (extra = {}) => ({ model: DEFAULT_OLLAMA_MODEL, message: { role: 'assistant', content: JSON.stringify(plan()) }, done: true, done_reason: 'stop', prompt_eval_count: 1234, eval_count: 56, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const success = () => json(provider());

// Every server gets this mock by default. Tests never contact Ollama or load a model.
function localFetch({ calls = [], show = () => json(metadata()), chat = () => success() } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url === `${OLLAMA}/api/show`) return show(options);
    if (url === `${OLLAMA}/api/chat`) return chat(options);
    throw new Error(`Unexpected provider URL: ${url}`);
  };
}

async function running(t, options = {}) {
  const server = createWorksheetServer({ root, env: {}, fetchImpl: localFetch(), ...options });
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

const getStatus = app => exchange(app, { method: 'GET', path: '/api/ai/status' });
const paths = calls => calls.map(({ url }) => new URL(url).pathname);
function assertNoPlan(result) { assert.equal(Object.hasOwn(result.data, 'plan'), false); }
function assertNoPrivateData(result) {
  assert.equal(result.text.includes(PRIVATE_MARKER), false);
  assert.equal(result.text.includes(PNG), false);
}

test('status probes local model metadata without inference, downloads, or API keys', async t => {
  assert.equal(DEFAULT_OLLAMA_MODEL, 'qwen3-vl:4b-instruct');
  assert.equal(OLLAMA_TIMEOUT_MS, 600_000); assert.equal(OLLAMA_METADATA_TIMEOUT_MS, 5000);
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  const status = await getStatus(app);
  assert.equal(status.status, 200);
  assert.deepEqual(status.data, { available: true, provider: 'Ollama', model: DEFAULT_OLLAMA_MODEL });
  assert.equal(status.headers['cache-control'], 'no-store'); assert.equal(status.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(paths(calls), ['/api/show']);
  const [{ url, options }] = calls;
  assert.equal(url, `${OLLAMA}/api/show`); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { model: DEFAULT_OLLAMA_MODEL });
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal((await exchange(app, { method: 'GET', path: '/' })).status, 200); assert.equal(calls.length, 1);
});

test('an absent or stopped Ollama daemon leaves status unavailable and the static app usable', async t => {
  for (const code of ['ENOENT', 'ECONNREFUSED']) {
    const calls = [];
    const app = await running(t, { fetchImpl: localFetch({ calls, show: () => { throw Object.assign(new Error(PRIVATE_MARKER), { code }); } }) });
    const status = await getStatus(app);
    assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.equal(status.data.provider, 'Ollama');
    assert.equal(status.data.model, DEFAULT_OLLAMA_MODEL); assert.match(status.data.message, /Ollama/); assertNoPrivateData(status);
    const result = await exchange(app);
    assert.equal(result.status, 503); assert.equal(result.data.code, 'provider_unavailable'); assertNoPlan(result); assertNoPrivateData(result);
    assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
    assert.equal((await exchange(app, { method: 'GET', path: '/' })).status, 200);
  }
});

test('a missing local model is reported without pulling it or attempting inference', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls, show: () => json({ error: PRIVATE_MARKER }, 404) }) });
  const status = await getStatus(app);
  assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.match(status.data.message, /pull|install/i); assertNoPrivateData(status);
  const result = await exchange(app);
  assert.equal(result.status, 503); assert.equal(result.data.code, 'model_missing'); assertNoPlan(result); assertNoPrivateData(result);
  assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
});

test('vision capability must be explicit; text-only and malformed capability metadata cannot reach chat', async t => {
  for (const capabilities of [[], ['completion'], ['Vision'], 'vision', null, undefined]) {
    const calls = [];
    const app = await running(t, { fetchImpl: localFetch({ calls, show: () => json(metadata({ capabilities })) }) });
    const status = await getStatus(app);
    assert.equal(status.status, 200); assert.equal(status.data.available, false);
    const result = await exchange(app);
    assert.equal(result.status, 503); assert.equal(result.data.code, 'model_not_vision'); assertNoPlan(result);
    assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
  }
});

test('remote models and malformed remote metadata are rejected even when vision is present', async t => {
  for (const field of ['remote_model', 'remote_host']) {
    for (const value of ['qwen3-vl:cloud', 'https://remote.example.test', false, 0, {}, []]) {
      const calls = [];
      const app = await running(t, { fetchImpl: localFetch({ calls, show: () => json(metadata({ [field]: value })) }) });
      const status = await getStatus(app);
      assert.equal(status.status, 200); assert.equal(status.data.available, false, `${field}=${JSON.stringify(value)}`);
      const result = await exchange(app);
      assert.equal(result.status, 503); assert.equal(result.data.code, 'remote_model'); assertNoPlan(result);
      assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
    }
  }
});

test('empty or null remote fields still permit an installed local vision model', async t => {
  for (const value of ['', null]) {
    const app = await running(t, { fetchImpl: localFetch({ show: () => json(metadata({ remote_model: value, remote_host: value })) }) });
    assert.equal((await getStatus(app)).data.available, true);
    assert.equal((await exchange(app)).status, 200);
  }
});

test('formatting checks fresh metadata rather than trusting an earlier ready status', async t => {
  const calls = []; let ready = true;
  const app = await running(t, { fetchImpl: localFetch({ calls, show: () => json(metadata({ capabilities: ready ? ['vision'] : ['completion'] })) }) });
  assert.equal((await getStatus(app)).data.available, true);
  ready = false;
  const result = await exchange(app);
  assert.equal(result.status, 503); assert.equal(result.data.code, 'model_not_vision'); assertNoPlan(result);
  assert.equal((await getStatus(app)).data.available, false);
  assert.deepEqual(paths(calls), ['/api/show', '/api/show', '/api/show']);
});

test('successful local inference sends the schema, original images in order, and no cloud credentials', async t => {
  const calls = [];
  const app = await running(t, { env: { OPENAI_API_KEY: PRIVATE_MARKER, OPENAI_MODEL: 'ignored-cloud-model', OLLAMA_API_KEY: PRIVATE_MARKER, OLLAMA_HOST: 'https://remote.example.test', OLLAMA_BASE_URL: 'https://remote.example.test' }, fetchImpl: localFetch({ calls }) });
  assert.equal((await getStatus(app)).data.available, true);
  const secondImage = pngImage(64, 32);
  const result = await exchange(app, { body: JSON.stringify({ images: [image({ text: 'A text-layer hint.' }), secondImage] }) });
  assert.equal(result.status, 200); assert.deepEqual(result.data, { plan: plan(), model: DEFAULT_OLLAMA_MODEL, usage: { inputTokens: 1234, outputTokens: 56 } });
  assert.deepEqual(paths(calls), ['/api/show', '/api/show', '/api/chat']);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, OLLAMA); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' }); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body.includes(PRIVATE_MARKER), false);
  }
  const payload = JSON.parse(calls[2].options.body);
  assert.equal(payload.model, DEFAULT_OLLAMA_MODEL); assert.equal(payload.stream, false);
  assert.equal(payload.truncate, false); assert.equal(payload.shift, false);
  assert.deepEqual(payload.format, AI_PLAN_SCHEMA);
  assert.deepEqual(payload.options, { temperature: 0, num_ctx: 16384, num_predict: 8192 });
  assert.equal(payload.messages.length, 2); assert.equal(payload.messages[0].role, 'system');
  assert.ok(payload.messages[0].content.startsWith(AI_SYSTEM_PROMPT)); assert.ok(payload.messages[0].content.includes(JSON.stringify(AI_PLAN_SCHEMA)));
  const user = payload.messages[1];
  assert.equal(user.role, 'user'); assert.deepEqual(user.images, [PNG.split(',')[1], secondImage.dataUrl.split(',')[1]]);
  assert.match(user.content, /Source 0: 32 by 32 pixels/); assert.match(user.content, /A text-layer hint/); assert.match(user.content, /Source 1: 64 by 32 pixels/);
  assert.ok(user.content.indexOf('Source 0:') < user.content.indexOf('Source 1:'));
  assert.equal(Object.hasOwn(payload, 'tools'), false); assert.equal(Object.hasOwn(payload, 'think'), false);
  assertNoPrivateData(result);
});

test('the model is server-owned; URL, namespace, digest, and cloud model configurations are rejected locally', async t => {
  const calls = [], customModel = 'qwen3-vl:8b-instruct';
  const custom = await running(t, { env: { OLLAMA_MODEL: ` ${customModel} ` }, fetchImpl: localFetch({ calls }) });
  assert.equal((await exchange(custom)).data.model, customModel);
  assert.ok(calls.every(({ options }) => JSON.parse(options.body).model === customModel));
  for (const model of ['bad model', 'https://remote.example.test/model', 'team/model:tag', 'model@sha256:123', 'qwen3-vl:cloud', 'qwen3-vl:4b-cloud', 'CLOUD-model']) {
    const rejectedCalls = [];
    const app = await running(t, { env: { OLLAMA_MODEL: model }, fetchImpl: localFetch({ calls: rejectedCalls }) });
    const status = await getStatus(app);
    assert.equal(status.status, 200); assert.equal(status.data.available, false, model);
    const result = await exchange(app);
    assert.equal(result.status, 503); assert.equal(result.data.code, 'unconfigured'); assertNoPlan(result);
    assert.equal(rejectedCalls.length, 0);
  }
});

test('request validation accepts six PNG sources and bounded text hints without mutating input', () => {
  const request = { images: Array.from({ length: 6 }, (_, index) => image({ text: String(index) })) };
  const copy = structuredClone(request), accepted = validateAiRequest(request);
  assert.deepEqual(request, copy); assert.equal(accepted.length, 6); assert.notEqual(accepted[0], request.images[0]);
  assert.equal(validateAiRequest({ images: [image({ text: '𝑥'.repeat(6000) })] })[0].text.length, 12000);
});

test('PNG/JPEG headers must match declared dimensions, and JPEG marker parsing always advances', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 32, 0, 64, 1, 1, 17, 0, 255, 217]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  assert.equal(validateAiRequest({ images: [{ dataUrl, width: 64, height: 32 }] }).length, 1);
  assert.throws(() => validateAiRequest({ images: [image({ width: 33 })] }), /dimensions do not match/);
  for (const bytes of [[255, 216, 255, 224, 0, 0], [255, 216, 255], [255, 216, 255, 224, 255, 255]]) {
    assert.throws(() => validateAiRequest({ images: [image({ dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}` })] }), /image header/);
  }
});

test('images smaller than 32 pixels on either edge are rejected before model inspection', async t => {
  assert.equal(AI_LIMITS.minSide, 32);
  assert.equal(validateAiRequest({ images: [pngImage(32, 32)] }).length, 1);
  const calls = [], app = await running(t, { fetchImpl: localFetch({ calls }) });
  for (const [width, height] of [[1, 32], [31, 32], [32, 31], [32, 1]]) {
    const source = pngImage(width, height);
    assert.throws(() => validateAiRequest({ images: [source] }), { status: 400 });
    const result = await exchange(app, { body: JSON.stringify({ images: [source] }) });
    assert.equal(result.status, 400); assert.equal(result.data.code, 'invalid_request'); assert.match(result.data.error, /larger|32/); assertNoPlan(result);
  }
  assert.equal(calls.length, 0);
});

test('the 200:1 aspect limit applies in both directions and accepts its exact boundary', async t => {
  assert.equal(AI_LIMITS.aspectRatio, 200);
  for (const [width, height] of [[6400, 32], [32, 6400]]) assert.equal(validateAiRequest({ images: [pngImage(width, height)] }).length, 1);
  const calls = [], app = await running(t, { fetchImpl: localFetch({ calls }) });
  for (const [width, height] of [[6401, 32], [32, 6401]]) {
    const source = pngImage(width, height);
    assert.throws(() => validateAiRequest({ images: [source] }), { status: 400 });
    const result = await exchange(app, { body: JSON.stringify({ images: [source] }) });
    assert.equal(result.status, 400); assert.equal(result.data.code, 'invalid_request'); assert.match(result.data.error, /larger/); assertNoPlan(result);
  }
  assert.equal(calls.length, 0);
});

test('invalid request shapes, encodings, dimensions, and hint sizes are rejected before inference', () => {
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

test('HTTP JSON validation fails without a model probe and releases the request slot', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  for (const body of ['{', 'null', JSON.stringify({ images: [] }), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
    const result = await exchange(app, { body });
    assert.equal(result.status, 400); assert.equal(result.data.code, 'invalid_request');
  }
  assert.equal(calls.length, 0); assert.equal((await exchange(app)).status, 200);
  assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
});

test('exact Host and Origin checks block cross-origin and rebinding requests without CORS', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  const cases = [{ Host: `evil.test:${app.port}` }, { Host: `LOCALHOST:${app.port}` }, { Host: 'localhost:1' },
    { Origin: null }, { Origin: 'null' }, { Origin: 'https://example.test' }, { Origin: app.origin + '.evil.test' },
    { Origin: `https://localhost:${app.port}` }, { 'Sec-Fetch-Site': 'cross-site' }];
  for (const headers of cases) {
    const result = await exchange(app, { headers });
    assert.equal(result.status, 403); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ Host: 'evil.test' }, { Origin: 'https://example.test' }]) assert.equal((await exchange(app, { method: 'GET', path: '/api/ai/status', headers })).status, 403);
  assert.equal((await exchange(app, { method: 'OPTIONS', headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal(calls.length, 0);
});

test('a non-localhost configuration leaves static routes working and disables AI', async t => {
  const calls = [];
  const app = await running(t, { host: 'example.test', fetchImpl: localFetch({ calls }) });
  const status = await getStatus(app);
  assert.equal(status.data.available, false); assert.match(status.data.message, /HOST=localhost/);
  assert.equal((await exchange(app)).status, 403);
  assert.equal((await exchange(app, { method: 'GET', path: '/' })).status, 200); assert.equal(calls.length, 0);
});

test('methods, content type, and content encoding are checked before model probes', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  assert.equal((await exchange(app, { method: 'GET' })).status, 405);
  assert.equal((await exchange(app, { path: '/api/ai/unknown' })).status, 404);
  for (const value of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=utf-16']) {
    assert.equal((await exchange(app, { headers: { 'Content-Type': value } })).status, 415);
  }
  assert.equal((await exchange(app, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal(calls.length, 0);
  assert.equal((await exchange(app, { headers: { 'Content-Type': 'application/json; charset=UTF-8' } })).status, 200);
});

test('declared and streamed bodies above 12 MiB are rejected before any provider call', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  assert.equal((await exchange(app, { headers: { 'Content-Length': String(AI_LIMITS.bodyBytes + 1) }, body: '' })).status, 413);
  const large = await exchange(app, { chunks: [' '.repeat(AI_LIMITS.bodyBytes), ' '] });
  assert.equal(large.status, 413); assert.equal(large.data.code, 'too_large'); assert.equal(calls.length, 0);
  assert.equal((await exchange(app)).status, 200);
});

test('provider HTTP failures use fixed local messages without raw errors, authentication prompts, or retries', async t => {
  for (const [status, expected, code] of [[401, 503, 'provider_access'], [403, 503, 'provider_access'], [404, 503, 'model_missing'], [429, 429, 'provider_limit'], [500, 503, 'provider_unavailable'], [400, 502, 'provider_request']]) {
    const calls = [];
    const app = await running(t, { fetchImpl: localFetch({ calls, chat: () => json({ error: PRIVATE_MARKER, request: PNG }, status) }) });
    const result = await exchange(app);
    assert.equal(result.status, expected); assert.equal(result.data.code, code); assertNoPlan(result); assertNoPrivateData(result);
    assert.doesNotMatch(result.data.error, /OPENAI_API_KEY|OLLAMA_API_KEY|billing|Bearer/);
    assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
  }
});

test('context overflow returns a fixed smaller-selection instruction without a partial plan or retry', async t => {
  for (const [status, reason] of [[400, 'input exceeds the maximum context length'], [500, 'context window is full'], [200, 'input is too long for num_ctx'], [413, 'request too large']]) {
    const calls = [];
    const app = await running(t, { fetchImpl: localFetch({ calls, chat: () => json({ ...provider(), error: `${reason}: ${PRIVATE_MARKER}` }, status) }) });
    const result = await exchange(app);
    assert.equal(result.status, 422); assert.equal(result.data.code, 'context_limit'); assert.match(result.data.error, /fewer or smaller regions/);
    assertNoPlan(result); assertNoPrivateData(result); assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
  }
});

test('network errors and redirects never expose transport details or use a cloud fallback', async t => {
  for (const stage of ['show', 'chat']) {
    const calls = [];
    const app = await running(t, { env: { OPENAI_API_KEY: PRIVATE_MARKER }, fetchImpl: localFetch({ calls, [stage]: options => { assert.equal(options.redirect, 'error'); throw new Error(`Transport detail ${PRIVATE_MARKER}`); } }) });
    const result = await exchange(app);
    assert.equal(result.status, 503); assert.equal(result.data.code, 'provider_unavailable'); assert.match(result.data.error, /Ollama/);
    assertNoPlan(result); assertNoPrivateData(result);
    assert.deepEqual(paths(calls), stage === 'show' ? ['/api/show'] : ['/api/show', '/api/chat']);
    assert.ok(calls.every(({ url }) => new URL(url).origin === OLLAMA));
  }
});

test('only the validated message plan and bounded token counts reach the client', async t => {
  const app = await running(t, { fetchImpl: localFetch({ chat: () => json(provider({ model: PRIVATE_MARKER, private_field: PRIVATE_MARKER, prompt_eval_count: -1, eval_count: '56', message: { role: 'assistant', content: JSON.stringify(plan()), thinking: PRIVATE_MARKER } })) }) });
  const result = await exchange(app);
  assert.equal(result.status, 200); assert.deepEqual(result.data, { plan: plan(), model: DEFAULT_OLLAMA_MODEL, usage: { inputTokens: null, outputTokens: null } }); assertNoPrivateData(result);
  const withoutReason = await running(t, { fetchImpl: localFetch({ chat: () => json(provider({ done_reason: undefined })) }) });
  assert.equal((await exchange(withoutReason)).status, 200);
});

test('unfinished and token-limited responses cannot reach the review UI as a plan', async t => {
  for (const extra of [{ done: false }, { done: undefined }, { done: 'true' }, { done_reason: 'length' }, { done_reason: 'load' }, { done_reason: null }]) {
    const app = await running(t, { fetchImpl: localFetch({ chat: () => json(provider(extra)) }) });
    const result = await exchange(app);
    assert.equal(result.status, 502); assert.equal(result.data.code, 'incomplete'); assertNoPlan(result);
  }
});

test('malformed response JSON, invalid message content, and rejected plans leave the worksheet unchanged', async t => {
  const badSource = plan(); badSource.blocks[0].source = 5;
  const badBounds = plan(); badBounds.blocks[0].rect.x = 0.5;
  const extraField = plan(); extraField.blocks[0].html = '<script>unwanted</script>';
  const cases = [
    ['not json ' + PRIVATE_MARKER, 'invalid_response'],
    [provider({ message: {} }), 'invalid_plan'],
    [provider({ message: { content: null } }), 'invalid_plan'],
    [provider({ message: { content: '```json\n' + JSON.stringify(plan()) + '\n```' } }), 'invalid_plan'],
    [provider({ message: { content: JSON.stringify(badSource) } }), 'invalid_plan'],
    [provider({ message: { content: JSON.stringify(badBounds) } }), 'invalid_plan'],
    [provider({ message: { content: JSON.stringify(extraField) } }), 'invalid_plan'],
    [provider({ message: { content: JSON.stringify({ blocks: [], warnings: [] }) } }), 'invalid_plan'],
  ];
  for (const [value, code] of cases) {
    const app = await running(t, { fetchImpl: localFetch({ chat: () => typeof value === 'string' ? new Response(value) : json(value) }) });
    const result = await exchange(app);
    assert.equal(result.status, 502); assert.equal(result.data.code, code); assertNoPlan(result); assertNoPrivateData(result);
  }
});

test('remote execution metadata in a chat response is rejected even after a local preflight', async t => {
  for (const field of ['remote_model', 'remote_host']) {
    const app = await running(t, { fetchImpl: localFetch({ chat: () => json(provider({ [field]: PRIVATE_MARKER })) }) });
    const result = await exchange(app);
    assert.equal(result.status, 503); assert.equal(result.data.code, 'remote_model'); assertNoPlan(result); assertNoPrivateData(result);
  }
});

test('malformed or oversized metadata and chat responses are bounded before plans are exposed', async t => {
  for (const value of [null, [], 'not json ' + PRIVATE_MARKER, ' '.repeat(AI_LIMITS.responseBytes + 1)]) {
    const calls = [];
    const app = await running(t, { fetchImpl: localFetch({ calls, show: () => typeof value === 'string' ? new Response(value) : json(value) }) });
    const status = await getStatus(app);
    assert.equal(status.status, 200); assert.equal(status.data.available, false); assertNoPrivateData(status);
    const result = await exchange(app);
    assert.equal(result.status, 502); assert.equal(result.data.code, 'invalid_response'); assertNoPlan(result); assertNoPrivateData(result);
    assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
  }
  const app = await running(t, { fetchImpl: localFetch({ chat: () => new Response(' '.repeat(AI_LIMITS.responseBytes + 1)) }) });
  const result = await exchange(app);
  assert.equal(result.status, 502); assert.equal(result.data.code, 'invalid_response'); assert.match(result.data.error, /oversized/); assertNoPlan(result);
});

test('only one format request is in flight; a completed request releases the slot', async t => {
  let signal, chatCalls = 0;
  const calls = [], started = Promise.withResolvers(), finish = Promise.withResolvers();
  const app = await running(t, { fetchImpl: localFetch({ calls, chat: options => { chatCalls++; signal = options.signal; started.resolve(); return chatCalls === 1 ? finish.promise : success(); } }) });
  const first = exchange(app); await started.promise;
  const second = await exchange(app);
  assert.equal(second.status, 429); assert.equal(second.data.code, 'busy'); assert.equal(chatCalls, 1); assert.equal(signal.aborted, false);
  assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
  finish.resolve(success()); assert.equal((await first).status, 200);
  assert.equal((await exchange(app)).status, 200); assert.equal(chatCalls, 2);
  assert.deepEqual(paths(calls), ['/api/show', '/api/chat', '/api/show', '/api/chat']);
});

test('a stalled status metadata probe times out without inference and a later status can recover', async t => {
  let signal, showCalls = 0;
  const calls = [];
  const app = await running(t, { metadataTimeoutMs: 35, fetchImpl: localFetch({ calls, show: options => { showCalls++; signal = options.signal; return showCalls === 1 ? new Promise(() => {}) : json(metadata()); } }) });
  const status = await getStatus(app);
  assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.equal(signal.aborted, true);
  assert.match(status.data.message, /timed out|did not answer/i); assert.equal(showCalls, 1);
  assert.equal((await getStatus(app)).data.available, true);
  assert.deepEqual(paths(calls), ['/api/show', '/api/show']);
});

test('a formatting preflight has its own timeout, never reaches inference, and releases the slot', async t => {
  let signal, showCalls = 0;
  const calls = [];
  const app = await running(t, { metadataTimeoutMs: 35, fetchImpl: localFetch({ calls, show: options => { showCalls++; signal = options.signal; return showCalls === 1 ? new Promise(() => {}) : json(metadata()); } }) });
  const result = await exchange(app);
  assert.equal(result.status, 503); assert.equal(result.data.code, 'metadata_timeout'); assert.equal(signal.aborted, true); assertNoPlan(result);
  assert.deepEqual(paths(calls), ['/api/show']);
  assert.equal((await exchange(app)).status, 200); assert.deepEqual(paths(calls), ['/api/show', '/api/show', '/api/chat']);
});

test('a stalled metadata body is cancelled when the short readiness timeout expires', async t => {
  let cancelled = false;
  const app = await running(t, { metadataTimeoutMs: 35, fetchImpl: localFetch({ show: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"capabilities":')); },
    cancel() { cancelled = true; },
  })) }) });
  const status = await getStatus(app);
  assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.equal(cancelled, true);
});

test('inference timeout aborts the provider without a retry and frees the slot', async t => {
  let signal, chatCalls = 0;
  const calls = [];
  const app = await running(t, { timeoutMs: 35, fetchImpl: localFetch({ calls, chat: options => { chatCalls++; signal = options.signal; return chatCalls === 1 ? new Promise(() => {}) : success(); } }) });
  const result = await exchange(app);
  assert.equal(result.status, 504); assert.equal(result.data.code, 'timeout'); assert.equal(signal.aborted, true); assert.equal(chatCalls, 1);
  assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
  assert.equal((await exchange(app)).status, 200); assert.equal(chatCalls, 2);
});

test('the timeout also bounds a client that never finishes uploading JSON', async t => {
  const calls = [];
  const app = await running(t, { timeoutMs: 35, fetchImpl: localFetch({ calls }) });
  const result = await exchange(app, { body: '{', finish: false });
  assert.equal(result.status, 504); assert.equal(calls.length, 0);
  assert.equal((await exchange(app)).status, 200);
});

test('timeout cancels a stalled inference response body after its headers arrive', async t => {
  for (const status of [200, 500]) {
    let chatCalls = 0, cancelled = false;
    const app = await running(t, { timeoutMs: 35, fetchImpl: localFetch({ chat: () => {
      chatCalls++;
      if (chatCalls > 1) return success();
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"done":')); },
        cancel() { cancelled = true; },
      }), { status });
    } }) });
    const result = await exchange(app);
    assert.equal(result.status, 504); assert.equal(cancelled, true); assert.equal(chatCalls, 1);
    assert.equal((await exchange(app)).status, 200);
  }
});

test('disconnecting during upload frees the slot without contacting Ollama', async t => {
  const calls = [];
  const app = await running(t, { fetchImpl: localFetch({ calls }) });
  const incoming = once(app.server, 'request');
  const req = httpRequest({ hostname: 'localhost', port: app.port, method: 'POST', path: '/api/ai/format', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.write('{'); req.flushHeaders();
  const [received] = await incoming;
  const abandoned = once(received, 'aborted');
  req.destroy(); await abandoned;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0); assert.equal((await exchange(app)).status, 200);
  assert.deepEqual(paths(calls), ['/api/show', '/api/chat']);
});

test('client disconnection aborts a pending metadata preflight and permits a later request', async t => {
  let showCalls = 0;
  const calls = [], started = Promise.withResolvers(), aborted = Promise.withResolvers();
  const app = await running(t, { fetchImpl: localFetch({ calls, show: options => {
    showCalls++;
    if (showCalls > 1) return json(metadata());
    options.signal.addEventListener('abort', () => aborted.resolve(options.signal.reason), { once: true });
    started.resolve(); return new Promise(() => {});
  } }) });
  const req = httpRequest({ hostname: 'localhost', port: app.port, method: 'POST', path: '/api/ai/format', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.end(JSON.stringify({ images: [image()] }));
  await started.promise; req.destroy();
  assert.equal((await aborted.promise).code, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await exchange(app)).status, 200);
  assert.deepEqual(paths(calls), ['/api/show', '/api/show', '/api/chat']);
});

test('client disconnection aborts local inference and permits a later request', async t => {
  let chatCalls = 0;
  const started = Promise.withResolvers(), aborted = Promise.withResolvers();
  const app = await running(t, { fetchImpl: localFetch({ chat: options => {
    chatCalls++;
    if (chatCalls > 1) return success();
    options.signal.addEventListener('abort', () => aborted.resolve(options.signal.reason), { once: true });
    started.resolve(); return new Promise(() => {});
  } }) });
  const req = httpRequest({ hostname: 'localhost', port: app.port, method: 'POST', path: '/api/ai/format', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.end(JSON.stringify({ images: [image()] }));
  await started.promise; req.destroy();
  assert.equal((await aborted.promise).code, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await exchange(app)).status, 200); assert.equal(chatCalls, 2);
});

test('dev and dist static routes deny secrets, scripts, tests, and symlink escapes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worksheet-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(['src', 'scripts', 'tests'].map(name => mkdir(join(dir, name))));
  await Promise.all([
    writeFile(join(dir, 'index.html'), 'public app'), writeFile(join(dir, 'src/index.html'), 'public app'),
    writeFile(join(dir, '.env'), PRIVATE_MARKER), writeFile(join(dir, '.env.example'), PRIVATE_MARKER),
    writeFile(join(dir, 'scripts/private.mjs'), PRIVATE_MARKER), writeFile(join(dir, 'tests/private.json'), PRIVATE_MARKER),
    symlink(join(dir, '.env'), join(dir, 'src/leak.txt')),
  ]);
  for (const prod of [false, true]) {
    const app = await running(t, { root: dir, prod });
    for (const path of ['/.env', '/%2eenv', '/.env.example', '/scripts/private.mjs', '/tests/private.json', '/src/leak.txt']) {
      const result = await exchange(app, { method: 'GET', path });
      assert.equal(result.status, 403, `${prod ? 'dist' : 'dev'} ${path}`); assert.equal(result.text.includes(PRIVATE_MARKER), false);
    }
    const index = await exchange(app, { method: 'GET', path: '/' });
    assert.equal(index.status, 200); assert.equal(index.text, 'public app'); assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal((await exchange(app, { method: 'HEAD', path: '/' })).text, '');
  }
});

test('optional .env loads local configuration without overriding existing environment values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worksheet-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(loadOptionalEnv(dir), false);
  await writeFile(join(dir, '.env'), `MARGIN_PRIVATE_TEST_SETTING=${PRIVATE_MARKER}\nOLLAMA_MODEL=from-file\n`);
  const script = `import {loadOptionalEnv} from ${JSON.stringify(pathToFileURL(resolve(root, 'scripts/serve.mjs')).href)}; const loaded=loadOptionalEnv(${JSON.stringify(dir)}); console.log(JSON.stringify({loaded,settingMatches:process.env.MARGIN_PRIVATE_TEST_SETTING===${JSON.stringify(PRIVATE_MARKER)},model:process.env.OLLAMA_MODEL}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { OLLAMA_MODEL: 'existing-model' } });
  assert.deepEqual(JSON.parse(stdout), { loaded: true, settingMatches: true, model: 'existing-model' });
  assert.equal(stdout.includes(PRIVATE_MARKER), false);
});
