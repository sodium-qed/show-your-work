import test from 'node:test';
import assert from 'node:assert/strict';
import { readNumberSelection, readRequest, reconcile } from '../src/rules.js';
import { parseNumbers } from '../src/numbers.js';

const omitted = new Set([1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42]);
const omitRequest = '1- 50, omit (1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42), look at all pages';
const included = Array.from({ length: 50 }, (_, i) => i + 1).filter(n => !omitted.has(n));
const screenshotRequests = [
  ['Problems 43, 45, 57', [43, 45, 57]],
  ['42, 54, 57', [42, 54, 57]],
  ['1-40 even', Array.from({ length: 20 }, (_, i) => 2 * (i + 1))],
  [omitRequest, included],
];

test('the screenshot requests preserve every explicitly requested problem number', () => {
  for (const [text, expected] of screenshotRequests) {
    assert.deepEqual(parseNumbers(readRequest(text).add_numbers), expected);
    for (const proposal of [{}, { add_numbers: '2, 3, 27' }, { add_numbers: '43' }, { clear: true }, { remove_numbers: '42' }, { pages: 1, remove_numbers: '1-50' }]) {
      const fields = reconcile(text, proposal);
      assert.deepEqual(parseNumbers(fields.add_numbers), expected);
      assert.equal(fields.clear, undefined);
      assert.equal(fields.remove_numbers, undefined);
      assert.equal(fields.pages, undefined, 'source-page scope must not change the printed page count');
    }
  }
});

test('literal exclusions are resolved as sets before selection; explicit removal stays incremental', () => {
  assert.equal(included.length, 38);
  assert.deepEqual(readNumberSelection(omitRequest), included);
  assert.deepEqual(readNumberSelection('1-10 except (2, 4-8 even)'), [1, 3, 5, 7, 9, 10]);
  assert.deepEqual(readNumberSelection('1-10, omit (1-10), look at all pages'), []);
  assert.deepEqual(readNumberSelection('1, 3, 5, from all pages'), [1, 3, 5]);
  assert.equal(readNumberSelection('add 1-10'), null);
  assert.equal(readNumberSelection('omit (2, 4)'), null);
  const removal = readRequest('omit (2, 4)');
  assert.deepEqual(parseNumbers(removal.remove_numbers), [2, 4]);
  assert.equal(removal.add_numbers, undefined);
  assert.deepEqual(reconcile('look at all pages', { pages: 1 }), {}, 'source scope alone is not a layout instruction');
  assert.equal(reconcile('print on 2 pages, look at all pages', { pages: 1 }).pages, 2, 'an explicit output-page count still works');
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
  const { loadAgent, agentReady, interpret, isExplicitNumberList } = await import('../src/agent.js?request-regression');
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
  assert.equal(isExplicitNumberList('1-40 even'), true);
  assert.equal(isExplicitNumberList('add 1-40 even'), false, 'an explicit addition stays incremental');
  assert.equal(isExplicitNumberList('remove 4, 8'), false, 'an explicit removal stays incremental');

  const removal = await interpret('get rid of number 47 and 49');
  assert.equal(removal.source, 'model');
  assert.deepEqual(parseNumbers(removal.fields.remove_numbers), [47, 49]);
  assert.equal(removal.fields.add_numbers, undefined);
  assert.deepEqual(requests, ['get rid of number 47 and 49']);
});
