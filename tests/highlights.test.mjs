import test from 'node:test';
import assert from 'node:assert/strict';
import { findMarks } from '../src/raster.js';
import { anchorsForMark } from '../src/analyze.js';

const green = [138, 202, 74], paleGreen = [224, 249, 219];
function page(scale = 3) {
  const width = 240 * scale, height = 180 * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (predicate, rgb) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (predicate((x + 0.5) / scale, (y + 0.5) / scale)) data.set([...rgb, 255], (y * width + x) * 4);
    }
  };
  const rect = (x0, y0, x1, y1, rgb = green) => paint((x, y) => x >= x0 && x < x1 && y >= y0 && y < y1, rgb);
  const circle = (cx, cy, r, thickness, rgb = green) => paint((x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    return d <= r && d >= r - thickness;
  }, rgb);
  return { img: { data, width, height }, scale, rect, circle };
}

function anchor(number, x, y) {
  const label = { text: `${number}.`, x0: x, y0: y, x1: x + 12, y1: y + 10 };
  const text = { text: 'Find the value.', x0: x + 18, y0: y, x1: x + 78, y1: y + 10 };
  return { ...label, number, word: label, words: [label, text], box: { ...label, x1: text.x1 }, right: x + 100 };
}
const selected = (marks, anchors) => [...new Set(marks.flatMap(m => anchorsForMark(m, anchors).map(a => a.number)))].sort((a, b) => a - b);

test('pale green swipes survive scanning without admitting near-neutral paper tints', () => {
  const a = anchor(15, 30, 40), b = anchor(17, 130, 40);
  for (const scale of [1, 2, 3]) {
    const p = page(scale);
    p.rect(27, 37, 110, 53, paleGreen);
    p.rect(127, 37, 210, 53, [238, 246, 239]);
    const marks = findMarks(p.img, scale, 10, { anchors: [a, b] });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].color, 'green');
    assert.deepEqual(selected(marks, [a, b]), [15]);
  }
});

test('thin green circles survive opening only with independently detected enclosed labels', () => {
  const a = anchor(19, 34, 55);
  for (const scale of [1, 2, 3]) {
    const p = page(scale);
    p.circle(40, 60, 12, 1.5, paleGreen);
    const marks = findMarks(p.img, scale, 10, { anchors: [a] });
    assert.equal(marks.length, 1, `thin circle at ${scale} pixels/point`);
    assert.deepEqual(marks[0].enclosed, [19]);
    assert.deepEqual(selected(marks, [a]), [19]);
    assert.equal(findMarks(p.img, scale).length, 0, 'thin decorative rings without a label remain excluded');
  }
});

test('one connected green swipe selects every directly marked label', () => {
  const anchors = [anchor(23, 30, 40), anchor(27, 130, 40), anchor(29, 30, 80)];
  const p = page();
  p.rect(27, 37, 215, 53);
  const marks = findMarks(p.img, p.scale, 10, { anchors });
  assert.equal(marks.length, 1);
  assert.deepEqual(selected(marks, anchors), [23, 27]);
});

test('one connected swipe can select a label and another exercise\'s highlighted body', () => {
  const anchors = [anchor(15, 30, 40), anchor(17, 130, 40)];
  const p = page();
  p.rect(60, 37, 215, 53);
  const marks = findMarks(p.img, p.scale, 10, { anchors });
  assert.equal(marks.length, 1);
  assert.deepEqual(selected(marks, anchors), [15, 17]);
});

test('touching green and yellow strokes retain separate question ownership', () => {
  const anchors = [anchor(15, 30, 40), anchor(17, 150, 40)];
  const p = page();
  p.rect(27, 37, 147, 53);
  p.rect(147, 37, 167, 53, [249, 241, 208]);
  const marks = findMarks(p.img, p.scale, 10, { anchors });
  assert.equal(marks.length, 2);
  assert.deepEqual(selected(marks.filter(m => m.color === 'green'), anchors), [15]);
  assert.deepEqual(selected(marks.filter(m => m.color === 'yellow'), anchors), [17]);
});

test('a connected circle stroke does not select an unmarked question in its bounding rectangle', () => {
  const anchors = [anchor(31, 30, 35), anchor(33, 30, 80), anchor(37, 30, 125)];
  const p = page();
  p.circle(36, 40, 13, 5);
  p.circle(36, 130, 13, 5);
  p.rect(22, 40, 27, 131);
  const marks = findMarks(p.img, p.scale, 10, { anchors });
  assert.equal(marks.length, 1);
  assert.deepEqual(selected(marks, anchors), [31, 37]);
});

test('empty question-cell space is not evidence of a selected exercise', () => {
  const a = anchor(39, 30, 40);
  a.right = 220;
  assert.deepEqual(anchorsForMark({ x0: 160, y0: 39, x1: 180, y1: 53 }, [a]), []);
  assert.deepEqual(anchorsForMark({ x0: 13, y0: 39, x1: 23, y1: 51 }, [a]).map(a => a.number), [39], 'an adjacent margin tick still selects its label');
  assert.deepEqual(anchorsForMark({ x0: 13, y0: 58, x1: 23, y1: 68 }, [a]), [], 'a mark between rows is not snapped to a distant label');
});

test('highlighted continuation text selects its owner even when the label is untouched', () => {
  const a = anchor(41, 30, 40), b = anchor(43, 30, 80);
  const continuation = { text: 'Show each step.', x0: 48, y0: 55, x1: 110, y1: 65 };
  a.words.push(continuation); a.box.y1 = 65;
  const p = page();
  p.rect(47, 54, 112, 67);
  const marks = findMarks(p.img, p.scale, 10, { anchors: [a, b] });
  assert.deepEqual(selected(marks, [a, b]), [41]);
});

test('a printed pale green diagram beside an exercise is not a green selection', () => {
  const a = anchor(41, 30, 40);
  const p = page();
  p.rect(48, 58, 110, 101, [25, 25, 25]);
  p.rect(49, 59, 109, 100, paleGreen);
  const marks = findMarks(p.img, p.scale, 10, { anchors: [a], figures: [{ x0: 48, y0: 58, x1: 110, y1: 101 }] });
  assert.deepEqual(marks, []);
});

test('an intentional swipe through an owned graph selects its exercise', () => {
  const a = anchor(41, 30, 40), b = anchor(43, 140, 40);
  a.figures = [{ x0: 50, y0: 60, x1: 130, y1: 120 }];
  const p = page();
  p.rect(50, 90, 120, 105);
  p.rect(89, 60, 90, 120, [25, 25, 25]);
  const marks = findMarks(p.img, p.scale, 10, { anchors: [a, b], figures: a.figures });
  assert.deepEqual(selected(marks, [a, b]), [41]);
});

test('color separation does not reinterpret a multicolored printed image as several marks', () => {
  const a = anchor(41, 30, 40);
  const f = { x0: 20, y0: 60, x1: 200, y1: 140, pdfImage: true };
  a.figures = [f];
  const p = page();
  p.rect(20, 60, 80, 140, green);
  p.rect(80, 60, 140, 140, [198, 239, 252]);
  p.rect(140, 60, 200, 140, [245, 190, 220]);
  assert.deepEqual(findMarks(p.img, p.scale, 10, { anchors: [a], figures: [f] }), []);
});
