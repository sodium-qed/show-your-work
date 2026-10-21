import test from 'node:test';
import assert from 'node:assert/strict';
import { findMarks } from '../src/raster.js';

const blue = [198, 239, 252], yellow = [249, 241, 208], green = [138, 202, 74];
const black = [25, 25, 25];
const figure = { x0: 20, y0: 20, x1: 180, y1: 120 };

function drawing(scale = 3) {
  const width = 200 * scale, height = 140 * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * 4);
  const rect = (x0, y0, x1, y1, rgb) => {
    for (let y = y0 * scale; y < y1 * scale; y++) {
      for (let x = x0 * scale; x < x1 * scale; x++) put(x, y, rgb);
    }
  };
  const ellipse = (cx, cy, radius, thickness, rgb) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const r = Math.hypot((x + 0.5) / scale - cx, (y + 0.5) / scale - cy);
      if (r <= radius && r >= radius - thickness) put(x, y, rgb);
    }
  };
  return { img: { data, width, height }, scale, rect, ellipse };
}

test('outlined printed diagram fills are not interpreted as highlights, regardless of color', () => {
  for (const color of [blue, yellow, green]) {
    const { img, scale, rect } = drawing();
    rect(39, 39, 141, 86, black);
    rect(40, 40, 140, 85, color);
    assert.equal(findMarks(img, scale).length, 1, 'the color alone looks like a marker');
    assert.deepEqual(findMarks(img, scale, 10, { figures: [figure] }), [], 'the matching print outline establishes a filled diagram');
  }
});

test('a genuine blue highlight behind text survives figure overlap', () => {
  const { img, scale, rect } = drawing();
  rect(30, 47, 170, 64, blue);
  for (let x = 35; x < 165; x += 8) rect(x, 49, x + 4, 62, black);
  const words = [{ x0: 35, y0: 49, x1: 167, y1: 62 }];
  for (const pdfImage of [false, true]) {
    const marks = findMarks(img, scale, 10, { figures: [{ ...figure, pdfImage }], words });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].color, 'blue');
  }
});

test('blue highlights crossing a graph are retained', () => {
  const { img, scale, rect } = drawing();
  rect(30, 50, 170, 66, blue);
  rect(80, 25, 81, 115, black);
  rect(25, 57, 175, 58, black);
  for (const pdfImage of [false, true]) {
    const marks = findMarks(img, scale, 10, { figures: [{ ...figure, pdfImage }] });
    assert.equal(marks.length, 1, 'crossing printed axes does not make the stroke a printed fill');
    assert.equal(marks[0].color, 'blue');
  }
});

test('a highlighter circle inside a graph is retained; a printed filled circle is excluded', () => {
  const highlight = drawing();
  highlight.ellipse(90, 70, 30, 7, blue);
  highlight.rect(87, 30, 88, 110, black);
  assert.equal(findMarks(highlight.img, highlight.scale, 10, { figures: [figure] }).length, 1);

  const printed = drawing();
  printed.ellipse(90, 70, 30, 30, black);
  printed.ellipse(90, 70, 29, 29, blue);
  assert.deepEqual(findMarks(printed.img, printed.scale, 10, { figures: [figure] }), []);
});

test('printed-fill filtering requires figure evidence and does not reject ordinary colored marks', () => {
  const { img, scale, rect } = drawing();
  rect(30, 50, 170, 66, green);
  const marks = findMarks(img, scale, 10, { figures: [figure] });
  assert.equal(marks.length, 1, 'marker-colored pixels cannot count as their own printed border');
  assert.equal(marks[0].color, 'green');
});

test('warm shading filling a native illustration is preserved without needing a black outline', () => {
  const { img, scale, rect } = drawing();
  const image = { x0: 60, y0: 40, x1: 140, y1: 100, pdfImage: true };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const px = (x + 0.5) / scale, py = (y + 0.5) / scale;
    if (((px - 100) / 40) ** 2 + ((py - 70) / 30) ** 2 > 1) continue;
    const shade = 70 * (px - image.x0) / (image.x1 - image.x0);
    img.data.set([250 - shade, 230 - shade, 190 - shade, 255], (y * img.width + x) * 4);
  }
  rect(99, 48, 101, 95, black);
  assert.equal(findMarks(img, scale).length, 1, 'the single warm hue otherwise resembles a marker');
  assert.deepEqual(findMarks(img, scale, 10, { figures: [image] }), []);
  assert.equal(findMarks(img, scale, 10, { figures: [{ ...image, pdfImage: false }] }).length, 1,
    'native image placement is required as independent evidence');
});

test('uniform full-image highlights and shaded highlighter circles are retained', () => {
  const fill = drawing();
  const full = { x0: 60, y0: 40, x1: 140, y1: 100, pdfImage: true };
  fill.rect(full.x0, full.y0, full.x1, full.y1, blue);
  assert.equal(findMarks(fill.img, fill.scale, 10, { figures: [full] }).length, 1,
    'a uniform marker rectangle is not shaded artwork');

  const ring = drawing();
  ring.ellipse(100, 70, 30, 7, blue);
  for (let y = 0; y < ring.img.height; y++) for (let x = 0; x < ring.img.width; x++) {
    const offset = (y * ring.img.width + x) * 4;
    if (ring.img.data[offset] === 255) continue;
    const shade = 60 * (x / ring.scale - 70) / 60;
    ring.img.data.set([250 - shade, 230 - shade, 190 - shade, 255], offset);
  }
  const native = { x0: 70, y0: 40, x1: 130, y1: 100, pdfImage: true };
  assert.equal(findMarks(ring.img, ring.scale, 10, { figures: [native] }).length, 1,
    'a thin circle remains a marker even when it matches image bounds and has uneven color');
});
