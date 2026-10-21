import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequest, reconcile } from '../src/rules.js';
import { parseNumbers } from '../src/numbers.js';

const screenshotRequests = [
  ['Problems 43, 45, 57', [43, 45, 57]],
  ['42, 54, 57', [42, 54, 57]],
];

test('the screenshot requests preserve every explicitly requested problem number', () => {
  for (const [text, expected] of screenshotRequests) {
    assert.deepEqual(parseNumbers(readRequest(text).add_numbers), expected);
    for (const proposal of [{}, { add_numbers: '2, 3, 27' }, { add_numbers: '43' }, { clear: true }, { remove_numbers: '42' }]) {
      const fields = reconcile(text, proposal);
      assert.deepEqual(parseNumbers(fields.add_numbers), expected);
      assert.equal(fields.clear, undefined);
      assert.equal(fields.remove_numbers, undefined);
    }
  }
});

test('a ready local model is bypassed for standalone problem lists, but can interpret removal prose', async t => {
  const previousWorker = globalThis.Worker;
  const requests = [];
  class ModelWorker {
    postMessage(data) {
      if (data.type === 'load') this.onmessage({ data: { type: 'ready', device: 'webgpu' } });
      else if (data.type === 'run') {
        requests.push(data.text);
        this.onmessage({ data: {
          type: 'result', id: data.id,
          calls: [{ name: 'update_worksheet', args: { remove_numbers: '47, 49' } }],
          raw: 'model removal proposal',
        } });
      }
    }
    terminate() {}
  }
  globalThis.Worker = ModelWorker;
  t.after(() => {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  });
  const { loadAgent, agentReady, interpret } = await import('../src/agent.js?request-regression');
  loadAgent();
  assert.equal(agentReady(), true);

  const directRequests = [
    ...screenshotRequests,
    ['Exercises 43, 45, 57', [43, 45, 57]],
    ['Questions: 42, 54, 57', [42, 54, 57]],
    ['41–47 odd', [41, 43, 45, 47]],
    ['11, 13, 15-21 odd', [11, 13, 15, 17, 19, 21]],
    ['Problems 42 and 54 and 57.', [42, 54, 57]],
  ];
  for (const [text, expected] of directRequests) {
    const result = await interpret(text);
    assert.equal(result.source, 'rules', text);
    assert.deepEqual(parseNumbers(result.fields.add_numbers), expected, text);
  }
  assert.deepEqual(requests, [], 'explicit lists must not send requests to the model worker');

  const removal = await interpret('get rid of number 47 and 49');
  assert.equal(removal.source, 'model');
  assert.deepEqual(parseNumbers(removal.fields.remove_numbers), [47, 49]);
  assert.equal(removal.fields.add_numbers, undefined);
  assert.deepEqual(requests, ['get rid of number 47 and 49']);
});
