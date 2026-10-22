import test from 'node:test';
import assert from 'node:assert/strict';
import { readNumberSelection, readRequest, reconcile } from '../src/rules.js';
import { parseNumbers } from '../src/numbers.js';

const omitted = new Set([1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42]);
const omitRequest = '1- 50, omit (1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42), look at all pages';
const included = Array.from({ length: 50 }, (_, i) => i + 1).filter(n => !omitted.has(n));
const reportedSelection = [15, 17, 19, 23, 27, 29, 31, 33, 37, 39, 41];
const reportedRequest = '只要15, 17, 19, 23, 27, 29, 31, 33, 37, 39, 41';
const screenshotRequests = [
  [reportedRequest, reportedSelection],
  ['Only 15, 17, 19, 23, 27, 29, 31, 33, 37, 39, 41 please', reportedSelection],
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


test('bilingual replacement commands are exact sets; add/remove and dimensions are not', () => {
  for (const request of [
    '只要第15题和第17题', '请帮我只选15、17。', '我只要１５，１７',
    '仅选15和17', 'Please select only questions: 15 and 17.',
    'I only want 15, 17', 'keep exactly 15, 17', 'replace the current selection with 15, 17',
    '换成15和17', '15, 17 only', '15, 17, 查看所有页面',
  ]) assert.deepEqual(readNumberSelection(request), [15, 17], request);
  for (const request of ['add 15, 17', 'also add 15, 17', '再加15和17', 'remove 15', '不要15', '2 columns', 'grid extent 15']) {
    assert.equal(readNumberSelection(request), null, request);
  }
  assert.deepEqual(readNumberSelection('只要15到21奇数，不要17和19'), [15, 21]);
  assert.deepEqual(readNumberSelection('only 15-21 odd, excluding (17, 19)'), [15, 21]);
  assert.deepEqual(readNumberSelection('only 15, except 15'), []);
  assert.deepEqual(readNumberSelection('odd 15-21'), [15, 17, 19, 21]);
  assert.deepEqual(parseNumbers('１５，１７'), [15, 17]);
  assert.deepEqual(parseNumbers('1000, 15.5, 17'), [17], 'large labels and decimals cannot be truncated into other labels');
});

test('model range endpoints cannot authorize unrequested interior questions or layout counts', () => {
  assert.deepEqual(reconcile('remove 15 and 41', { add_numbers: '15-41', remove_numbers: '15-41' }), { remove_numbers: '15 and 41' });
  assert.deepEqual(reconcile('2 columns', { add_numbers: '2' }), { columns: 2 });
  assert.deepEqual(reconcile('polar grid radius 10', { add_numbers: '10', graph_extent: 15 }), { graph: 'polar', graph_extent: 10 });
  assert.deepEqual(reconcile('select problems 15, 17', { add_numbers: '15-17' }), { add_numbers: '15, 17' });
  assert.deepEqual(reconcile('add 15 and 41', { add_numbers: '15-41' }), { add_numbers: '15 and 41' });
});

test('the request reader exposes additional work aids, explicit graph scale and compact printing', () => {
  for (const [request, kind] of [
    ['complex plane', 'complex'], ['Argand diagram', 'complex'], ['复数平面', 'complex'],
    ['number line', 'numberline'], ['数轴', 'numberline'], ['lined paper', 'lined'],
    ['dot grid', 'dot'], ['blank work area', 'blank'], ['no grids', 'none'],
  ]) assert.equal(readRequest(request).graph, kind, request);
  assert.deepEqual(readRequest('polar grids, radius 10'), { graph: 'polar', graph_extent: 10 });
  assert.deepEqual(readRequest('complex plane extent to 25'), { graph: 'complex', graph_extent: 25 });
  assert.deepEqual(reconcile('complex plane for problem 15', { graph_extent: 15 }).graph_extent, undefined);
  assert.deepEqual(readRequest('save paper, use the fewest pages'), { pages: 0, space: 'compact' });
  assert.deepEqual(readRequest('compact'), { space: 'compact' });
  assert.deepEqual(readRequest('fill the page'), { space: 'fill' });
});


test('exact lists keep replacement semantics alongside layout settings', () => {
  for (const request of ['only 15, 17, 19, compact', '只要15,17,19，紧凑', 'only 15, 17, 19; 2 columns; compact']) {
    assert.deepEqual(readNumberSelection(request), [15, 17, 19], request);
    const fields = reconcile(request, { add_numbers: '15-19', remove_numbers: '17' });
    assert.deepEqual(parseNumbers(fields.add_numbers), [15, 17, 19]);
    assert.equal(fields.space, 'compact');
    assert.equal(fields.remove_numbers, undefined);
  }
  const fields = readRequest('only 15, 17; complex planes to 10');
  assert.deepEqual(readNumberSelection('only 15, 17; complex planes to 10'), [15, 17]);
  assert.deepEqual(fields, { add_numbers: '15, 17', graph: 'complex', graph_extent: 10 });
  for (const request of ['graph range 10', 'coordinate planes to 10', 'number line range 10', 'polar grid radius 10']) {
    assert.equal(readRequest(request).add_numbers, undefined, request);
    assert.equal(readRequest(request).graph_extent, 10, request);
  }
  for (const request of ['no complex planes', 'no number lines', 'without dot grids', '不要复数平面']) {
    assert.equal(readRequest(request).graph, 'none', request);
  }
});
