// Turn a PDF.js page's text layer into positioned words (page points, top-left origin).

const BOLD = /bold|black|heavy|semibold|demi/i;
const ITALIC = /italic|oblique|obl\b|-it\b|slanted/i;
const MATH = /math|symbol|cmsy|cmmi|cmex|cmr\d|msbm|msam|mt.?extra|euclid|pilt|stix|cambria.?math/i;

let measureCtx;
function measure(text, italic) {
  if (measureCtx === undefined) {
    try { measureCtx = globalThis.OffscreenCanvas ? new OffscreenCanvas(8, 8).getContext('2d') : null; } catch { measureCtx = null; }
  }
  if (!measureCtx) return text.length;
  measureCtx.font = `${italic ? 'italic ' : ''}100px "Times New Roman", Times, serif`;
  return measureCtx.measureText(text).width;
}

/** x offset of character `index` inside a run, as a fraction of the run's width. */
export function runFraction(str, index, italic = false) {
  const total = measure(str, italic);
  return total ? measure(str.slice(0, index), italic) / total : index / Math.max(1, str.length);
}

export async function pageWords(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  // Real font names (bold/italic/math) are only known once the operator list has loaded the fonts.
  const fonts = new Map();
  try {
    await page.getOperatorList();
    for (const item of content.items) {
      if (!item.fontName || fonts.has(item.fontName)) continue;
      let name = '';
      try { name = page.commonObjs.get(item.fontName)?.name || ''; } catch {}
      fonts.set(item.fontName, name);
    }
  } catch {}
  const words = [];
  for (const item of content.items) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    if (Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(d)) continue; // rotated text
    const size = Math.hypot(c, d) || item.height || 10;
    const [x, base] = viewport.convertToViewportPoint(e, f);
    const width = item.width;
    const name = fonts.get(item.fontName) || content.styles[item.fontName]?.fontFamily || '';
    const bold = BOLD.test(name), italic = ITALIC.test(name), math = MATH.test(name);
    // Split the run into words at spaces.
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str))) {
      const x0 = x + width * runFraction(str, m.index, italic);
      const x1 = x + width * runFraction(str, m.index + m[0].length, italic);
      words.push({ text: m[0], x0, x1, y0: base - 0.78 * size, y1: base + 0.24 * size, base, size, bold, italic, math, font: name });
    }
  }
  return words;
}
