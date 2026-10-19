/**
 * Extract a review draft from positioned PDF text, without OCR or transcription.
 * Items and rect {x, y, w, h} use rendered-page points with a top-left origin.
 * Runs at least half covered by the crop are retained whole; characters cannot
 * be clipped reliably from a text run's bounding box. All boundary cuts warn.
 * Rows are read top-to-bottom, then left-to-right. Possible columns warn rather
 * than claiming reliable column order. Only whitespace is reconstructed.
 */
export function extractRegionText(items, rect) {
  const warnings = [];
  if (!validBox(rect)) return { text: '', warnings: ['The selected crop has invalid bounds.'] };
  if (!Array.isArray(items)) return { text: '', warnings: ['No selectable PDF text was found in this crop.'] };
  const right = rect.x + rect.w, bottom = rect.y + rect.h;
  const selected = [];
  const seen = new Set();
  let invalid = false, boundary = false;
  for (const item of items) {
    if (!item || typeof item.text !== 'string') { invalid = true; continue; }
    if (!item.text.trim()) continue;
    if (!validBox(item)) { invalid = true; continue; }
    const overlapW = Math.min(right, item.x + item.w) - Math.max(rect.x, item.x);
    const overlapH = Math.min(bottom, item.y + item.h) - Math.max(rect.y, item.y);
    if (overlapW <= 0 || overlapH <= 0) continue;
    const tolerance = item.h * 0.01;
    if (item.x < rect.x - tolerance || item.y < rect.y - tolerance ||
        item.x + item.w > right + tolerance || item.y + item.h > bottom + tolerance) boundary = true;
    if ((overlapW / item.w) * (overlapH / item.h) < 0.5) continue;
    const key = JSON.stringify([item.text, item.x, item.y, item.w, item.h]);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      x: item.x, y: item.y, w: item.w, h: item.h, baseline: item.y + item.h,
      // Preserve Unicode and punctuation verbatim; do not normalize math glyphs.
      text: item.text.replace(/[\t\r\n\f\v ]+/g, ' ').trim(),
      leadingSpace: /^\s/u.test(item.text), trailingSpace: /\s$/u.test(item.text),
    });
  }
  if (invalid) warnings.push('Some PDF text runs had invalid positions or content and were skipped.');
  if (boundary) warnings.push('The crop cuts through text. Check for extra or missing words, or adjust the crop.');
  if (!selected.length) return { text: '', warnings: [...warnings, 'No selectable PDF text was found in this crop.'] };

  const heights = selected.map(item => item.h).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)];
  const rows = [];
  for (const item of selected.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const row = rows.at(-1);
    const tolerance = row ? Math.max(typicalHeight * 0.05, Math.min(row.h, item.h) * 0.25) : 0;
    if (row && Math.abs(item.baseline - row.baseline) <= tolerance) {
      row.items.push(item);
      row.top = Math.min(row.top, item.y);
      row.bottom = Math.max(row.bottom, item.baseline);
    } else rows.push({ baseline: item.baseline, h: item.h, top: item.y, bottom: item.baseline, items: [item] });
  }

  let columns = false, mixedBaselines = false, lineHyphen = false;
  const lines = rows.map((row, index) => {
    row.items.sort((a, b) => a.x - b.x);
    if (index && row.top < rows[index - 1].bottom - typicalHeight * 0.1) mixedBaselines = true;
    let line = row.items[0].text;
    for (let i = 1; i < row.items.length; i++) {
      const previous = row.items[i - 1], next = row.items[i];
      const gap = next.x - previous.x - previous.w;
      if (gap > Math.max(typicalHeight * 3, rect.w * 0.12)) columns = true;
      const explicitSpace = previous.trailingSpace || next.leadingSpace;
      const bindsPunctuation = /^[,.;:!?%‰°)\]}»”’]/u.test(next.text) || /[(\[{«“‘]$/u.test(previous.text);
      const separator = explicitSpace || (!bindsPunctuation && gap > Math.min(previous.h, next.h) * 0.15) ? ' ' : '';
      line += separator + next.text;
    }
    return line;
  });
  let text = lines[0];
  for (let index = 1; index < lines.length; index++) {
    // Keep an explicit line-end hyphen; never guess whether to delete it.
    const hyphenated = /[\p{L}\p{M}][-‐\u00ad]$/u.test(lines[index - 1]) && /^[\p{L}\p{M}]/u.test(lines[index]);
    if (hyphenated) lineHyphen = true;
    text += (hyphenated ? '' : ' ') + lines[index];
  }
  if (columns) warnings.push('This crop may contain columns or widely separated text. Reading order needs review; selecting one column at a time may help.');
  if (mixedBaselines) warnings.push('Some text uses separate baselines. Check fractions, exponents, and other notation whose meaning depends on its position.');
  if (lineHyphen) warnings.push('Line-end hyphens were kept. Check whether each hyphen belongs in the word.');
  warnings.push('Review all extracted wording and mathematical notation against the source before applying. Diagrams and text styling are not included.');
  return { text, warnings };
}

function validBox(box) {
  return Boolean(box && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(box[key])) &&
    box.w > 0 && box.h > 0 && Number.isFinite(box.x + box.w) && Number.isFinite(box.y + box.h));
}
