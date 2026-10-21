import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfImagePlacements, imageFigureBounds } from '../src/document.js';

const names = ['save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd',
  'beginGroup', 'endGroup', 'beginAnnotation', 'endAnnotation', 'paintImageXObject',
  'paintInlineImageXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup', 'paintImageMaskXObject'];
const OPS = Object.fromEntries(names.map((name, i) => [name, i + 1]));
const upright = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const placements = (items, viewport = upright) => pdfImagePlacements({
  fnArray: items.map(([name]) => OPS[name]), argsArray: items.map(([, ...args]) => args),
}, viewport, OPS);

test('image placement follows nested transforms and restores the previous graphics state', () => {
  assert.deepEqual(placements([
    ['save'], ['transform', 2, 0, 0, 3, 10, 20],
    ['save'], ['transform', 40, 0, 0, 30, 5, 7], ['paintImageXObject', 'first'], ['restore'],
    ['transform', 20, 0, 0, 10, 50, 60], ['paintInlineImageXObject', { width: 200, height: 100 }], ['restore'],
    ['transform', 10, 0, 0, 10, 300, 200], ['paintImageXObject', 'third'],
  ]), [
    { x0: 20, y0: 669, x1: 100, y1: 759 },
    { x0: 110, y0: 570, x1: 150, y1: 600 },
    { x0: 300, y0: 590, x1: 310, y1: 600 },
  ]);
  assert.deepEqual(upright.transform, [1, 0, 0, -1, 0, 800], 'the viewport matrix is unchanged');
});

test('rotated viewports and sheared images use all four image corners', () => {
  const rotated = { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] };
  assert.deepEqual(placements([
    ['transform', 40, 10, -20, 30, 100, 200], ['paintImageXObject', 'rotated'],
  ], rotated), [{ x0: 200, y0: 80, x1: 240, y1: 140 }]);
});

test('form bounding boxes clip images and form end restores the parent transform', () => {
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] };
  assert.deepEqual(placements([
    ['transform', 1, 0, 0, 1, 20, 30],
    ['paintFormXObjectBegin', [2, 0, 0, 2, 10, 20], [0, 0, 50, 50]],
    ['transform', 60, 0, 0, 60, -5, -5], ['paintImageXObject', 'clipped'], ['paintFormXObjectEnd'],
    ['transform', 10, 0, 0, 10, 0, 0], ['paintImageXObject', 'outside'],
  ], viewport), [{ x0: 30, y0: 50, x1: 130, y1: 150 }, { x0: 20, y0: 30, x1: 30, y1: 40 }]);
});

test('group clips do not apply their matrix twice and masks or annotations are excluded', () => {
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] };
  assert.deepEqual(placements([
    ['beginGroup', { matrix: [2, 0, 0, 2, 0, 0], bbox: [10, 10, 30, 30] }],
    ['transform', 40, 0, 0, 40, 10, 10], ['paintImageXObject', 'visible'], ['endGroup'],
    ['beginGroup', { bbox: [0, 0, 600, 800], smask: {} }],
    ['transform', 500, 0, 0, 500, 0, 0], ['paintImageXObject', 'soft-mask'], ['endGroup'],
    ['beginAnnotation'], ['transform', 300, 0, 0, 300, 0, 0], ['paintImageXObject', 'stamp'], ['endAnnotation'],
    ['transform', 30, 0, 0, 30, 100, 100], ['paintImageMaskXObject', 'glyph'], ['paintImageXObject', 'after'],
  ], viewport), [{ x0: 20, y0: 20, x1: 50, y1: 50 }, { x0: 100, y0: 100, x1: 130, y1: 130 }]);
});

test('repeated and grouped inline images retain each placement', () => {
  assert.deepEqual(placements([
    ['transform', 1, 0, 0, 1, 10, 20],
    ['paintImageXObjectRepeat', 'repeat', 20, 30, new Float32Array([0, 0, 50, 60])],
    ['paintInlineImageXObjectGroup', {}, [{ transform: [30, 0, 0, 40, 100, 120] }]],
  ]), [
    { x0: 10, y0: 750, x1: 30, y1: 780 },
    { x0: 60, y0: 690, x1: 80, y1: 720 },
    { x0: 110, y0: 620, x1: 140, y1: 660 },
  ]);
});

test('only illustration-sized image bounds supplement figures, never scans, labels, or banners', () => {
  const illustration = { x0: 440, y0: 150, x1: 540, y1: 248 };
  const embeddedExercise = { x0: 40, y0: 180, x1: 250, y1: 340 };
  const images = [
    illustration, { ...illustration },
    { x0: 0, y0: 0, x1: 612, y1: 792 },
    { x0: 6, y0: 80, x1: 606, y1: 700 },
    { x0: 40, y0: 70, x1: 74, y1: 92 },
    { x0: 45, y0: 50, x1: 201, y1: 71.6 },
    { x0: 60, y0: 0, x1: 480, y1: 30 },
    embeddedExercise,
  ];
  const words = [
    { text: '12.', x0: 45, y0: 190, x1: 60, y1: 200 },
    { text: '4', x0: 480, y0: 200, x1: 485, y1: 210 }, // diagram dimension
  ];
  assert.deepEqual(imageFigureBounds(images, words, 10, 612, 792), [illustration]);
});

test('partial-page scans with bare exercise labels remain readable while diagram dimensions remain figures', () => {
  const embedded = { x0: 40, y0: 100, x1: 290, y1: 350 };
  const word = (text, x0, base, extra = {}) => ({ text, x0, x1: x0 + text.length * 5, y0: base - 8, y1: base + 2, base, ...extra });
  const exercises = [word('1', 50, 130), word('Find', 65, 130), word('area', 90, 130),
    word('2', 50, 190), word('Explain', 65, 190), word('reasoning', 105, 190)];
  assert.deepEqual(imageFigureBounds([embedded], exercises, 10, 612, 792), []);
  const mathLabels = [word('1', 50, 130, { ocrLabel: true }), word('2', 50, 190, { ocrLabel: true })];
  assert.deepEqual(imageFigureBounds([embedded], mathLabels, 10, 612, 792), [], 'corroborated math labels need no decoded prose');
  const dimensions = [word('4', 80, 160), word('6', 140, 220), word('cm', 150, 220)];
  assert.deepEqual(imageFigureBounds([embedded], dimensions, 10, 612, 792), [embedded]);
  const paragraph = Array.from({ length: 18 }, (_, i) => word('paragraph', 45 + i % 3 * 70, 125 + Math.floor(i / 3) * 15));
  assert.deepEqual(imageFigureBounds([embedded], paragraph, 10, 612, 792), [], 'substantial prose is not a diagram even without a label');
});
