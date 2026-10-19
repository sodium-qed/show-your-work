import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRegionText } from '../src/text-extraction.js';

const run = (text, x, y, w = 100, h = 12) => ({ text, x, y, w, h });
const crop = { x: 0, y: 0, w: 500, h: 300 };
const extract = items => extractRegionText(items, crop);
const warned = (result, pattern) => result.warnings.some(warning => pattern.test(warning));

test('joins ordinary line wraps in reading order without changing wording or Unicode', () => {
  const result = extract([
    run('where α ≤ 3 and x² ≠ 0.', 20, 50, 230),
    run('7. Explain the relationship,', 20, 20, 230),
    run('using the diagram.', 20, 80, 180),
  ]);
  assert.equal(result.text, '7. Explain the relationship, where α ≤ 3 and x² ≠ 0. using the diagram.');
  assert.ok(warned(result, /review.*source/i));
});

test('joins adjacent style-split words and preserves separate punctuation', () => {
  const result = extract([
    run('inter', 10, 20, 22), run('val', 32, 20, 14), run(',', 46, 20, 3),
    run('then', 54, 19, 24, 13), run('solve', 83, 20, 28), run('.', 111, 20, 3),
  ]);
  assert.equal(result.text, 'interval, then solve.');
});

test('preserves explicit word spaces even when style-run boxes touch', () => {
  const result = extract([
    run('Find ', 10, 20, 24), run('the', 34, 20, 18), run(' area.', 52, 20, 36),
  ]);
  assert.equal(result.text, 'Find the area.');
});

test('retains a mostly selected text run whole and warns that the crop cuts text', () => {
  const result = extractRegionText([
    run('Full source phrase.', 10, 20, 100),
  ], { x: 20, y: 10, w: 110, h: 40 });
  assert.equal(result.text, 'Full source phrase.');
  assert.ok(warned(result, /crop cuts through text/i));
});

test('omits barely overlapping neighboring text and flags the boundary for review', () => {
  const result = extractRegionText([
    run('Selected text.', 50, 20, 90), run('Adjacent column.', 180, 20, 100),
    run('Above the selection.', 50, -10, 140),
  ], { x: 40, y: 10, w: 150, h: 40 });
  assert.equal(result.text, 'Selected text.');
  assert.ok(warned(result, /crop cuts through text/i));
  assert.ok(!result.text.includes('Adjacent'));
});

test('boxes merely touching the crop boundary do not leak outside text into the result', () => {
  const result = extractRegionText([
    run('Inside.', 40, 20, 60), run('Right outside.', 140, 20, 80), run('Bottom outside.', 40, 50, 80),
  ], { x: 40, y: 10, w: 100, h: 40 });
  assert.equal(result.text, 'Inside.');
  assert.ok(!warned(result, /crop cuts through text/i));
});

test('flags columns and preserves all runs in explicit row-by-row draft order', () => {
  const result = extract([
    run('Left first.', 10, 20, 90), run('Right first.', 300, 20, 100),
    run('Left second.', 10, 40, 100), run('Right second.', 300, 40, 110),
  ]);
  assert.equal(result.text, 'Left first. Right first. Left second. Right second.');
  assert.ok(warned(result, /columns.*reading order/i));
});

test('flags overlapping baselines without inventing mathematical structure', () => {
  const result = extract([
    run('x + 1', 20, 20, 40, 8), run('=', 80, 25, 10, 12), run('x − 1', 20, 35, 40, 8),
  ]);
  assert.ok(warned(result, /fractions, exponents/i));
  assert.ok(result.text.includes('x + 1'));
  assert.ok(result.text.includes('x − 1'));
  assert.ok(!result.text.includes('/'), 'no fraction bar is invented from positioning');
});

test('keeps explicit line-end hyphens instead of silently rewriting a word', () => {
  const result = extract([run('A well-', 10, 20, 60), run('known result.', 10, 40, 110)]);
  assert.equal(result.text, 'A well-known result.');
  assert.ok(warned(result, /hyphens were kept/i));
  assert.equal(extract([run('A well-known result.', 10, 20, 160)]).text, 'A well-known result.');
});

test('no text, including an image-only scan, produces an empty draft and a clear warning', () => {
  for (const items of [[], null, undefined, [run('   ', 20, 20)], [run('Outside.', 600, 20)]]) {
    const result = extract(items);
    assert.equal(result.text, '');
    assert.ok(warned(result, /no selectable pdf text/i));
  }
});

test('invalid boxes are skipped while valid text remains available for review', () => {
  const result = extract([
    null, { text: 1, x: 0, y: 0, w: 10, h: 12 }, run('No width', 10, 20, 0),
    run('NaN', NaN, 20), run('Infinity', 20, Infinity), run('Valid text.', 20, 60),
  ]);
  assert.equal(result.text, 'Valid text.');
  assert.ok(warned(result, /invalid positions or content/i));
  for (const rect of [null, {}, { ...crop, w: 0 }, { ...crop, h: -1 }, { ...crop, x: NaN }, { ...crop, x: Number.MAX_VALUE, w: Number.MAX_VALUE }]) {
    assert.deepEqual(extractRegionText([run('Text', 20, 20)], rect), { text: '', warnings: ['The selected crop has invalid bounds.'] });
  }
});

test('deduplicates exact overprint runs and never mutates caller data', () => {
  const item = Object.freeze(run('Bold source text.', 20, 20, 160));
  const items = Object.freeze([item, Object.freeze({ ...item })]);
  const rect = Object.freeze({ ...crop });
  assert.equal(extractRegionText(items, rect).text, 'Bold source text.');
  assert.deepEqual(items, [item, item]);
  assert.deepEqual(rect, crop);
});

test('preserves internal Unicode spaces and typographic punctuation', () => {
  const result = extract([run('“Use π,” she said — 12\u00a0cm.', 20, 20, 250)]);
  assert.equal(result.text, '“Use π,” she said — 12\u00a0cm.');
});
