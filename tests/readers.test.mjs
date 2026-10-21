import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage } from '../src/analyze.js';
import { mergeVisualWords, needsVisualCheck } from '../src/document.js';

function line(text, x, base, options = {}) {
  return text.split(' ').map(text => {
    const w = { text, x0: x, x1: x + text.length * 5, y0: base - 7.8, y1: base + 2.4, base, size: 10, ...options };
    x = w.x1 + 3;
    return w;
  });
}
const analyze = (words, ocr = false) => analyzePage({ words, width: 612, height: 792, ocr });
const numbers = result => result.anchors.map(a => a.number).sort((a, b) => a - b);

test('automatic visual checks target local holes, not numbers continuing on later pages', () => {
  const directions = line('Problems 61-66: Find the area.', 40, 60, { italic: true });
  const one = line('61. Find the area of the square.', 40, 100, { bold: true });
  const three = line('63. Find the area of the triangle.', 40, 180, { bold: true });
  const two = line('62. Find the area of the rectangle.', 40, 140, { bold: true });
  const hole = [...directions, ...one, ...three];
  assert.equal(needsVisualCheck(hole, analyze(hole)), true);
  const continuing = [...directions, ...one, ...two];
  assert.equal(needsVisualCheck(continuing, analyze(continuing)), false, '63-66 may be on a later page');
  const unnamed = [...one, ...three];
  assert.equal(needsVisualCheck(unnamed, analyze(unnamed)), false, 'an unassigned skipped number alone is not a missing label');
  const malformed = analyze(continuing);
  malformed.anchors[0].x1 = malformed.anchors[0].x0 + 100;
  assert.equal(needsVisualCheck(continuing, malformed), true, 'implausible native label bounds warrant cross-checking');
});

test('reader reconciliation preserves native text, admits observed labels, and rejects OCR conflicts', () => {
  const native = [
    ...line('Problems 1-5: Find each area.', 40, 60, { italic: true }),
    ...line('1. Find the exact area.', 40, 100, { bold: true }),
    ...line('Find the rectangle area.', 58, 140), // visible label 2 is a raster image
    ...line('3. Find the exact perimeter.', 40, 180, { bold: true }),
    ...line('5. Find the exact volume.', 40, 260, { bold: true }),
  ];
  const before = structuredClone(native);
  const nativeAnalysis = analyze(native);
  const visualWords = [
    ...line('Problems 1-5: Find each area.', 40, 60, { conf: 95 }),
    ...line('9. Flnd the exact area.', 40, 100, { conf: 95 }), // OCR disagrees with native label 1
    ...line('2.', 40, 140, { conf: 95 }),
    ...line('Find the rectangle area.', 58, 140, { conf: 95 }),
    ...line('Explain your method.', 58, 154, { conf: 95 }), // raster prose has no native words
    ...line('3. Find the exact perimeter.', 40, 180, { conf: 95 }),
    ...line('5. Find the exact volume.', 40, 260, { conf: 95 }),
    ...line('99. Unrelated numbered text.', 40, 500, { conf: 95 }),
  ];
  const merged = mergeVisualWords(native, nativeAnalysis, visualWords, analyze(visualWords, true));
  assert.deepEqual(native, before, 'native strings and coordinates are unchanged');
  for (const w of native) assert.ok(merged.words.includes(w), 'native words retain their identity');
  assert.deepEqual(merged.labels.map(a => a.number), [2]);
  assert.equal(merged.conflicts, 1);
  assert.deepEqual(numbers(analyze(merged.words, true)), [1, 2, 3, 5], 'missing 4 is never invented and wrong 9/99 are rejected');
  assert.ok(merged.words.some(w => w.text === 'Explain' && w.ocrSupplement), 'previously uncovered raster prose is retained');
  assert.ok(!merged.words.some(w => w.text === 'Flnd'), 'misread OCR does not replace native prose');
});

test('an isolated OCR number cannot join a native page just by increasing the anchor count', () => {
  const native = [
    ...line('1. Find the area.', 40, 100, { bold: true }),
    ...line('2. Find the perimeter.', 40, 180, { bold: true }),
  ];
  const visualWords = line('88. Unrelated text.', 330, 450, { conf: 99 });
  const merged = mergeVisualWords(native, analyze(native), visualWords, analyze(visualWords, true));
  assert.deepEqual(merged.words, native);
  assert.deepEqual(merged.labels, []);
});
