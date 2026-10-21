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

test('a wide gap inside an equation does not turn its final constant into an exercise', () => {
  for (const value of [0, 7]) {
    const expression = line('Apply f(x) + g(x)', 60, 114);
    // OCR can omit an equals sign, leaving a gap wide enough for the old label
    // heuristic even though this is still the middle of a continuation line.
    const constant = word(`${value}.`, expression.at(-1).x1 + 16, 114);
    const words = [
      word('42.', 40, 100), ...line('Find the roots of the function.', 60, 100),
      ...expression, constant, ...line('State the answer.', constant.x1 + 3, 114),
      ...line('Give the result to six decimal places.', 60, 128),
      word('43.', 40, 165), ...line('Find the next result.', 60, 165),
    ];
    const result = analyze(words, { ocr: true });
    assert.deepEqual(numbers(result), [42, 43]);
    const problem = result.anchors.find(a => a.number === 42);
    assert.match(problem.text, /six decimal places/);
    assert.ok(problem.text.includes(`${value}.`), 'the equation constant stays in its problem');
    assert.ok(problem.box.y1 >= 130, 'the final visible line remains inside the problem box');
  }
});

test('real exercise zero and aligned compact exercise columns are preserved', () => {
  const single = [word('0.', 40, 100), ...line('Evaluate the expression.', 60, 100)];
  assert.deepEqual(numbers(analyze(single, { ocr: true })), [0]);
  for (const ocr of [false, true]) {
    for (const rows of [[[1, 2]], [[1, 2], [3, 4]], [[1, 2, 3], [4, 5, 6]]]) {
      const grid = rows.flatMap((row, i) => row.flatMap((n, j) => [word(`${n}.`, 40 + j * 40, 100 + i * 40), word('x', 60 + j * 40, 100 + i * 40)]));
      assert.deepEqual(numbers(analyze(grid, { ocr })), rows.flat(), `compact ${rows.length}-row, ${rows[0].length}-column grid, OCR=${ocr}`);
    }
  }
});

test('independent paragraph columns keep every continuation through the next label', () => {
  const words = [];
  const cells = [[1, 40, 100, 4], [2, 310, 106, 3], [3, 40, 160, 5], [4, 310, 146, 6], [5, 40, 240, 2], [6, 310, 240, 3]];
  for (const [n, x, base, count] of cells) {
    words.push(word(`${n}.`, x, base, { bold: true }));
    for (let i = 0; i < count; i++) words.push(...line(`Content${n} continuation${i} stays here.`, x + 20, base + i * 14));
  }
  const result = analyze(words);
  assert.deepEqual(numbers(result), [1, 2, 3, 4, 5, 6]);
  for (const [n, x, , count] of cells) {
    const a = result.anchors.find(a => a.number === n);
    assert.match(a.text, new RegExp(`continuation${count - 1}`), `problem ${n} keeps its final line`);
    for (const other of cells.filter(c => c[0] !== n)) assert.doesNotMatch(a.text, new RegExp(`Content${other[0]}\\b`));
    if (x === 40) assert.ok(a.box.x1 < 310 && a.right < 310, `problem ${n} stays in the left column`);
  }
});

test('compact consecutive rows stay separate while neighboring columns may be skewed', () => {
  for (const ocr of [false, true]) for (const columns of [1, 2]) {
    const words = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < columns; col++) {
      const n = row * columns + col + 1, x = 40 + col * 170, base = 100 + row * 12 + col * 6;
      words.push(word(`${n}.`, x, base, { bold: true }), word(`item${n}`, x + 20, base));
    }
    const result = analyze(words, { ocr });
    assert.equal(result.anchors.length, 3 * columns);
    for (const a of result.anchors) {
      assert.equal(a.text, `item${a.number}`, `exercise ${a.number}, ${columns} columns, OCR=${ocr}`);
      assert.ok(a.top <= a.y0 && a.limit >= a.y1);
    }
  }
});

test('skewed bare-label grids retain tall formulas and their fraction parts', () => {
  const words = [...line('Exer. 1–6: Evaluate.', 40, 60)];
  const cells = [[1, 40, 100], [2, 210, 109], [3, 40, 170], [4, 210, 177], [5, 40, 240], [6, 210, 249]];
  for (const [n, x, base] of cells) {
    words.push(word(String(n), x, base));
    words.push(word(`integral${n}`, x + 20, base, { x1: x + 35, y0: base - 24, y1: base + 17, math: true }));
    words.push(word(`numerator${n}`, x + 42, base - 12, { size: 7, math: true }));
    words.push(word(`denominator${n}`, x + 42, base + 12, { size: 7, math: true }));
    words.push(word(`dx${n}`, x + 100, base, { math: true }));
  }
  const result = analyze(words, { ocr: true });
  assert.deepEqual(numbers(result), [1, 2, 3, 4, 5, 6]);
  for (const [n, x, base] of cells) {
    const a = result.anchors.find(a => a.number === n);
    for (const part of ['integral', 'numerator', 'denominator', 'dx']) assert.match(a.text, new RegExp(`${part}${n}\\b`));
    assert.ok(a.box.y0 <= base - 24 && a.box.y1 >= base + 17, `problem ${n} retains all of its formula height`);
    if (x === 40) assert.ok(a.right < 210 && a.box.x1 < 210);
  }
});

test('a long exercise can span an inner grid column while keeping the outer column separate', () => {
  const words = [];
  for (const [n, x, base] of [[1, 40, 100], [2, 160, 100], [4, 40, 200], [5, 160, 200], [38, 340, 105], [40, 340, 205]]) {
    words.push(word(`${n}.`, x, base, { bold: true }), word(`item${n}`, x + 20, base));
  }
  words.push(word('3.', 40, 150, { bold: true }), ...line('A long expression continues across this inner column.', 60, 150));
  const result = analyze(words);
  const a = result.anchors.find(a => a.number === 3);
  assert.match(a.text, /across this inner column/);
  assert.ok(a.box.x1 > 250 && a.right < 340);
  assert.doesNotMatch(a.text, /item/);
  assert.doesNotMatch(result.anchors.find(a => a.number === 5).text, /expression|inner/);
});

test('bare labels inside a merged row need column support and beat isolated equation values', () => {
  const words = [...line('Exer. 1–6: Evaluate.', 40, 60)];
  for (const [n, x, base] of [[1, 40, 100], [2, 85, 100], [3, 40, 150], [4, 85, 150], [5, 40, 200], [6, 85, 200]]) {
    words.push(word(String(n), x, base), word('f(x)', x + 12, base));
  }
  words.push(word('4', 350, 90), word('fraction', 365, 90));
  const result = analyze(words, { ocr: true });
  assert.deepEqual(numbers(result), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.anchors.find(a => a.number === 4).x0, 85);
});

test('main exercise labels win same-page duplicates while unique review labels keep their scope', () => {
  const words = [
    ...line('Quick Review 5.4', 40, 50, { size: 14 }),
    ...line('1. Review first.', 40, 80, { bold: true }),
    ...line('2. Review second.', 40, 110, { bold: true }),
    ...line('3. Review third.', 40, 140, { bold: true }),
    ...line('Section 5.4 Exercises', 40, 230, { size: 14 }),
    ...line('1. Main first.', 40, 260, { bold: true }),
    ...line('2. Main second.', 310, 260, { bold: true }),
  ];
  for (const figures of [[], [{ x0: 35, y0: 35, x1: 270, y1: 55 }, { x0: 35, y0: 215, x1: 280, y1: 235 }]]) {
    const result = analyze(words, { figures });
    assert.deepEqual(numbers(result), [1, 2, 3]);
    for (const n of [1, 2]) {
      const a = result.anchors.find(a => a.number === n);
      assert.equal(a.review, false);
      assert.match(a.text, /Main/);
    }
    assert.equal(result.anchors.find(a => a.number === 3).review, true);
  }
});

test('corroborated OCR labels still need layout evidence when their formulas are unreadable', () => {
  const words = [...line('Exer. 1–6: Evaluate.', 40, 60)];
  for (const [n, x, base] of [[1, 40, 100], [2, 210, 109], [3, 40, 170], [4, 210, 179], [5, 40, 240], [6, 210, 249]]) {
    words.push(word(String(n), x, base, { ocrLabel: true }));
    if (n % 2 === 0) words.push(word(`formula${n}`, x + 15, base + 20, { y0: base - 20, y1: base + 20 }));
  }
  // A second OCR read can also confirm a real digit inside a formula. It is
  // still not an exercise label without column or row evidence.
  words.push(word('1', 130, 180, { ocrLabel: true }), word('7', 130, 250, { ocrLabel: true }));
  const result = analyze(words, { ocr: true });
  assert.deepEqual(numbers(result), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.anchors.find(a => a.number === 1).x0, 40);
  for (const a of result.anchors) assert.ok(a.top <= a.y0 && a.limit >= a.y1);
});

test('owned diagrams bridge the text to later subparts without reaching the next exercise', () => {
  const words = [
    ...line('1. Consider the diagram.', 40, 100, { bold: true }),
    ...line('Use the dimensions shown below.', 60, 114),
    word('y', 120, 140),
    ...line('(a) Find the width.', 60, 295),
    ...line('(b) Find the height.', 60, 310),
    ...line('(c) State both dimensions.', 60, 325),
    ...line('2. Begin the next problem.', 40, 370, { bold: true }),
    ...line('Unrelated footer text.', 40, 750),
  ];
  const result = analyze(words, { figures: [{ x0: 75, y0: 145, x1: 220, y1: 260 }] });
  const a = result.anchors.find(a => a.number === 1);
  assert.equal(a.figures.length, 1);
  assert.ok(a.figures[0].words.some(w => w.text === 'y'), 'the axis title is preserved outside the drawn lines');
  assert.match(a.text, /\(c\) State both dimensions/);
  assert.doesNotMatch(a.text, /next problem|footer/);
  assert.doesNotMatch(result.anchors.find(a => a.number === 2).text, /footer/);
});

test('a figure before the next column can follow an explicitly referenced final exercise', () => {
  const words = [
    ...line('51. Evaluate the expression.', 40, 100, { bold: true }),
    ...line('52. Evaluate the next expression.', 40, 150, { bold: true }),
    ...line('57. Study the geometry shown in the figure.', 40, 600, { bold: true }),
    ...line('Explain the relationship.', 60, 614),
    ...line('58. Start the next exercise.', 310, 250, { bold: true }),
    ...line('59. Complete the final exercise.', 310, 500, { bold: true }),
    word('Normal', 400, 80),
    ...line('Plane mirror', 390, 202),
  ];
  const result = analyze(words, { figures: [{ x0: 360, y0: 85, x1: 500, y1: 190 }] });
  assert.equal(result.figures[0].owner, 57);
  assert.equal(result.anchors.find(a => a.number === 51).figures, undefined);
  assert.ok(result.figures[0].words.some(w => w.text === 'Normal'));
  assert.ok(result.figures[0].words.some(w => w.text === 'mirror'));
  assert.ok(result.anchors.find(a => a.number === 51).right < 310, 'the figure establishes the right column above its first label');
});

test('tall OCR words in neighboring rows cannot invert cell boundaries', () => {
  const words = [];
  for (const [n, base] of [[38, 168], [40, 202], [41, 234], [42, 267]]) {
    words.push(word(`${n}.`, 340, base));
    words.push(word(`f${n}`, 365, base, { y0: base - 20, y1: base + 10, size: 13 }));
    words.push(word('ds', 450, base, { y0: base - 20, y1: base + 10, size: 23 }));
  }
  const result = analyze(words, { ocr: true });
  for (const a of result.anchors) {
    assert.ok(a.limit > a.base && a.top <= a.y0, `exercise ${a.number} has ordered bounds`);
    assert.match(a.text, new RegExp(`f${a.number}\\b`));
    for (const other of result.anchors.filter(b => b !== a)) assert.doesNotMatch(a.text, new RegExp(`f${other.number}\\b`));
  }
});
