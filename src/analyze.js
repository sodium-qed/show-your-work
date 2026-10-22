// Page layout analysis. Pure geometry: no DOM, so it runs in Node tests.
// Coordinates are page units (PDF points for PDFs), origin top-left.
//
// A word: { text, x0, y0, x1, y1, base, size, bold, italic, math }
// A figure: { x0, y0, x1, y1 } — non-text ink found in the raster.

const DASH = '[–—−-]';
const EXERCISES = '(?:Problems?|Exercises?|Questions?|Exer\\.?|Exs?\\.)';
const DIRECTION_START = new RegExp(`^(?:(?:In|For)\\s+)?${EXERCISES}\\s*\\d`, 'i');
const DIRECTION_PREFIX = new RegExp(`^(?:(?:In|For)\\s+)?${EXERCISES}\\s*\\d+(?:\\s*(?:${DASH}|and|through|to)\\s*\\d+)?\\s*[:,]?\\s*`, 'i');
const ANCHOR = /^(\d{1,3})[.)]$/;
const OCR_ANCHOR = /^(\d{1,3})[.,:)]$/;
const VERB = /^(match|plot|find|write|solve|graph|sketch|simplify|evaluate|use|determine|convert|express|identify|show|verify|factor|compute|calculate|explain|answer|fill|complete|state|list|describe|decide|tell|give|draw|name|prove|estimate|approximate|rewrite|translate|classify)\b/i;

const median = values => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const overlapX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const overlapY = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
const union = (a, b) => a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
const inside = (w, r, tol = 0) => w.x0 >= r.x0 - tol && w.x1 <= r.x1 + tol && w.y0 >= r.y0 - tol && w.y1 <= r.y1 + tol;
const centerIn = (w, r) => { const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2; return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1; };

/** Group words into visual lines, then split lines into segments at wide gaps. */
export function segments(words, bodySize) {
  const sorted = [...words].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const line = lines.find(l => Math.abs(l.base - w.base) <= 0.35 * Math.max(bodySize, w.size) && w.size > 0.75 * l.size);
    if (line) { line.words.push(w); } else lines.push({ base: w.base, size: w.size, words: [w] });
  }
  const out = [];
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    let seg = null;
    for (const w of line.words) {
      if (!seg || w.x0 - seg.x1 > 2.2 * bodySize) {
        seg = { words: [], base: line.base, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
        out.push(seg);
      }
      seg.words.push(w);
      Object.assign(seg, union(seg, w));
    }
  }
  for (const s of out) {
    s.text = s.words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    s.size = median(s.words.map(w => w.size));
    s.italic = s.words.filter(w => w.italic).length > s.words.length / 2;
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** Problem ranges named by a directions sentence ("In Problems 11–18, ..."). */
export function directionRange(text) {
  const t = text.replace(/\s+/g, ' ');
  let m = t.match(new RegExp(`${EXERCISES}\\s*(\\d+)\\s*${DASH}\\s*(\\d+)`, 'i'));
  if (m) return { from: +m[1], to: +m[2] };
  m = t.match(new RegExp(`${EXERCISES}\\s*(\\d+)\\s+(?:and|through|to)\\s+(\\d+)`, 'i'));
  if (m) return { from: +m[1], to: +m[2] };
  m = t.match(new RegExp(`${EXERCISES}\\s*(\\d+)\\b`, 'i'));
  if (m) return { from: +m[1], to: +m[1] };
  return null;
}

/** Strip "In Problems 11–18," and capitalize, for printing the directions as text. */
export function cleanDirections(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(DIRECTION_PREFIX, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function isDirections(seg, width, bodySize) {
  if (DIRECTION_START.test(seg.text)) return true;
  // Italic imperative sentences spanning a good part of the page ("Match each point...").
  return seg.italic && VERB.test(seg.text) && seg.x1 - seg.x0 > 0.3 * width && seg.size <= bodySize * 1.15;
}

// PDF producers may put a label's digits and punctuation in different font runs,
// or join a label to its title. Normalize those forms without splitting decimals.
function numberLabelWords(words) {
  const punctuation = words.filter(w => /^[.)]$/.test(w.text));
  const consumed = new Set();
  const joined = new Map();
  for (const w of words) {
    if (!/^\d{1,3}$/.test(w.text)) continue;
    const p = punctuation.find(p => !consumed.has(p) && p.x0 >= w.x1 - 0.1 * w.size && p.x0 - w.x1 <= 0.35 * w.size && Math.abs(p.base - w.base) <= 0.25 * w.size);
    if (!p) continue;
    // A tightly adjoining digit after a period is a decimal, not a label.
    if (p.text === '.' && words.some(n => /^\d/.test(n.text) && n !== w && n.x0 >= p.x1 - 0.1 * w.size && n.x0 - p.x1 <= 0.35 * w.size && Math.abs(n.base - w.base) <= 0.25 * w.size)) continue;
    consumed.add(p);
    joined.set(w, { ...w, text: w.text + p.text, x1: p.x1, bold: w.bold || p.bold });
  }
  return words.flatMap(original => {
    if (consumed.has(original)) return [];
    const w = joined.get(original) || original;
    const m = w.text.match(/^(\d{1,3}[.)])(?=[A-Za-z]{2})/);
    if (!m) return [w];
    const cut = w.x0 + (w.x1 - w.x0) * m[1].length / w.text.length;
    return [{ ...w, text: m[1], x1: cut }, { ...w, text: w.text.slice(m[1].length), x0: cut }];
  });
}

/**
 * Analyze one page.
 * @returns {{anchors, directions, headings, figures, bodySize}}
 * anchors: [{ number, word, box, crop, figure }]  box = owned text; crop = box grown by ink later.
 */
export function analyzePage({ words, width, height, figures: rawFigures = [], ocr = false }) {
  words = numberLabelWords(words.filter(w => w.text && w.text.trim() && w.x1 > w.x0));
  const bodySize = median(words.filter(w => w.text.length > 1).map(w => w.size)) || 10;
  const segs = segments(words, bodySize);

  // Figures: non-text ink. Words sitting inside one belong to it (axis labels etc.).
  const figures = rawFigures.map((f, i) => ({ ...f, id: `fig${i}`, words: [] }));
  const figureOf = new Map();
  for (const w of words) {
    const f = figures.find(f => centerIn(w, { x0: f.x0 - 2, y0: f.y0 - 2, x1: f.x1 + 2, y1: f.y1 + 2 }));
    if (f) { figureOf.set(w, f); f.words.push(w); }
  }
  // A text word labelled inside a figure doesn't start problems or lines of prose.
  const free = w => !figureOf.has(w);

  // Bare exercise numbers need independent layout evidence. Do not make the
  // punctuation optional in ANCHOR: that would turn equation constants into labels.
  const potential = [];
  for (const seg of segs) {
    seg.words.forEach((w, j) => {
      if (w.ocrSupplement && !w.corroboratedLabel) return;
      const m = w.text.match(ocr ? OCR_ANCHOR : ANCHOR);
      const bare = !m && /^[1-9]\d{0,2}$/.test(w.text);
      if ((!m && !bare) || !free(w)) return;
      const prev = seg.words[j - 1];
      const leads = j === 0 || (prev && w.x0 - prev.x1 > 1.2 * bodySize);
      // Bare labels with a wide gutter can use another segment; they still have to
      // pass the alignment/sequence checks below. Isolated math such as "5)" cannot.
      const next = bare ? words.filter(n => n !== w && free(n) && n.x0 >= w.x1 && n.x0 - w.x1 <= 6 * bodySize &&
        (Math.abs(n.base - w.base) <= 0.65 * bodySize || overlapY(n, w) > 0)).sort((a, b) => a.x0 - b.x0)[0] : seg.words[j + 1];
      // A corroborated OCR label can have completely unreadable mathematics to
      // its right. Pixel-backed OCR corroboration is independent of the column
      // and sequence checks below; it does not make the label trusted outright.
      const followed = (!!next && next.x0 - w.x1 <= (bare ? 6 : 4) * bodySize) || !!w.ocrLabel;
      if (!followed && (!ocr || bare)) return;
      if (!(w.bold || leads || bare)) return;
      if (bare && (w.math || (next && next.x0 - w.x1 < (w.ocrLabel ? 0.1 : 0.25) * bodySize))) return;
      const operator = bare && !!next && /^[+−–=×÷<>≤≥*/^.,)\]}-]/.test(next.text);
      potential.push({ number: m ? +m[1] : +w.text, word: w, bold: !!w.bold, bare, followed,
        inline: j > 0 && !w.bold, leads, operator, rowNumber: seg.words[0].text.match(ocr ? OCR_ANCHOR : ANCHOR)?.[1] ?? null,
        x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, base: w.base, size: w.size });
    });
  }
  const ranges = segs.filter(s => DIRECTION_START.test(s.text)).map(s => ({ ...s, range: directionRange(s.text) })).filter(s => s.range);
  const bareWords = new Set(potential.filter(c => {
    if (!c.bare || (c.operator && !c.word.ocrLabel)) return false;
    const peers = potential.filter(o => o !== c && o.number !== c.number && (!o.operator || o.word.ocrLabel) && Math.abs(o.x0 - c.x0) < 0.8 * bodySize && Math.abs(o.base - c.base) > 0.6 * bodySize);
    const sequence = peers.filter(o => Math.abs(o.number - c.number) <= 3 && (o.number - c.number) * (o.base - c.base) > 0);
    if (sequence.length && (peers.length >= 2 || sequence.some(o => !o.bare))) return true;
    // A two-exercise section can supply the same evidence through its named range.
    // The other label must share a column or an increasing row. A range alone
    // does not turn a numerator elsewhere on the page into an exercise number.
    return ranges.some(s => c.number >= s.range.from && c.number <= s.range.to && c.base > s.base && c.x0 >= s.x0 - bodySize && potential.some(o => o !== c && o.number !== c.number && o.number >= s.range.from && o.number <= s.range.to && o.base > s.base && o.x0 >= s.x0 - bodySize && (
      sequence.includes(o) || (Math.abs(o.base - c.base) < 1.2 * bodySize && (o.number - c.number) * (o.x0 - c.x0) > 0 && Math.abs(o.number - c.number) <= 3 && (Math.abs(o.x0 - s.x0) < bodySize || Math.abs(c.x0 - s.x0) < bodySize))
    )));
  }).map(c => c.word));
  // The last cell in an otherwise established row may occur only once (for
  // example exercises38 and39 above full-width40). Its predecessor supplies
  // independent evidence even when OCR only read an operator in its formula.
  for (const c of potential) if (c.bare && !bareWords.has(c.word) && ranges.some(s => c.number >= s.range.from && c.number <= s.range.to && c.base > s.base) &&
    potential.some(o => bareWords.has(o.word) && o.number === c.number - 1 && o.x1 < c.x0 && Math.abs(o.base - c.base) < 1.2 * bodySize)) bareWords.add(c.word);
  const startsProblem = seg => (ocr ? OCR_ANCHOR : ANCHOR).test(seg.words[0].text) || bareWords.has(seg.words[0]);

  const directions = [];
  const headings = [];
  const used = new Set();
  for (const [i, seg] of segs.entries()) {
    if (used.has(seg) || !seg.words.some(free)) continue;
    const anchorLed = startsProblem(seg);
    if (!anchorLed && isDirections(seg, width, bodySize)) {
      const block = { segs: [seg], ...union(null, seg) };
      // Continuation lines: directly below, aligned, not starting a problem. A continuation
      // line brings along its other segments ("(a) ...   (b) ...   (c) ...").
      let last = seg;
      for (const next of segs.slice(i + 1)) {
        if (used.has(next) || block.segs.includes(next)) continue;
        if (next.y0 - last.y1 > 1.1 * bodySize) break;
        if (Math.abs(next.base - last.base) < 0.35 * bodySize) {
          if (last !== seg && next.x0 > block.x0 && next.x1 < Math.max(block.x1, width - 0.05 * width) && next.words.some(free) && !startsProblem(next)) {
            block.segs.push(next); used.add(next); Object.assign(block, union(block, next));
          }
          continue;
        }
        if (next.y0 < last.y1 - 0.3 * bodySize) continue;
        if (Math.abs(next.x0 - seg.x0) > 2.5 * bodySize) continue;
        if (startsProblem(next)) break;
        if (!next.words.some(free)) break;
        block.segs.push(next); used.add(next);
        Object.assign(block, union(block, next));
        last = next;
      }
      block.text = block.segs.map(s => s.text).join(' ');
      // Readable text up to the first math-font word (math fonts extract as gibberish).
      const plain = [];
      for (const w of block.segs.flatMap(s => s.words)) { if (w.math) { plain.push('…'); break; } plain.push(w.text); }
      block.label = plain.join(' ');
      block.range = directionRange(block.text);
      block.math = block.segs.some(s => s.words.some(w => w.math));
      block.conf = Math.min(...block.segs.flatMap(s => s.words.map(w => w.conf ?? 100)));
      directions.push(block);
      used.add(seg);
    } else if (!anchorLed && seg.size >= 1.18 * bodySize && seg.text.length < 80 && /[A-Za-z]{3}/.test(seg.text) && !seg.words.some(w => w.math)) {
      headings.push({ ...union(null, seg), text: seg.text });
    }
  }
  const inDirections = w => directions.some(d => d.segs.some(s => s.words.includes(w)));

  // Problem-number anchors.
  const candidates = potential.filter(c => (!c.bare || bareWords.has(c.word)) && !inDirections(c.word));
  // An OCR gap inside an equation (for example a missed '=' before '0.') does
  // not establish a new exercise. An ordinary-weight inline token also needs an
  // aligned exercise label on another row, or a preceding exercise on the same row.
  const hasRowLabel = c => !c.inline || (c.bare && bareWords.has(c.word)) || (c.rowNumber !== null && c.number > +c.rowNumber);
  const supported = new Set(candidates.filter(c => hasRowLabel(c) || candidates.some(o => o !== c && o.number !== c.number &&
    Math.abs(o.x0 - c.x0) < 0.6 * bodySize && Math.abs(o.base - c.base) > 0.6 * bodySize &&
    hasRowLabel(o))));
  for (let i = candidates.length - 1; i >= 0; i--) if (!supported.has(candidates[i])) candidates.splice(i, 1);
  // OCR can lose the text after a number; keep such a number only if it lines up with others.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.followed) continue;
    const aligned = candidates.filter(o => o !== c && Math.abs(o.x0 - c.x0) < 0.6 * bodySize).length;
    if (aligned < 2) candidates.splice(i, 1);
  }
  // If most candidates are bold, the non-bold ones are list items inside problems.
  const boldShare = candidates.filter(c => c.bold).length / (candidates.length || 1);
  let anchors = boldShare > 0.6 ? candidates.filter(c => c.bold || c.bare || c.word.corroboratedLabel) : candidates;
  // A textbook can restart its numbering after a short review on the same page.
  // Keep that distinction for selection across pages and prefer the main section
  // when the same number appears twice on this page.
  const sections = segs.filter(s => s.size >= 1.18 * bodySize).flatMap(h => /^(?:Quick\s+)?Review\b/i.test(h.text)
    ? [{ ...h, review: true }]
    : /^(?:(?:Section|Chapter)\b.*\b)?Exercises\b/i.test(h.text) ? [{ ...h, review: false }] : []);
  for (const a of anchors) a.review = sections.filter(s => s.y1 <= a.y0).sort((p, q) => q.y1 - p.y1)[0]?.review ?? false;
  // Keep one anchor per number: prefer bold, then a left edge shared with other anchors.
  const byNumber = new Map();
  for (const a of anchors) {
    const prev = byNumber.get(a.number);
    if (!prev) { byNumber.set(a.number, a); continue; }
    const score = x => (x.review ? -100 : 0) + (x.bold ? 2 : 0) + anchors.filter(o => o !== x && o.number !== x.number && Math.abs(o.x0 - x.x0) < 0.8 * bodySize).reduce((n, o) => n + (Math.abs(o.number - x.number) <= 3 && (o.number - x.number) * (o.base - x.base) > 0 ? 1 : 0.1), 0);
    if (score(a) > score(prev)) byNumber.set(a.number, a);
  }
  anchors = [...byNumber.values()].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  // OCR sometimes glues a number to its problem ("5.5x-9=2x+6"). Fill gaps in the
  // numbering from words that start with the missing number at an anchor column.
  if (ocr && anchors.length >= 3) {
    const have = new Set(anchors.map(a => a.number));
    const columns = [...new Set(anchors.map(a => Math.round(a.x0)))];
    for (const w of words) {
      if (w.ocrSupplement && !w.corroboratedLabel) continue;
      const m = w.text.match(/^(\d{1,3})[.,](?=\S)/);
      if (!m || have.has(+m[1]) || !free(w) || inDirections(w)) continue;
      const n = +m[1];
      if (!have.has(n - 1) && !have.has(n + 1)) continue;
      if (!columns.some(x => Math.abs(x - w.x0) < 0.8 * bodySize)) continue;
      const cut = w.x0 + (w.x1 - w.x0) * (m[0].length / w.text.length);
      const word = { ...w, text: m[0], x1: cut };
      const rest = { ...w, text: w.text.slice(m[0].length), x0: cut };
      words.push(rest);
      anchors.push({ number: n, word, bold: false, followed: true, x0: w.x0, y0: w.y0, x1: cut, y1: w.y1, base: w.base, size: w.size });
      have.add(n);
    }
    anchors.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  }

  const blockers = [...directions.map(d => ({ ...d, kind: 'directions' })), ...headings.map(h => ({ ...h, kind: 'heading' }))];
  const rowTol = 1.2 * bodySize;
  // Skew tolerance applies across columns; compact exercises in the same
  // column can be only one line apart and must still have separate cells.
  const followsRow = (a, b) => b.base > a.base + (Math.abs(b.x0 - a.x0) < 0.9 * bodySize ? 0.6 * bodySize : rowTol);

  // A scanned row can slope by nearly a character height. More importantly, two
  // independent columns seldom start their paragraphs at the same height. Infer
  // repeated column edges before choosing row boundaries; otherwise a label in
  // the next column can both truncate this paragraph and steal its continuation.
  const contentRight = Math.max(...words.map(w => w.x1), width * 0.9);
  const columns = [];
  for (const a of [...anchors].sort((p, q) => p.x0 - q.x0)) {
    let col = columns.find(c => Math.abs(c.x - a.x0) < 0.9 * bodySize);
    if (!col) { col = { x: a.x0, anchors: [] }; columns.push(col); }
    col.anchors.push(a); col.x = median(col.anchors.map(b => b.x0));
  }
  const layoutWords = words.filter(w => free(w) && !inDirections(w) && !headings.some(h => inside(w, h, 1)));
  const crossesColumn = (a, x) => {
    const near = layoutWords.filter(w => w.x0 >= a.x0 - 0.5 * bodySize && w.x0 < x + bodySize &&
      overlapY(w, { y0: a.y0 - 0.4 * bodySize, y1: a.y1 + 0.4 * bodySize }) > 0).sort((p, q) => p.x0 - q.x0);
    if (near.some(w => w.x0 < x - 0.3 * bodySize && w.x1 > x)) return true;
    // A long exercise may span a former inner column. Follow its continuous
    // first line instead of imposing that inner boundary on the long formula.
    let end = a.x1;
    for (const w of near) {
      if (w.x0 - end > 1.4 * bodySize) break;
      end = Math.max(end, w.x1);
    }
    return end > x;
  };
  for (const a of anchors) {
    const sameRow = anchors.filter(b => b !== a && Math.abs(b.base - a.base) < rowTol && b.x0 > a.x1);
    const repeated = columns.filter(c => c.anchors.length >= 2 && c.x > a.x1 + bodySize &&
      (Math.min(...c.anchors.map(b => b.base)) <= a.base + rowTol || figures.some(f => f.x0 >= c.x && f.x1 <= (columns.find(right => right.x > c.x + bodySize)?.x ?? contentRight + 1) && f.y0 <= a.base + rowTol)) &&
      !blockers.some(b => b.kind === 'heading' && b.y0 > Math.max(...c.anchors.map(a => a.y1)) && b.y1 < a.y0 && b.x0 < c.x - bodySize && b.x1 >= c.x) &&
      !crossesColumn(a, c.x));
    a.right = Math.min(contentRight + 1, ...sameRow.map(b => b.x0 - 0.3 * bodySize), ...repeated.map(c => c.x - 0.3 * bodySize));
  }

  // Find the top of the next problem's first line, including an integral,
  // exponent or fraction that rises above the printed exercise number.
  const firstTop = a => {
    const near = layoutWords.filter(w => w.x0 >= a.x0 - 0.5 * bodySize && w.x0 < a.right &&
      w.y0 >= a.y0 - 2 * bodySize && w.y0 <= a.y1);
    const first = near.filter(w => overlapY(w, a.word) > 0 || Math.abs(w.base - a.base) < 0.35 * bodySize);
    let changed = true;
    while (changed) {
      changed = false;
      for (const w of near) if (!first.includes(w) && (w.math || w.size < 0.8 * bodySize || w.y1 - w.y0 > 1.5 * bodySize) && first.some(p => w.y1 >= p.y0 - 0.45 * bodySize && w.y0 < p.y0 && overlapX(w, { x0: p.x0 - 0.5 * bodySize, x1: p.x1 + 0.5 * bodySize }) > 0)) {
        first.push(w); changed = true;
      }
    }
    return Math.min(a.y0, ...first.map(w => w.y0));
  };
  const tops = new Map(anchors.map(a => [a, firstTop(a)]));
  const separator = (a, b) => {
    const end = tops.get(b);
    const intervals = layoutWords.filter(w => w.x0 >= Math.max(a.x0, b.x0) - 0.5 * bodySize && w.x0 < Math.min(a.right, b.right) && w.y1 > a.y1 && w.y0 < end)
      .map(w => [Math.max(a.y1, w.y0), Math.min(end, w.y1)]).sort((p, q) => p[0] - q[0]);
    let inkEnd = a.y1, gap = null;
    for (const [start, stop] of [...intervals, [end, end]]) {
      if (start - inkEnd >= 0.05 * bodySize) gap = [inkEnd, start];
      inkEnd = Math.max(inkEnd, stop);
    }
    const candidate = gap ? (gap[0] + gap[1]) / 2 : end - 0.2 * bodySize;
    const low = Math.max(a.y1, a.base + 0.1 * bodySize), high = Math.min(b.y0, b.base - 0.1 * bodySize);
    return low < high ? Math.max(low, Math.min(high, candidate)) : (a.base + b.base) / 2;
  };

  // Cells stop at the whitespace before the next problem in their horizontal
  // span, not at a neighboring column's label baseline.
  for (const a of anchors) {
    const below = anchors.filter(b => followsRow(a, b) && b.x0 < a.right - 0.5 * bodySize && b.right > a.x0 + 0.5 * bodySize);
    const blocks = blockers.filter(b => b.y0 > a.base && overlapX(b, { x0: a.x0, x1: a.right }) > 0);
    const next = below.sort((p, q) => p.base - q.base)[0];
    a.limit = Math.min(height, next ? separator(a, next) : height, ...blocks.map(b => b.y0));
    a.top = Math.max(0, tops.get(a) - bodySize);
  }
  for (const a of anchors) {
    const above = anchors.filter(b => followsRow(b, a) && b.x0 <= a.x0 + 0.9 * bodySize && b.right > a.x0 + 0.5 * bodySize).sort((p, q) => q.base - p.base)[0];
    if (above) a.top = Math.max(a.top, separator(above, a));
    const blocks = blockers.filter(b => b.y1 <= a.y0 && overlapX(b, { x0: a.x0, x1: a.right }) > 0);
    if (blocks.length) a.top = Math.max(a.top, ...blocks.map(b => b.y1));
  }

  // Figures belong to a problem when they start at or below its first line inside its cell;
  // a figure beside a grid of problems belongs to the group's directions instead.
  for (const f of figures) {
    for (const w of f.words) Object.assign(f, union(f, w));
    // A textbook sometimes places the final left-column exercise's diagram at
    // the top of the right column. Require both uninterrupted exercise numbering
    // and an explicit figure reference before following that reading order.
    const afterFigure = anchors.filter(a => a.x0 <= f.x0 && a.right >= f.x1 && a.y0 > f.y1 &&
      !anchors.some(b => b !== a && Math.abs(b.x0 - a.x0) < bodySize && b.y0 < a.y0)).sort((p, q) => p.y0 - q.y0)[0];
    const wrapped = afterFigure && anchors.find(a => a.number === afterFigure.number - 1 && a.x0 < afterFigure.x0 - 3 * bodySize && a.y0 > afterFigure.y0 &&
      !anchors.some(b => Math.abs(b.x0 - a.x0) < bodySize && b.y0 > a.y0) &&
      /\b(?:in|see|shown)\s+(?:the\s+)?figure\b/i.test(layoutWords.filter(w => w.x0 >= a.x0 && w.x0 < a.right && w.y0 >= a.top && w.y1 <= a.limit).sort((p, q) => p.base - q.base || p.x0 - q.x0).map(w => w.text).join(' ')));
    if (wrapped) { f.owner = wrapped.number; wrapped.figures = [...(wrapped.figures || []), f]; continue; }
    const host = anchors.find(a => f.x0 >= a.x0 - bodySize && f.x1 <= a.right + 2 && f.y0 >= a.base - 0.3 * bodySize && f.y0 < a.limit);
    if (host) { f.owner = host.number; host.figures = [...(host.figures || []), f]; continue; }
    // Problems in rows beside it stop at its left edge.
    for (const a of anchors) if (a.x1 < f.x0 && a.right > f.x0 && a.y0 < f.y1 && a.limit > f.y0) a.right = f.x0 - 0.5 * bodySize;
    const dir = directions.filter(d => d.y1 <= f.y0 + bodySize).sort((p, q) => q.y1 - p.y1)[0];
    const nextBlock = dir && blockers.filter(b => b.y0 > dir.y1 + 1).sort((p, q) => p.y0 - q.y0)[0];
    if (dir && (!nextBlock || f.y0 < nextBlock.y0)) { dir.figures = [...(dir.figures || []), f]; f.owner = 'directions'; continue; }
    // Otherwise: the problem whose rows overlap it most, to its left.
    const left = anchors.filter(a => a.x0 < f.x0).map(a => ({ a, o: Math.min(a.limit, f.y1) - Math.max(a.y0, f.y0) })).filter(x => x.o > 0).sort((p, q) => q.o - p.o)[0];
    if (left) { f.owner = left.a.number; left.a.figures = [...(left.a.figures || []), f]; }
  }
  // Axis titles and short captions often sit just outside the non-text ink.
  // Include them after labels are resolved, so expanding a figure never hides
  // a neighboring exercise number or its opening sentence.
  const anchorSegments = new Set(segs.filter(s => s.words.some(w => anchors.some(a => a.word === w))));
  for (const f of figures) {
    if (typeof f.owner !== 'number') continue;
    const edge = { x0: f.x0 - bodySize, y0: f.y0 - bodySize, x1: f.x1 + bodySize, y1: f.y1 + bodySize };
    for (const w of words) {
      if (!free(w) || inDirections(w) || !centerIn(w, edge) || [...anchorSegments].some(s => s.words.includes(w))) continue;
      figureOf.set(w, f); f.words.push(w); Object.assign(f, union(f, w));
    }
  }

  // Each free word belongs to the nearest anchor above-left of it within that anchor's cell.
  const owned = new Map(anchors.map(a => [a, [a.word]]));
  for (const w of words) {
    if (!free(w) || inDirections(w) || anchors.some(a => a.word === w)) continue;
    if (blockers.some(b => b.kind === 'heading' && inside(w, b, 1))) continue;
    let best = null;
    for (const a of anchors) {
      if (w.x0 < a.x0 - 0.5 * bodySize || w.x0 >= a.right) continue;
      const cy = (w.y0 + w.y1) / 2;
      if (cy < a.top || cy >= a.limit) continue;
      if (!best || a.top > best.top || (a.top === best.top && a.x0 > best.x0)) best = a;
    }
    if (best) owned.get(best).push(w);
  }
  for (const a of anchors) {
    // Stop at a big vertical gap: a footer or stray text far below is not part of the problem.
    const list = owned.get(a).sort((p, q) => p.y0 - q.y0);
    let bottom = a.word.y1;
    const kept = [];
    for (const w of list) {
      let bridged = bottom;
      for (const f of [...(a.figures || [])].sort((p, q) => p.y0 - q.y0)) {
        if (f.y0 <= w.y0 && f.y0 - bridged <= 4 * bodySize && f.y1 > bridged) bridged = f.y1;
      }
      if (w !== a.word && w.y0 - bottom > 2.2 * bodySize && (bridged === bottom || w.y0 - bridged > 4 * bodySize)) break;
      kept.push(w); bottom = Math.max(bottom, w.y1);
    }
    owned.set(a, kept);
    let box = null;
    for (const w of kept) box = union(box, w);
    a.box = box;
    a.words = owned.get(a);
    a.text = a.words.filter(w => w !== a.word).sort((p, q) => p.base - q.base || p.x0 - q.x0).map(w => w.text).join(' ');
  }

  // Directions governing each anchor: a range that names it, else the nearest above.
  for (const a of anchors) {
    const named = directions.find(d => d.range && a.number >= d.range.from && a.number <= d.range.to);
    const above = directions.filter(d => d.y1 <= a.y0 + 1 && !d.range).sort((p, q) => q.y1 - p.y1)[0];
    const head = headings.filter(h => h.y1 <= a.y0).sort((p, q) => q.y1 - p.y1)[0];
    a.directions = named || (above && (!head || head.y1 < above.y0) ? above : null);
  }
  return { anchors, directions, headings, figures, bodySize, segments: segs };
}

/** Associate strokes with observed labels/text, never the unused space in a cell. */
export function anchorsForMark(mark, anchors, bodySize = 10) {
  const overlap = (a, b) => Math.max(0, overlapX(a, b)) * Math.max(0, overlapY(a, b));
  const area = r => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  const coverage = r => (mark.spans || [mark]).reduce((sum, span) => sum + overlap(span, r), 0) / area(r);
  const labels = anchors.filter(a => mark.enclosed?.includes(a.number) || coverage(a) >= 0.2 ||
    // Bounds-only callers lack the raster footprint (e.g. PDF annotation rects).
    (!mark.spans && inside(a, mark)));
  // A connected swipe can cover one number and another question's prose. When
  // labels are present, require substantial prose coverage to avoid including
  // a neighbor merely grazed by the edge of a circle around the first label.
  const content = anchors.filter(a => {
    const words = (a.words || []).filter(w => w !== a.word);
    if (!labels.length) return words.some(w => coverage(w) >= 0.25);
    const total = words.reduce((sum, w) => sum + area(w), 0);
    const covered = words.reduce((sum, w) => sum + coverage(w) * area(w), 0);
    const fullWidth = words.filter(w => coverage(w) >= 0.6).reduce((sum, w) => sum + w.x1 - w.x0, 0);
    return total > 0 && (covered / total >= 0.5 || fullWidth >= 2 * bodySize);
  });
  const figures = anchors.filter(a => (a.figures || []).some(f => coverage(f) >= 0.1));
  const observed = [...new Set([...labels, ...content, ...figures])];
  if (observed.length) return observed;
  // A compact tick immediately left of a label is an intentional margin mark.
  // Distant decoration and ambiguous marks between rows are left unassigned.
  if (mark.y1 - mark.y0 > 2 * bodySize || mark.x1 - mark.x0 > 3 * bodySize) return [];
  const cy = (mark.y0 + mark.y1) / 2;
  const right = anchors.filter(a => mark.x1 <= a.x0 + 0.2 * bodySize && a.x0 - mark.x1 <= 1.6 * bodySize &&
    cy >= a.y0 - 0.25 * bodySize && cy <= a.y1 + 0.25 * bodySize).sort((a, b) =>
    Math.hypot(a.x0 - mark.x1, (a.y0 + a.y1) / 2 - cy) - Math.hypot(b.x0 - mark.x1, (b.y0 + b.y1) / 2 - cy));
  return right.length === 1 ? right : [];
}

/** Compatibility helper for callers which need the first associated label. */
export function anchorForMark(mark, anchors, bodySize = 10) {
  return anchorsForMark(mark, anchors, bodySize)[0] || null;
}
