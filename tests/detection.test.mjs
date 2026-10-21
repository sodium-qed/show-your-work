import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage, cleanDirections, directionRange } from '../src/analyze.js';
import { pageWords } from '../src/textlayer.js';

function word(text, x, base, options = {}) {
  const size = options.size ?? 10;
  return { text, x0: x, x1: x + text.length * size * 0.5, y0: base - size * 0.78, y1: base + size * 0.24, base, size, ...options };
}
function line(text, x, base, options) {
  return text.split(' ').map(t => {
    const w = word(t, x, base, options);
    x = w.x1 + 3;
    return w;
  });
}
const analyze = (words, options = {}) => analyzePage({ words, width: 612, height: 792, ...options });
const numbers = result => result.anchors.map(a => a.number).sort((a, b) => a - b);

test('scanned textbook labels without punctuation use aligned exercise numbering', () => {
  const words = [];
  for (const [n, x, y] of [[41, 40, 100], [42, 310, 100], [43, 40, 160], [44, 310, 160], [45, 40, 220], [46, 310, 220], [55, 40, 350], [56, 310, 350], [57, 40, 410], [58, 310, 410]]) {
    words.push(word(String(n), x, y), ...line('Find the integral of f(x).', x + 20, y));
  }
  words.push(...line('Exer. 55–58: Approximate the integral.', 40, 320));
  // Ordinary numbers within the prose are not new problems.
  words.push(...line('Use 54 rectangles and n = 8.', 60, 234));
  const result = analyze(words, { ocr: true });
  assert.deepEqual(numbers(result), [41, 42, 43, 44, 45, 46, 55, 56, 57, 58]);
  assert.deepEqual(result.anchors.find(a => a.number === 57).directions.range, { from: 55, to: 58 });
  assert.match(result.anchors.find(a => a.number === 45).text, /54 rectangles/);
  assert.doesNotMatch(result.directions[0].text, /55 Find/);
});

test('a named two-problem range recognizes bare labels without swallowing their text', () => {
  const words = [
    ...line('Exer. 43–44: Solve the differential equation', 40, 80, { bold: true }),
    ...line('subject to the given conditions.', 40, 94, { bold: true }),
    word('43', 40, 112), ...line('y = 6x + 4', 60, 112),
    word('44', 40, 140), ...line('f(x) = 2x + 1', 60, 140),
  ];
  const result = analyze(words, { ocr: true });
  assert.deepEqual(numbers(result), [43, 44]);
  assert.equal(result.directions.length, 1);
  assert.equal(result.directions[0].text, 'Exer. 43–44: Solve the differential equation subject to the given conditions.');
  assert.equal(result.anchors[0].text, 'y = 6x + 4');
});

test('exercise abbreviations preserve the range and clean printed directions', () => {
  assert.deepEqual(directionRange('Exer. 43–44: Solve the equation.'), { from: 43, to: 44 });
  assert.deepEqual(directionRange('Exer.55–58: Approximate each integral.'), { from: 55, to: 58 });
  assert.equal(cleanDirections('Exer. 43–44: Solve the equation.'), 'Solve the equation.');
  assert.equal(cleanDirections('Exercises 11–18: Find the area.'), 'Find the area.');
});

test('separate PDF number and punctuation runs and glued titles remain problem labels', async () => {
  const items = [
    ['53.', 40, 100, 'bold'], ['Oil Refinery', 62, 100, 'italic'],
    ['54', 40, 150, 'bold'], ['.', 50, 150, 'normal'], ['Designing an Athletic Field', 62, 150, 'italic'],
    ['57.Open-top', 40, 200, 'bold'], ['Box Find the maximum volume.', 102, 200, 'normal'],
  ].map(([str, x, base, fontName]) => ({ str, transform: [10, 0, 0, 10, x, base], width: str.length * 5, fontName }));
  const page = {
    getViewport: () => ({ convertToViewportPoint: (x, y) => [x, y] }),
    getTextContent: async () => ({ items, styles: {} }),
    getOperatorList: async () => ({}),
    commonObjs: { get: name => ({ name: { bold: 'Times-Bold', italic: 'Times-Italic', normal: 'Times-Roman' }[name] }) },
  };
  const result = analyze(await pageWords(page));
  assert.deepEqual(numbers(result), [53, 54, 57]);
  assert.match(result.anchors.find(a => a.number === 54).text, /^Designing an Athletic Field/);
  assert.match(result.anchors.find(a => a.number === 57).text, /^Open-top Box/);
});

test('math constants, decimals, years and page numbers do not become bare problem labels', () => {
  const words = [
    ...line('1 + x = 4', 40, 100),
    ...line('2 + x = 5', 40, 120),
    ...line('3 + x = 6', 40, 140),
    ...line('3.14 is the approximation.', 40, 180),
    ...line('In 2026 the total is 54.', 40, 210),
    word('5)', 140, 300), ...line('find the integral.', 185, 300),
    word('3', 40, 340), word('.', 45, 340), word('14', 50, 340), ...line('is approximately pi.', 65, 340),
    word('57', 300, 760),
    ...line('20 x = y', 310, 100, { math: true }),
    ...line('21 x = y', 310, 120, { math: true }),
    ...line('22 x = y', 310, 140, { math: true }),
  ];
  assert.deepEqual(numbers(analyze(words, { ocr: true })), []);
});

test('bare OCR labels tolerate a wide label gutter but need real following content', () => {
  const words = [];
  for (const [n, y] of [[55, 100], [56, 140], [57, 180]]) {
    words.push(word(String(n), 40, y), ...line('Evaluate the integral.', 75, y));
  }
  words.push(word('58', 40, 230));
  assert.deepEqual(numbers(analyze(words, { ocr: true })), [55, 56, 57]);
});
