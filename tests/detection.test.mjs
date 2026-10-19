import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectQuestions } from '../src/detection.js';

const WIDTH = 600, HEIGHT = 800;
const text = (label, x, y, w = 180, h = 12) => ({ text: label, x, y, w, h });
const detect = items => detectQuestions(items, WIDTH, HEIGHT);
const labels = items => detect(items).map(rect => rect.label);

test('recognizes common numbered questions without changing their text', () => {
  assert.deepEqual(labels([
    text('1. Solve 2x + 3 = 7.', 42, 100),
    text('2) Expand (x + 1)².', 42, 260),
    text('Question 3', 42, 440),
    text('Problem 4: Find the area.', 42, 620),
  ]), ['1. Solve 2x + 3 = 7.', '2) Expand (x + 1)².', 'Question 3', 'Problem 4: Find the area.']);
});

test('finds two columns in reading order, with separate non-overlapping crops', () => {
  const result = detect([
    text('3. Factor x² − 9.', 330, 100, 220),
    text('2) Find the perimeter.', 42, 350, 220),
    text('1. Solve the equation.', 42, 100, 220),
    text('4) Find the angle.', 330, 350, 220),
    text('x + 3 = 8', 60, 132, 100),
    text('The diagram is below.', 348, 132, 190),
  ]);
  assert.deepEqual(result.map(r => r.label), ['1. Solve the equation.', '2) Find the perimeter.', '3. Factor x² − 9.', '4) Find the angle.']);
  assert.ok(result[0].x + result[0].w <= result[2].x);
  assert.ok(result[0].y + result[0].h <= result[1].y + 1e-12);
  assert.equal(result[3].y + result[3].h, 1);
});

test('does not mistake indented numbered subparts for another column', () => {
  assert.deepEqual(labels([
    text('1. Evaluate each expression.', 42, 100, 250),
    text('1) x + 1', 82, 140, 120),
    text('2) 2x + 1', 82, 190, 120),
    text('3) x² + 1', 82, 240, 120),
    text('2. Explain your method.', 42, 340, 250),
  ]), ['1. Evaluate each expression.', '2. Explain your method.']);
});

test('ignores inline references, decimals, equation labels, and unnumbered text', () => {
  assert.deepEqual(labels([
    text('Worksheet 5', 42, 40),
    text('1. Solve the following.', 42, 100),
    text('Use the result in', 60, 140, 100),
    text('2) to finish.', 164, 140, 100),
    text('3.14 is an approximation.', 42, 170),
    text('(2)', 540, 200, 25),
    text('2. Explain your answer.', 42, 300),
    text('Page 1', 270, 770, 60),
  ]), ['1. Solve the following.', '2. Explain your answer.']);
});

test('joins split PDF text runs, including a separate number and punctuation', () => {
  assert.deepEqual(labels([
    text('1', 42, 100, 6), text('.', 48, 100, 3), text('Solve x + 1 = 2.', 57, 100, 160),
    text('Question', 42, 300, 48), text('2', 95, 300, 6), text(':', 101, 300, 3), text('Find x.', 110, 300, 70),
  ]), ['1. Solve x + 1 = 2.', 'Question 2 : Find x.']);
});

test('rejects a decimal whose integer and fraction are separate text runs', () => {
  assert.deepEqual(detect([
    text('1.', 42, 100, 10), text('25 is the answer.', 52, 100, 150),
    text('2.', 42, 200, 10), text('75 is the answer.', 52, 200, 150),
  ]), []);
});

test('accepts a single explicit heading or a numbered question with text', () => {
  assert.equal(detect([text('Question 3', 72, 120)]).length, 1);
  assert.equal(detect([text('1. Use the graph below.', 72, 120)]).length, 1);
  assert.deepEqual(detect([text('1.', 42, 770, 12)]), []);
});

test('a lone second-column question can continue a left-column sequence', () => {
  assert.equal(detect([
    text('1. Find x.', 42, 100), text('2. Find y.', 42, 350), text('3. Find z.', 330, 100),
  ]).length, 3);
});

test('keeps a full-width crop if text crosses a proposed second-column gutter', () => {
  const result = detect([
    text('1. Use the following expression.', 42, 100, 250),
    text('A long formula crosses the center of the page.', 60, 160, 470),
    text('2. Explain your result.', 42, 350, 250),
    text('3. A possible inline list.', 330, 120, 210),
    text('4. Another possible list.', 330, 350, 210),
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every(r => r.x + r.w === 1));
});

test('does not turn isolated far-right numbers into a question column', () => {
  assert.deepEqual(detect([
    text('1. result', 540, 100, 50), text('2. result', 540, 300, 50),
  ]), []);
});

test('deduplicates overprinted text, tolerates unordered input, and does not mutate it', () => {
  const one = text('1. Solve x.', 42, 100), two = text('2. Solve y.', 42, 300);
  const items = Object.freeze([Object.freeze(two), Object.freeze(one), Object.freeze({ ...one })]);
  assert.deepEqual(labels(items), ['1. Solve x.', '2. Solve y.']);
  assert.equal(items[0], two);
});

test('bounds suggestions to the rendered page, preserving bottom diagrams and margin', () => {
  const result = detect([
    text('Question 1: Draw.', -2, 1, 180), text('Question 2: Inspect.', -2, 790, 180),
  ]);
  assert.equal(result.length, 2);
  for (const rect of result) {
    assert.ok([rect.x, rect.y, rect.w, rect.h].every(Number.isFinite));
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0);
    assert.ok(rect.x + rect.w <= 1 && rect.y + rect.h <= 1);
  }
  assert.equal(result[0].x, 0);
  assert.equal(result[0].y, 0);
  assert.equal(result[1].y + result[1].h, 1);
});

test('returns no invented suggestions for scans, unsupported numbering, or invalid input', () => {
  for (const items of [[], null, [null], [text('a) A lettered question.', 42, 100)], [text('No numbered questions here.', 42, 100)], [text('1. Invalid', NaN, 100)], [text('1. Off the page', 800, 100)], [text('1. Zero width', 42, 100, 0)]]) assert.deepEqual(detect(items), []);
  for (const [width, height] of [[0, 800], [600, -1], [Infinity, 800], [600, NaN]]) assert.deepEqual(detectQuestions([text('1. Test', 42, 100)], width, height), []);
});

test('normalizes the same geometry consistently when coordinates are scaled', () => {
  const items = [text('1. Find x.', 42, 100), text('2. Find y.', 42, 300), text('3. Find z.', 330, 100), text('4. Find w.', 330, 300)];
  const scale = 2.5;
  const scaled = items.map(item => ({ ...item, x: item.x * scale, y: item.y * scale, w: item.w * scale, h: item.h * scale }));
  const expected = detect(items), actual = detectQuestions(scaled, WIDTH * scale, HEIGHT * scale);
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(actual[i][key] - expected[i][key]) < 1e-12);
});

test('extracts real sample PDF text across native columns and leaves the scan manual', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(new URL('../public/samples/sample.pdf', import.meta.url)));
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  try {
    const expectedNumbers = [[1, 2, 3], [4, 5, 6, 7], [8, 9], []];
    assert.equal(pdf.numPages, expectedNumbers.length);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => item.str).map(item => {
        const transformed = pdfjs.Util.transform(viewport.transform, item.transform);
        const h = Math.hypot(transformed[2], transformed[3]);
        return { text: item.str, x: transformed[4], y: transformed[5] - h, w: item.width, h };
      });
      const suggestions = detectQuestions(items, viewport.width, viewport.height);
      assert.deepEqual(suggestions.map(rect => Number(/^\d+/.exec(rect.label)[0])), expectedNumbers[pageNumber - 1], `sample page ${pageNumber}`);
      if (pageNumber === 2) assert.ok(suggestions[0].x + suggestions[0].w <= suggestions[2].x);
      if (pageNumber === 4) assert.equal(items.length, 0, 'scan really has no searchable text');
    }
  } finally {
    await pdf.destroy();
  }
});
