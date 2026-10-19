import assert from 'node:assert/strict';
import { PDFDict, PDFName, decodePDFRawStream } from 'pdf-lib';

const identity = () => [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

// Inspect the actual exported content streams. The worksheet emits rectangular
// clips in page coordinates and affine image placements. Reducing those PDF
// operators independently gives the source intervals displayed on each page.
export function imageClipIntervals(pdf) {
  const intervals = [];
  for (const [index, page] of pdf.getPages().entries()) {
    const objects = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
    const content = page.node.Contents();
    const chunks = [];
    for (let i = 0; i < content.size(); i++) chunks.push(Buffer.from(decodePDFRawStream(pdf.context.lookup(content.get(i))).decode()).toString());
    let matrix = identity(); let clipping = null; let rectangle = null;
    const stack = [];
    for (const line of chunks.join('\n').split('\n')) {
      const tokens = line.trim().split(/\s+/); const operator = tokens.pop();
      if (operator === 'q') stack.push({ matrix: [...matrix], clipping });
      else if (operator === 'Q') ({ matrix, clipping } = stack.pop());
      else if (operator === 'cm') matrix = multiply(matrix, tokens.map(Number));
      else if (operator === 're') {
        assert.deepEqual(matrix, identity(), 'Export crop rectangles are expressed in page coordinates.');
        rectangle = tokens.map(Number);
      } else if (operator === 'W') clipping = rectangle;
      else if (operator === 'Do' && clipping) {
        const ref = objects.get(PDFName.of(tokens[0].slice(1)));
        const image = pdf.context.lookup(ref);
        const [, clipY, clipWidth, clipHeight] = clipping;
        const fullHeight = matrix[3];
        assert.ok(fullHeight > 0 && clipHeight > 0);
        assert.ok(Math.abs(matrix[0] - clipWidth) < 1e-7, 'A continuation clip includes the full crop width.');
        intervals.push({
          page: index + 1, image: String(ref),
          sourceTop: 1 - (clipY + clipHeight - matrix[5]) / fullHeight,
          sourceHeight: clipHeight / fullHeight,
          pixelWidth: Number(String(image.dict.lookup(PDFName.of('Width')))),
          pixelHeight: Number(String(image.dict.lookup(PDFName.of('Height')))),
        });
      }
    }
  }
  return intervals;
}
