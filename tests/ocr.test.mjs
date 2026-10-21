import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrWordRecords } from '../src/ocr.js';

test('tall integral rows do not inflate label size or move the label baseline', () => {
  const data = { blocks: [{ paragraphs: [{ lines: [{
    bbox: { x0: 100, y0: 100, x1: 700, y1: 245 },
    rowAttributes: { row_height: 145 }, baseline: { x0: 0, y0: 110, x1: 700, y1: 120 },
    words: [
      { text: '12', confidence: 94, bbox: { x0: 100, y0: 165, x1: 145, y1: 201 } },
      { text: 'dx', confidence: 92, bbox: { x0: 600, y0: 168, x1: 650, y1: 201 } },
      { text: '(x²+1)', confidence: 85, bbox: { x0: 200, y0: 100, x1: 570, y1: 245 } },
    ],
  }] }] }] };
  const words = ocrWordRecords(data, 3);
  const label = words[0];
  assert.equal(label.base, 67, 'the printed number baseline is its ink bottom, not the integral row baseline');
  assert.equal(label.y0, 55);
  assert.ok(label.size >= 15 && label.size <= 17, 'a 12-point-tall glyph is ordinary body text');
  assert.equal(words[2].y0, 100 / 3, 'normalizing font metrics retains the entire formula ink bounds');
  assert.equal(words[2].y1, 245 / 3);
  assert.ok(words[2].size < 20, 'a stacked formula does not become a giant heading');
});

test('ordinary OCR preserves valid text baselines and crop offsets', () => {
  const data = { blocks: [{ paragraphs: [{ lines: [{
    bbox: { x0: 5, y0: 10, x1: 90, y1: 32 }, rowAttributes: { row_height: 24 },
    baseline: { x0: 0, y0: 28, x1: 100, y1: 28 },
    words: [{ text: 'graph', confidence: 96, bbox: { x0: 5, y0: 10, x1: 90, y1: 32 } }],
  }] }] }] };
  const [word] = ocrWordRecords(data, 2, { x: 40, y: 120 });
  assert.deepEqual([word.x0, word.y0, word.x1, word.y1, word.base], [42.5, 125, 85, 136, 134]);
  assert.equal(word.text, 'graph');
});
