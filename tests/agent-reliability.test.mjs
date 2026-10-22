import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
async function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.Worker;
  const workers = [];
  class FakeWorker {
    messages = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    send(data) { this.onmessage?.({ data }); }
    ready() { this.send({ type: 'ready', device: 'webgpu' }); }
    runId() { return this.messages.filter(m => m.type === 'run').at(-1)?.id; }
  }
  globalThis.Worker = FakeWorker;
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  });
  const agent = await import(`../src/agent.js?reliability=${++moduleId}`);
  const statuses = [];
  agent.onAgentStatus(status => statuses.push(status));
  const start = () => { agent.loadAgent(); const worker = workers.at(-1); worker.ready(); return worker; };
  return { agent, workers, statuses, start };
}

test('a worker crash settles every in-flight request with deterministic fallback and allows retry', async t => {
  const { agent, workers, statuses, start } = await harness(t);
  const old = start();
  const a = agent.interpret('two columns');
  const b = agent.interpret('A4 paper');
  old.onerror({ message: 'GPU lost' });
  assert.deepEqual(await a, { fields: { columns: 2 }, source: 'rules' });
  assert.deepEqual(await b, { fields: { paper: 'a4' }, source: 'rules' });
  assert.equal(old.terminated, true);
  assert.equal(agent.agentReady(), false);
  assert.equal(statuses.at(-1).state, 'error');

  const next = start();
  assert.equal(workers.length, 2);
  const retry = agent.interpret('European paper');
  old.send({ type: 'error', message: 'late load error' });
  old.send({ type: 'ready', device: 'wasm' });
  assert.equal(agent.agentReady(), true, 'old worker events cannot disable the retry');
  next.send({ type: 'result', id: next.runId(), calls: [{ name: 'update_worksheet', args: { paper: 'a4' } }] });
  assert.equal((await retry).source, 'model');
  t.mock.timers.tick(31_000);
  assert.equal(next.terminated, false, 'settled request timers are cleared');
});

test('a request that never returns falls back after a finite timeout', async t => {
  const { agent, start, statuses } = await harness(t);
  const worker = start();
  const result = agent.interpret('two columns');
  t.mock.timers.tick(29_999);
  assert.equal(worker.terminated, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { fields: { columns: 2 }, source: 'rules' });
  assert.equal(worker.terminated, true);
  assert.match(statuses.at(-1).message, /too long/);
  worker.send({ type: 'result', id: worker.runId(), calls: [{ name: 'update_worksheet', args: { columns: 3 } }] });
  assert.equal(agent.agentReady(), false, 'a late result cannot revive the expired worker');
});

test('a request error or malformed result falls back without leaving a timeout behind', async t => {
  const { agent, start } = await harness(t);
  const worker = start();
  let result = agent.interpret('A4 paper');
  const firstId = worker.runId();
  worker.send({ type: 'error', id: firstId, message: 'generation failed' });
  assert.deepEqual(await result, { fields: { paper: 'a4' }, source: 'rules' });
  worker.send({ type: 'error', id: firstId, message: 'duplicate late error' });
  assert.equal(agent.agentReady(), true);
  result = agent.interpret('two columns');
  worker.send({ type: 'result', id: worker.runId(), calls: null });
  assert.deepEqual(await result, { fields: { columns: 2 }, source: 'rules' });
  t.mock.timers.tick(31_000);
  assert.equal(worker.terminated, false);
});

test('an unreadable worker message settles the active request and permits reloading', async t => {
  const { agent, start } = await harness(t);
  const worker = start();
  const result = agent.interpret('two columns');
  worker.onmessageerror({});
  assert.equal((await result).source, 'rules');
  assert.equal(worker.terminated, true);
  assert.notEqual(start(), worker);
});

test('download progress extends the inactivity deadline but a stopped download can be retried', async t => {
  const { agent, workers, statuses } = await harness(t);
  agent.loadAgent();
  const worker = workers[0];
  t.mock.timers.tick(170_000);
  worker.send({ type: 'progress', loaded: 1_000_000, total: 470_000_000 });
  t.mock.timers.tick(170_000);
  assert.equal(worker.terminated, false, 'an advancing large download is allowed to continue');
  worker.send({ type: 'progress', loaded: 1_000_000, total: 470_000_000 });
  t.mock.timers.tick(10_000);
  assert.equal(worker.terminated, true, 'repeated identical progress cannot keep a stalled download alive');
  assert.equal(statuses.at(-1).state, 'error');
  agent.loadAgent();
  assert.equal(workers.length, 2);
  workers[1].ready();
  t.mock.timers.tick(30 * 60_000);
  assert.equal(agent.agentReady(), true, 'ready clears both loading deadlines');
});

test('loading is bounded even when a worker emits progress forever without becoming ready', async t => {
  const { agent, workers } = await harness(t);
  agent.loadAgent();
  const worker = workers[0];
  for (let minute = 1; minute <= 30; minute++) {
    t.mock.timers.tick(60_000);
    worker.send({ type: 'progress', loaded: minute * 1_000_000, total: 470_000_000 });
  }
  assert.equal(worker.terminated, true);
  assert.equal(agent.agentReady(), false);
});

test('construction and posting failures restore the rule reader instead of throwing or hanging', async t => {
  const { agent, workers, statuses, start } = await harness(t);
  const GoodWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { throw new Error('blocked worker'); } };
  assert.doesNotThrow(() => agent.loadAgent());
  assert.equal(statuses.at(-1).state, 'error');
  globalThis.Worker = GoodWorker;
  const worker = start();
  worker.postMessage = () => { throw new Error('post failed'); };
  assert.deepEqual(await agent.interpret('two columns'), { fields: { columns: 2 }, source: 'rules' });
  assert.equal(workers.length, 1);
  assert.equal(worker.terminated, true);
});

test('explicit numbers bypass a ready model and never create a pending model request', async t => {
  const { agent, start } = await harness(t);
  const worker = start();
  const result = await agent.interpret('15, 17, 19, 23, 27, 29, 31, 33, 37, 39, 41');
  assert.equal(result.source, 'rules');
  assert.equal(worker.messages.filter(m => m.type === 'run').length, 0);
  assert.match(result.fields.add_numbers, /41$/);
  t.mock.timers.tick(31_000);
  assert.equal(agent.agentReady(), true);
});
