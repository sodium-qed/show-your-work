import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees, beginText, endText, setFontAndSize, setTextMatrix, showText } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pageWords } from '../src/textlayer.js';
import { analyzePage } from '../src/analyze.js';

test('horizontal PDF shear preserves exercise labels while rotated baselines stay excluded', async () => {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([612, 792]);
  for (const [i, number] of [42, 47, 52].entries()) {
    const y = 700 - i * 70;
    page.drawText(`${number}.`, { x: 50, y, font: bold, size: 11, ySkew: degrees(i === 1 ? -12 : 12) });
    page.drawText('Find the required value and explain each step in the calculation.', { x: 74, y, font: body, size: 11 });
  }
  page.drawText('99. Rotated annotation', { x: 560, y: 500, font: body, size: 11, rotate: degrees(90) });

  const loaded = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  try {
    const pdfPage = await loaded.getPage(1);
    const raw = (await pdfPage.getTextContent()).items;
    const labels = raw.filter(item => /^(?:42|47|52)\./.test(item.str));
    assert.equal(labels.length, 3, 'PDF.js exposes the visible labels');
    assert.ok(labels.every(item => item.transform[1] === 0 && Math.abs(item.transform[2]) > 1), 'the glyphs are sheared but the baseline is horizontal');
    const words = await pageWords(pdfPage);
    assert.ok(words.filter(w => /[a-z]{2}/i.test(w.text)).length >= 12, 'this page would pass the prose-count gate without OCR');
    assert.deepEqual(words.filter(w => /^(?:42|47|52)\.$/.test(w.text)).map(w => w.size), [11, 11, 11]);
    assert.ok(!words.some(w => w.text === '99.' || w.text === 'Rotated'), 'actual rotated text remains excluded');
    assert.deepEqual(analyzePage({ words, width: 612, height: 792 }).anchors.map(a => a.number), [42, 47, 52]);
  } finally {
    await loaded.destroy();
  }
});

test('signed and zero PDF vertical scales never produce negative or zero word sizes', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  const key = page.node.newFontDictionary(font.name, font.ref);
  // Exercise the geometry fallback with real PDF matrices, including a degenerate
  // scale; this does not claim that collapsed glyphs are readable exercise labels.
  for (const [text, d, y] of [['Signed', -1, 650], ['Zero', 0, 600]]) {
    page.pushOperators(beginText(), setFontAndSize(key, 11), setTextMatrix(1, 0, 0.2, d, 50, y), showText(font.encodeText(text)), endText());
  }
  const loaded = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  try {
    const words = await pageWords(await loaded.getPage(1));
    assert.deepEqual(words.map(w => w.text), ['Signed', 'Zero']);
    assert.equal(words[0].size, 11);
    assert.ok(words.every(w => Number.isFinite(w.size) && w.size > 0 && w.y1 > w.y0));
  } finally {
    await loaded.destroy();
  }
});
