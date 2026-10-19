/**
 * Suggest crops from a PDF text layer, never from OCR or reconstructed math.
 * Coordinates use the rendered page's top-left origin. Results need review:
 * text alone cannot reveal diagram edges, answer space, or all reading orders.
 */
export function detectQuestions(items, pageWidth, pageHeight) {
  if (!Array.isArray(items) || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) return [];
  const unit = pageWidth / 612;
  const seen = new Set();
  const boxes = items.flatMap(item => {
    if (!item || typeof item.text !== 'string' || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(item[key]))) return [];
    const text = item.text.replace(/\s+/gu, ' ').trim();
    const right = item.x + item.w, bottom = item.y + item.h;
    if (!text || item.w <= 0 || item.h <= 0 || !Number.isFinite(right) || !Number.isFinite(bottom) || right <= 0 || bottom <= 0 || item.x >= pageWidth || item.y >= pageHeight) return [];
    const key = `${text}|${item.x}|${item.y}|${item.w}|${item.h}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ text, x: item.x, y: item.y, w: item.w, h: item.h, baseline: bottom }];
  });
  if (!boxes.length) return [];

  const rows = textRows(boxes, unit);
  const anchors = rows.flatMap(row => row.items.flatMap((box, index) => {
    // A number in the middle of a sentence or formula is not a question start.
    const previous = row.items[index - 1];
    if (previous && box.x - previous.x - previous.w <= Math.max(6 * unit, box.h * 0.75)) return [];
    const label = joinedLabel(row.items, index, unit);
    const prefix = questionPrefix(label);
    if (!prefix) return [];
    // PDF producers sometimes split a decimal into "1." and "25" runs.
    const next = row.items[index + 1];
    if (/^[1-9]\d{0,2}\.$/.test(box.text) && next && /^\d/.test(next.text) && next.x - box.x - box.w < box.h * 0.25) return [];
    return [{ ...box, ...prefix, label: label.slice(0, 90) }];
  }));
  if (!anchors.length) return [];

  // This tolerance accommodates right-aligned one/two-digit labels without
  // treating ordinary indented subparts as another column.
  const tolerance = Math.max(7 * unit, pageWidth * 0.015);
  const groups = [];
  for (const anchor of anchors.sort((a, b) => a.x - b.x || a.y - b.y)) {
    let group = groups.find(g => Math.abs(g.x - anchor.x) <= tolerance);
    if (!group) { group = { x: anchor.x, anchors: [] }; groups.push(group); }
    group.anchors.push(anchor);
  }
  for (const group of groups) {
    group.anchors.sort((a, b) => a.y - b.y || a.x - b.x);
    group.anchors = group.anchors.filter((anchor, index, all) => !index || anchor.y - all[index - 1].y > Math.min(anchor.h, all[index - 1].h) * 0.6);
    group.x = Math.min(...group.anchors.map(a => a.x));
    const increases = group.anchors.slice(1).filter((a, index) => a.number > group.anchors[index].number).length;
    group.sequence = group.anchors.length > 1 && increases / (group.anchors.length - 1) >= 0.6;
    group.explicit = group.anchors.some(a => a.explicit);
    group.hasBody = group.anchors.some(a => a.hasBody);
  }

  // Favor the outer margin over nested lists. A single bare number needs some
  // accompanying text; an explicit "Question 3" can stand on its own.
  const first = groups.find(g => g.x < pageWidth * 0.4 && (g.sequence || g.explicit || (g.anchors.length === 1 && g.x < pageWidth * 0.27 && g.hasBody)));
  if (!first) return [];
  const columns = [first];
  const firstLast = first.anchors.at(-1);
  const second = groups.find(g => {
    if (g.x - first.x < pageWidth * 0.28 || g.x > pageWidth * 0.75) return false;
    const singleContinuation = g.anchors.length === 1 && g.hasBody && g.anchors[0].number > firstLast.number && Math.abs(g.anchors[0].y - first.anchors[0].y) < pageHeight * 0.15;
    if (!(g.sequence || g.explicit || singleContinuation)) return false;
    // A line crossing the proposed gutter is evidence of a full-width layout.
    // Refuse that split rather than clipping a formula at an invented column.
    const top = Math.min(first.anchors[0].y, g.anchors[0].y);
    const bottom = Math.max(firstLast.y + firstLast.h, g.anchors.at(-1).y + g.anchors.at(-1).h);
    const boundary = g.x - 4 * unit;
    return !boxes.some(b => b.y >= top && b.y < bottom && b.x < boundary - 8 * unit && b.x + b.w > boundary);
  });
  if (second) columns.push(second);

  const results = [];
  for (const [columnIndex, column] of columns.entries()) {
    const padX = 6 * unit;
    const left = Math.max(0, column.x - padX);
    const right = columnIndex + 1 < columns.length ? columns[columnIndex + 1].x - padX : pageWidth;
    for (const [index, anchor] of column.anchors.entries()) {
      const padY = Math.max(2 * unit, Math.min(6 * unit, anchor.h * 0.3));
      const top = Math.max(0, anchor.y - padY);
      const next = column.anchors[index + 1];
      const bottom = next ? Math.max(0, next.y - Math.max(2 * unit, Math.min(6 * unit, next.h * 0.3))) : pageHeight;
      if (right <= left || bottom <= top) continue;
      results.push({ x: left / pageWidth, y: top / pageHeight, w: (right - left) / pageWidth, h: (bottom - top) / pageHeight, label: anchor.label });
    }
  }
  return results;
}

function textRows(boxes, unit) {
  const rows = [];
  for (const box of boxes.slice().sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(row.baseline - box.baseline) <= Math.max(unit, Math.min(row.h, box.h) * 0.3)) row.items.push(box);
    else rows.push({ baseline: box.baseline, h: box.h, items: [box] });
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

function joinedLabel(items, start, unit) {
  let label = items[start].text;
  for (let index = start + 1; index < items.length && label.length < 120; index++) {
    const next = items[index], previous = items[index - 1];
    if (next.x - previous.x - previous.w > Math.max(12 * unit, Math.min(next.h, previous.h) * 2.5)) break;
    if (questionPrefix(label) && questionPrefix(next.text)) break;
    // Number and punctuation may be independent PDF text runs.
    const separator = /^[1-9]\d{0,2}$/.test(label) && /^[.)]/.test(next.text) ? '' : ' ';
    label += separator + next.text;
  }
  return label;
}

function questionPrefix(text) {
  const explicit = /^(?:Question|Problem)\s+([1-9]\d{0,2})(?=$|[\s:.)])/i.exec(text);
  if (explicit) {
    const rest = text.slice(explicit[0].length);
    if (/^\.\d/.test(rest)) return null;
    return { number: Number(explicit[1]), explicit: true, hasBody: Boolean(rest.replace(/^[\s:.)]+/, '').trim()) };
  }
  const plain = /^([1-9]\d{0,2})[.)](?=\s|$)\s*/.exec(text);
  return plain ? { number: Number(plain[1]), explicit: false, hasBody: text.length > plain[0].length } : null;
}
