/** Layout coordinates are PDF points (72 points = 1 inch), from top-left. */
export const PAPER = { letter: [612, 792], a4: [595.276, 841.89] };
export const GAP = 10;
export const LABEL_HEIGHT = 18;
export const REGION_GAP = 7;

// This tolerance only absorbs arithmetic noise; it never rounds requested space.
const EPSILON = 1e-7;
const MIN_FRAGMENT = 24;
const MAX_PAGES = 500;
const finite = (value, fallback) => value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function planWorksheet(problems = [], settings = {}) {
  if (!Array.isArray(problems)) throw new TypeError('Problems must be an array.');
  settings ||= {};
  const [width, height] = PAPER[settings.paper] || PAPER.letter;
  const margin = clamp(finite(settings.margin, 36), 18, 72);
  const contentWidth = width - margin * 2;
  const alignment = settings.alignment === 'left' ? 'left' : 'center';
  const numbering = settings.numbering === true;
  const initialLabelHeight = numbering ? LABEL_HEIGHT : 0;
  // Keep these reserves in sync with the PDF engine's header and footer.
  const top = margin + (settings.title ? (settings.nameLine ? 50 : 36) : (settings.nameLine ? 24 : 0));
  const bottom = height - margin - 18;
  const capacity = bottom - top;
  const initialRegionCapacity = capacity - initialLabelHeight;
  const pages = [];
  const warnings = [];
  let page = null;
  let y = top;

  const fresh = () => {
    if (pages.length >= MAX_PAGES) throw new Error('This worksheet would exceed 500 pages. Reduce the writing space or the size of oversized crops.');
    page = { items: [] };
    pages.push(page);
    y = top;
  };

  for (const [index, problem] of problems.entries()) {
    const number = index + 1;
    if (!problem || !Array.isArray(problem.regions)) throw new Error(`Problem ${number} has no region list.`);
    // An unfinished card must not produce a numbered but otherwise empty page.
    if (!problem.regions.length) continue;
    const scale = clamp(finite(problem.scale, 100) / 100, 0.25, 2);
    const regions = problem.regions.map(region => {
      const rw = Number(region?.width), rh = Number(region?.height);
      if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) throw new Error(`Invalid region in problem ${number}.`);
      const drawScale = Math.min(contentWidth / rw, scale);
      const drawWidth = rw * drawScale, drawHeight = rh * drawScale;
      if (!Number.isFinite(drawHeight) || drawWidth <= 0 || drawHeight <= 0) throw new Error(`Invalid region dimensions in problem ${number}.`);
      const breaks = Array.isArray(region.breaks)
        ? [...new Set(region.breaks.map(Number).filter(cut => Number.isFinite(cut) && cut > 0 && cut < 1))].sort((a, b) => a - b)
        : [];
      return { ...region, drawWidth, drawHeight, scale: drawScale, breaks };
    });
    const space = Math.max(0, finite(problem.space, 0));
    const contentHeight = regions.reduce((sum, region) => sum + region.drawHeight, 0) + (regions.length - 1) * REGION_GAP;
    if (!Number.isFinite(contentHeight + space)) throw new Error(`Problem ${number} is too large to lay out.`);
    let fit = 1;
    const requestedTotal = initialLabelHeight + contentHeight + space;
    const canShrink = space < initialRegionCapacity;
    if (problem.fit === 'shrink' && requestedTotal > capacity + EPSILON && canShrink) {
      // Shrink content and its internal gaps together, preserving writing space.
      // The tiny guard prevents a rounding remainder from creating another page.
      fit = (initialRegionCapacity - space) / contentHeight * (1 - Number.EPSILON * 8);
      warnings.push({ problem: number, kind: 'shrink', message: `Problem ${number} is reduced to fit one page. Check readability in the preview.` });
    }
    if (regions.some(region => region.scale * fit < 0.7)) {
      warnings.push({ problem: number, kind: 'small', message: `Problem ${number} contains a crop below 70% of its original print size.` });
    }
    const total = initialLabelHeight + contentHeight * fit + space;
    if (!page) fresh();
    if (problem.pageBreak && page.items.length) fresh();
    if (total <= capacity + EPSILON && total > bottom - y + EPSILON && page.items.length) fresh();

    let labeledPage = null;
    let firstPage = -1;
    const nextLabelHeight = () => firstPage >= 0 ? LABEL_HEIGHT : initialLabelHeight;
    const available = () => bottom - y - (labeledPage === page ? 0 : nextLabelHeight());
    const addLabel = () => {
      if (labeledPage === page) return;
      const continued = firstPage >= 0;
      const labelHeight = nextLabelHeight();
      const text = numbering ? `${number}.${continued ? ' (continued)' : ''}` : (continued ? 'Continued' : '');
      // Keep a zero-height marker for an unnumbered problem's first page so
      // renderers can identify its content without reserving invisible space.
      page.items.push({ type: 'label', number, continued, text, x: margin, y, height: labelHeight });
      y += labelHeight;
      labeledPage = page;
      if (firstPage < 0) firstPage = pages.length - 1;
    };

    for (const [ri, region] of regions.entries()) {
      const dw = region.drawWidth * fit, dh = region.drawHeight * fit;
      if (!(dw > 0 && dh > 0)) throw new Error(`Problem ${number} cannot be scaled safely. Reduce its writing space.`);
      let gap = ri && labeledPage === page ? REGION_GAP * fit : 0;
      // Decide where content belongs before inserting its label or leading gap.
      // Regions that fit a new page remain intact, even in a larger problem.
      const keepTogether = dh <= capacity - nextLabelHeight() + EPSILON;
      if ((keepTogether && dh > available() - gap + EPSILON) ||
          (!keepTogether && available() - gap < MIN_FRAGMENT - EPSILON)) {
        fresh();
        gap = 0;
      }
      addLabel();
      y += gap;

      let sourceTop = 0;
      while (sourceTop < 1) {
        const room = bottom - y;
        const remainingHeight = dh * (1 - sourceTop);
        // A final fraction always ends at exactly 1, avoiding lost source rows
        // and numerical slivers that would otherwise make a phantom page.
        let sourceEnd = remainingHeight <= room + EPSILON ? 1 : sourceTop + room / dh;
        if (sourceEnd < 1) {
          // Use the latest useful whitespace cut, irrespective of input order.
          // A cut near the crop's top would waste most of a page on a sliver.
          const minimumPiece = Math.max(0.5, room * 0.55);
          const cut = region.breaks.findLast(value => value > sourceTop && (value - sourceTop) * dh >= minimumPiece && value <= sourceEnd);
          if (cut !== undefined) sourceEnd = cut;
        }
        if (!(sourceEnd > sourceTop)) throw new Error(`Problem ${number} is too large to paginate safely.`);
        const sourceHeight = sourceEnd - sourceTop;
        const piece = dh * sourceHeight;
        page.items.push({ type: 'region', number, regionId: region.id, x: margin, y, width: dw, height: piece, sourceTop, sourceHeight });
        y += piece;
        sourceTop = sourceEnd;
        if (sourceTop < 1) { fresh(); addLabel(); }
      }
    }

    // Blank space is a separate physical length, never part of crop scaling.
    let remaining = space;
    while (remaining > 0) {
      if (available() <= EPSILON && remaining > available() + EPSILON) fresh();
      addLabel();
      const room = bottom - y;
      const piece = remaining <= room + EPSILON ? remaining : room;
      page.items.push({ type: 'space', number, x: margin, y, width: contentWidth, height: piece });
      y += piece;
      remaining = piece === remaining ? 0 : remaining - piece;
    }
    if (pages.length - 1 > firstPage) {
      const message = problem.fit === 'shrink' && !canShrink
        ? `Problem ${number} cannot fit on one page while preserving its requested writing space, so it continues onto another page.`
        : `Problem ${number} continues onto another page. Reduce the scale, split a crop, or use Fit to one page.`;
      warnings.push({ problem: number, kind: 'overflow', message });
    }
    y = Math.min(bottom, y + GAP);
  }
  // One shared worksheet column keeps differently sized textbook crops on the
  // same left edge. Final rendered widths include every problem's fit factor;
  // changing alignment only changes x, never crop size or pagination.
  if (alignment === 'center') {
    let columnWidth = 0;
    for (const entry of pages) for (const item of entry.items) {
      if (item.type === 'region') columnWidth = Math.max(columnWidth, item.width);
    }
    const columnX = margin + (contentWidth - columnWidth) / 2;
    for (const entry of pages) for (const item of entry.items) {
      if (item.type === 'region' || item.type === 'label') item.x = columnX;
    }
  }
  return { width, height, margin, top, bottom, pages, warnings };
}

export function normalizeRect(rect = {}) {
  rect ||= {};
  const x = clamp(finite(rect.x, 0), 0, 0.995);
  const y = clamp(finite(rect.y, 0), 0, 0.995);
  return { x, y, w: clamp(finite(rect.w, 0.005), 0.005, 1 - x), h: clamp(finite(rect.h, 0.005), 0.005, 1 - y) };
}
