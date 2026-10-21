import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseNumbers, formatNumbers } from '../src/numbers.js';
import { readRequest, reconcile } from '../src/rules.js';
import { analyzePage, cleanDirections, directionRange, anchorForMark } from '../src/analyze.js';
import { layoutExam, aidFor, gridExtent } from '../src/layout.js';
import { pageWords } from '../src/textlayer.js';
import { parseToolCalls } from '../src/agent-prompt.js';

test('problem number lists', () => {
  assert.deepEqual(parseNumbers('11, 13, and 41-45 odd'), [11, 13, 41, 43, 45]);
  assert.deepEqual(parseNumbers('第23题和第25题'), [23, 25]);
  assert.deepEqual(parseNumbers('57 through 67 odd'), [57, 59, 61, 63, 65, 67]);
  assert.deepEqual(parseNumbers('41–46 even, 3'), [3, 42, 44, 46]);
  assert.deepEqual(parseNumbers('problems 5 to 8'), [5, 6, 7, 8]);
  assert.equal(formatNumbers([11, 13, 15, 16, 17]), '11, 13, 15–17');
});

test('the request reader understands the original Chinese request', () => {
  const zh = '请帮我把所有绿色的问题全部都提取出来，制作成一个数学考试风格的题目。题目要留出一定空间给我当过程，完全考试风格，不要浪费空间，紧凑一些。一页double side。只要题目不要有任何那种名字什么那种垃圾东西。';
  assert.deepEqual(readRequest(zh), { highlight_color: 'green', pages: 2, space: 'fill' });
  assert.deepEqual(readRequest('remove 47'), { remove_numbers: '47' });
  assert.deepEqual(readRequest('two columns, lots of room to work'), { columns: 2, space: 'large' });
});

test('model proposals are kept only when the request supports them', () => {
  // Small models like to fill every field; ungrounded ones are dropped.
  const out = reconcile('do 11, 13, and 41-45 odd', { add_numbers: '11, 13, 41-45 odd', clear: true, highlight_color: 'green', pages: 2, graph: 'polar' });
  assert.deepEqual(out, { add_numbers: '11, 13, 41-45 odd' });
  // Numbers the user never typed are not accepted.
  assert.deepEqual(reconcile('remove 47', { remove_numbers: '47', add_numbers: '1-89' }), { remove_numbers: '47' });
  // A paraphrase the rules miss is taken from the model.
  assert.deepEqual(reconcile('print it on European paper', { paper: 'a4' }), { paper: 'a4' });
  assert.deepEqual(reconcile('get rid of number 47 and 49', { remove_numbers: '49' }), { remove_numbers: '47 and 49' });
});

test('tool call parser handles Qwen XML, JSON and pythonic calls', () => {
  assert.deepEqual(parseToolCalls('<tool_call> <function=update_worksheet> <parameter=pages> 2 </parameter> <parameter=highlight_color> green </parameter> </function> </tool_call><|im_end|>junk'),
    [{ name: 'update_worksheet', args: { pages: 2, highlight_color: 'green' } }]);
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"update_worksheet","arguments":{"columns":3}}</tool_call>'), [{ name: 'update_worksheet', args: { columns: 3 } }]);
  assert.deepEqual(parseToolCalls('<|tool_call_start|>[update_worksheet(space="fill", directions=False)]<|tool_call_end|>'), [{ name: 'update_worksheet', args: { space: 'fill', directions: false } }]);
});

test('directions helpers', () => {
  assert.deepEqual(directionRange('In Problems 11–18, match each point'), { from: 11, to: 18 });
  assert.equal(cleanDirections('In Problems 19–32, plot each point given in polar coordinates.'), 'Plot each point given in polar coordinates.');
  assert.equal(aidFor('In Problems 19–32, plot each point given in polar coordinates.').kind, 'polar');
  assert.equal(aidFor('match each point with A, B, C, or D on the graph').kind, 'line');
  assert.deepEqual(aidFor('plot ... polar ... (a) r>0 (b) r<0 (c) r>0').parts, ['a', 'b', 'c']);
  assert.equal(aidFor('graph each line on a coordinate grid.').kind, 'xy');
  assert.equal(gridExtent('6, p 6'), 6);
});

async function samplePage() {
  const data = new Uint8Array(await readFile(new URL('../samples/sample.pdf', import.meta.url)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  return { words: await pageWords(page), width: vp.width, height: vp.height };
}

test('sample page: every numbered problem and every directions line is found', async () => {
  const p = await samplePage();
  const r = analyzePage(p);
  assert.deepEqual(r.anchors.map(a => a.number).sort((a, b) => a - b), Array.from({ length: 34 }, (_, i) => i + 1));
  assert.deepEqual(r.directions.map(d => d.range), [{ from: 1, to: 8 }, { from: 9, to: 16 }, { from: 17, to: 24 }, { from: 25, to: 32 }]);
  const byNum = n => r.anchors.find(a => a.number === n);
  assert.equal(byNum(12).directions.range.from, 9);
  assert.equal(byNum(34).directions, null);
  // Problem 2's text stays inside its own cell; 34 keeps its second line but not the footer.
  assert.match(byNum(2).text, /2\(x - 4\) = 10/);
  assert.ok(byNum(2).box.x1 < byNum(3).x0);
  assert.match(byNum(34).text, /nearest tenth/);
  assert.doesNotMatch(byNum(34).text, /Page 212/);
  // A highlighter circle over "17." maps to problem 17.
  const a17 = byNum(17);
  assert.equal(anchorForMark({ x0: a17.x0 - 3, x1: a17.x1 + 3, y0: a17.y0 - 2, y1: a17.y1 + 2 }, r.anchors, r.bodySize).number, 17);
});

test('layout fits the requested number of sides and never adds a title', () => {
  const groups = [
    { directions: { text: 'Solve each equation.' }, aid: { kind: 'blank', parts: [] }, problems: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, w: 90, h: 14, ref: `a${i}`, baseline: 10 })) },
    { directions: { text: 'Plot each point in polar coordinates.' }, aid: { kind: 'polar', parts: ['a', 'b'] }, problems: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, w: 60, h: 22, ref: `b${i}`, extent: 3 })) },
  ];
  for (const pages of [1, 2, 3]) {
    const L = layoutExam(groups, { pages, space: 'fill' });
    assert.ok(L.pages.length <= pages, `fits ${pages}`);
    const texts = L.pages.flatMap(p => p.items.filter(i => i.type === 'text').map(i => i.text));
    assert.deepEqual(texts.filter(t => !/^\([ab]\)$/.test(t)).sort(), ['Plot each point in polar coordinates.', 'Solve each equation.']);
    for (const p of L.pages) for (const it of p.items) if (it.type === 'image') assert.ok(it.y + it.h <= L.height - 30, 'inside the bottom margin');
  }
  const two = layoutExam(groups, { pages: 2, space: 'fill' });
  assert.equal(two.pages.length, 2);
  assert.equal(two.pages.flatMap(p => p.items).filter(i => i.type === 'polar').length, 6);
});
