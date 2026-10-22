import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { aidFor, gridExtent, gridScale, layoutExam } from '../src/layout.js';
import { renderExamPdf } from '../src/render-pdf.js';

const problem = (id, text = '') => ({ id, ref: id, w: 100, h: 22, text });
const group = (kind, problems, extra = {}) => ({ aid: { kind, parts: [], ...extra }, problems });

test('work aids recognize complex plots and additional useful writing surfaces', () => {
  assert.equal(aidFor('Plot each complex number in the complex plane.').kind, 'complex');
  assert.equal(aidFor('Sketch these points on an Argand diagram.').kind, 'complex');
  assert.equal(aidFor('Graph the solution on a number line.').kind, 'numberline');
  assert.equal(aidFor('Use dotted grid paper.').kind, 'dot');
  assert.equal(aidFor('Explain your answer on lined paper.').kind, 'lined');
  assert.equal(aidFor('Match the complex numbers to the figures.').kind, 'line');
  assert.equal(aidFor('Plot the rectangular coordinates of each polar point.').kind, 'xy');
});

test('automatic graph range reads all coordinates and skips labels, powers and angles', () => {
  assert.equal(gridExtent('41. Plot (5, -10).'), 10);
  assert.equal(gridExtent('6 + 12i', 'complex'), 12);
  assert.equal(gridExtent('x^2 + y^2 = 100'), 10);
  assert.equal(gridExtent('Plot (-3/2, 10).'), 10);
  assert.equal(gridExtent('15. (10, 360°)', 'polar'), 10);
  assert.equal(gridExtent('(6, 5π/6)', { kind: 'polar' }), 6);
  assert.equal(gridExtent('(5, -10)', 'xy'), 10);
  assert.equal(gridExtent('(5, -10)', 'polar'), 5);
  assert.equal(gridExtent('r = 2 + 8cos(3θ)', 'polar'), 10);
  assert.equal(gridExtent('r = 4 + cos θ', 'polar'), 5);
  assert.equal(gridExtent('r² = 100cos 2θ', 'polar'), 10);
  assert.equal(gridExtent('r = 2*5cos(theta)', 'polar'), 10);
  assert.equal(gridExtent('r = 2(3 + 4cos θ)', 'polar'), 14);
  assert.ok(gridExtent('r = 5/(1 - 0.8cos(theta))', 'polar') >= 25);
  assert.equal(gridExtent('r = 2 + 3 cos θ, 0 ≤ θ ≤ 360°', 'polar'), 5);
  assert.equal(gridExtent('(10π, 2)', 'xy'), 10 * Math.PI);
  assert.equal(gridExtent('(1e6, 10)', 'xy'), 1e6);
  assert.ok(gridExtent('10π + 2i', 'complex') > 31);
  assert.equal(gridExtent('Rotate 360 degrees then plot (5, 10).'), 10);
  assert.equal(gridExtent('no readable coordinates'), 3);
});

test('nice scales cover the requested range with bounded tick count', () => {
  for (const extent of [3, 5, 10, 12, 100, 1000, 1e6, 1e9]) {
    const s = gridScale(extent);
    assert.ok(s.extent >= extent, `${extent} fits`);
    assert.ok(s.steps >= 1 && s.steps <= 6, 'at most six half-axis intervals');
    assert.ok(s.step > 0 && Number.isFinite(s.step));
  }
  assert.equal(gridScale(5).extent, 5);
  assert.equal(gridScale(10).extent, 10);
  assert.deepEqual(gridScale(NaN), gridScale(3));
});

test('manual ranges override automatic estimates and every added aid is positioned', () => {
  const kinds = ['xy', 'complex', 'polar', 'numberline', 'dot', 'lined'];
  const groups = kinds.map(kind => group(kind, [problem(kind, '(5, 10)')], { extent: 20 }));
  const layout = layoutExam(groups, { space: 'compact', columns: 1 });
  const items = layout.pages.flatMap(p => p.items);
  for (const kind of kinds.filter(k => k !== 'lined')) {
    const it = items.find(i => i.type === kind);
    assert.ok(it, `${kind} is present`);
    assert.equal(it.extent, 20);
  }
  assert.equal(items.filter(i => i.type === 'line').length, 3, 'lined paper has three writing lines');
  for (const it of items) {
    if ('y' in it) assert.ok(it.y + (it.h || it.size || 0) <= layout.height - 27, 'items stay within the bottom margin');
  }
});

test('compact mode saves sheets without enlarging problems or spreading to unused target pages', () => {
  const groups = [group('blank', Array.from({ length: 36 }, (_, i) => ({ ...problem(`p${i}`), w: 120, h: 35 })))];
  const normal = layoutExam(groups, { pages: 0, space: 'fill' });
  const compact = layoutExam(groups, { pages: 0, space: 'compact' });
  assert.ok(compact.pages.length < normal.pages.length);
  assert.equal(compact.scale, 1, 'natural source size stays legible');
  const one = layoutExam([group('blank', [problem('only')])], { pages: 4, space: 'compact' });
  assert.equal(one.pages.length, 1, 'a page cap does not force wasteful extra sides');
});

test('long groups with a shared figure paginate without clipping or repeating the figure', () => {
  const groups = [{ ...group('complex', Array.from({ length: 12 }, (_, i) => problem(`p${i}`, '5+10i'))),
    figure: { ref: 'shared', w: 200, h: 200 }, directions: { text: 'Plot each complex number.' } }];
  const layout = layoutExam(groups, { space: 'compact', pages: 0 });
  const items = layout.pages.flatMap(p => p.items);
  assert.equal(items.filter(it => it.ref === 'shared').length, 1);
  assert.equal(items.filter(it => it.type === 'complex').length, 12);
  for (const it of items) if ('y' in it) assert.ok(it.y + (it.h || it.size || 0) <= layout.height - 27, 'nothing below printable area');
});

test('PDF export prints real/imaginary labels, negative ticks and all work surfaces', async () => {
  const kinds = ['xy', 'complex', 'polar', 'numberline', 'dot', 'lined'];
  const layout = layoutExam(kinds.map(kind => group(kind, [problem(kind)], { extent: 10 })), { space: 'compact', columns: 1 });
  const bytes = await renderExamPdf(PDFLib, layout, new Map());
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), verbosity: 0 }).promise;
  const texts = [];
  for (let n = 1; n <= doc.numPages; n++) texts.push(...(await (await doc.getPage(n)).getTextContent()).items.map(i => i.str));
  assert.ok(texts.includes('Re') && texts.includes('Im'));
  assert.ok(texts.includes('-10') && texts.includes('10'));
  assert.ok(bytes.length < 40000, 'vector work aids remain compact');
  await doc.destroy();
  const hugeLayout = layoutExam([group('xy', [problem('huge')], { extent: 1e9 })], { space: 'compact' });
  const huge = await renderExamPdf(PDFLib, hugeLayout, new Map());
  assert.ok(huge.length < 12000, 'large coordinates do not generate millions of grid lines');
});
