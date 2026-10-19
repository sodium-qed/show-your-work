import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorksheet, normalizeRect, PAPER, LABEL_HEIGHT, REGION_GAP, GAP } from '../src/layout.js';

const tolerance = 1e-6;
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const crop = (id, width = 200, height = 100, breaks = []) => ({ id, width, height, breaks });
const problem = (id, height = 100, extra = {}) => ({ regions: [crop(id, 200, height)], space: 0, scale: 100, fit: 'flow', ...extra });
const items = layout => layout.pages.flatMap(page => page.items);
const crops = layout => items(layout).filter(item => item.type === 'region');
const totalSpace = (layout, number) => items(layout).filter(item => item.type === 'space' && !item.extra && item.number === number).reduce((sum, item) => sum + item.height, 0);

function assertAlignment(layout, alignment = 'center') {
  const columnWidth = crops(layout).reduce((widest, item) => Math.max(widest, item.width), 0);
  const contentWidth = layout.width - layout.margin * 2;
  for (const item of items(layout)) {
    if (item.type === 'space') {
      close(item.x, layout.margin, 'writing space starts at the printable margin');
      close(item.width, contentWidth, 'writing space retains the full printable width');
    } else {
      const expectedX = layout.margin + (alignment === 'left' ? 0 : (contentWidth - columnWidth) / 2);
      close(item.x, expectedX, 'all labels and crop slices share the worksheet column alignment');
    }
  }
}

function assertLayout(layout, problems, settings = {}) {
  const seenProblems = new Set();
  const segments = new Map();
  for (const [pageIndex, page] of layout.pages.entries()) {
    assert.ok(page.items.length >= 2, `page ${pageIndex} must contain a label and content`);
    assert.equal(page.items[0].type, 'label');
    let previousBottom = layout.top;
    let currentNumber = null;
    for (const [itemIndex, item] of page.items.entries()) {
      for (const key of ['x', 'y', 'height']) assert.ok(Number.isFinite(item[key]), `${key} must be finite`);
      assert.ok(item.height > 0 || (item.type === 'label' && item.text === '' && item.height === 0), 'only an invisible label marker may have zero height');
      assert.ok(item.y >= previousBottom - tolerance, 'items do not overlap');
      assert.ok(item.x >= layout.margin - tolerance, 'left margin is respected');
      assert.ok(item.y >= layout.top - tolerance, 'header clearance is respected');
      assert.ok(item.y + item.height <= layout.bottom + tolerance, 'bottom margin is respected');
      previousBottom = item.y + item.height;
      if (item.type === 'label') {
        const next = page.items[itemIndex + 1];
        assert.ok(next && next.type !== 'label' && next.number === item.number, 'labels must have content on the same page');
        assert.equal(item.continued, seenProblems.has(item.number), 'continuation labels follow the initial label');
        const expectedText = settings.numbering === true ? `${item.number}.${item.continued ? ' (continued)' : ''}` : (item.continued ? 'Continued' : '');
        assert.equal(item.text, expectedText, 'label text follows the requested numbering mode');
        assert.equal(item.height, expectedText ? LABEL_HEIGHT : 0, 'invisible markers reserve no space');
        seenProblems.add(item.number);
        currentNumber = item.number;
      } else {
        assert.equal(item.number, currentNumber, 'content belongs to the preceding label');
        assert.ok(Number.isFinite(item.width) && item.width > 0, 'content has finite positive width');
        assert.ok(item.x + item.width <= layout.width - layout.margin + tolerance, 'right margin is respected');
        if (item.type === 'region') {
          assert.ok(item.sourceTop >= 0 && item.sourceTop < 1);
          assert.ok(item.sourceHeight > 0 && item.sourceTop + item.sourceHeight <= 1 + tolerance);
          if (!segments.has(item.regionId)) segments.set(item.regionId, []);
          segments.get(item.regionId).push(item);
        }
      }
    }
  }
  for (const [index, source] of problems.entries()) {
    if (!source.regions.length) {
      assert.ok(!seenProblems.has(index + 1), 'empty cards do not generate labels');
      continue;
    }
    close(totalSpace(layout, index + 1), Math.max(0, Number(source.space) || 0), 'writing space is exact');
    for (const region of source.regions) {
      const slices = segments.get(region.id);
      assert.ok(slices?.length, `region ${region.id} is present`);
      let sourceEnd = 0;
      let scale = null;
      for (const slice of slices) {
        close(slice.sourceTop, sourceEnd, 'source slices are contiguous');
        sourceEnd += slice.sourceHeight;
        const pieceScale = slice.height / (region.height * slice.sourceHeight);
        close(slice.width / region.width, pieceScale, 'aspect ratio is preserved');
        if (scale !== null) close(pieceScale, scale, 'scale remains consistent across slices');
        scale = pieceScale;
      }
      close(sourceEnd, 1, 'all source content is retained exactly once');
    }
  }
}

test('Letter and A4 retain their dimensions and all header configurations reserve the intended space', () => {
  for (const paper of ['letter', 'a4']) {
    for (const margin of [18, 36, 54, 72]) {
      for (const [title, nameLine, reserve] of [['', false, 0], ['', true, 24], ['Practice', false, 36], ['Practice', true, 50]]) {
        const input = [problem('header')];
        const layout = planWorksheet(input, { paper, margin, title, nameLine });
        assert.deepEqual([layout.width, layout.height], PAPER[paper]);
        close(layout.top, margin + reserve);
        close(layout.bottom, PAPER[paper][1] - margin - 18);
        assertLayout(layout, input);
      }
    }
  }
});

test('problems are centered by default without enlarging crops on either paper size', () => {
  const input = [problem('small', 100, { space: 72 })];
  for (const paper of ['letter', 'a4']) {
    for (const margin of [36, 54, 72]) {
      const settings = { paper, margin };
      const layout = planWorksheet(input, settings);
      const region = crops(layout)[0];
      close(region.x, (layout.width - 200) / 2);
      assert.equal(region.width, 200, 'centering does not stretch the crop to the printable width');
      assert.equal(region.height, 100);
      assert.equal(layout.pages[0].items[0].height, 0);
      close(region.y, layout.top, 'the default unnumbered crop has no invisible label reserve');
      assert.deepEqual(planWorksheet(input, { ...settings, alignment: 'center' }), layout);
      assertAlignment(layout);
      assertLayout(layout, input);
    }
  }
});

test('explicit left alignment preserves the margin for labels and all crop regions', () => {
  const input = [{ regions: [crop('narrow', 120, 80), crop('wide', 360, 100)], space: 144, scale: 100 }];
  for (const paper of ['letter', 'a4']) {
    const layout = planWorksheet(input, { paper, margin: 54, alignment: 'left' });
    assert.ok(items(layout).every(item => item.x === 54));
    assert.deepEqual(crops(layout).map(item => [item.width, item.height]), [[120, 80], [360, 100]]);
    assertAlignment(layout, 'left');
    assertLayout(layout, input);
  }
});

test('all multi-region problems share one centered worksheet column', () => {
  const input = [
    { regions: [crop('first-narrow', 120, 60), crop('first-wide', 320, 80)], space: 72, scale: 100 },
    problem('second', 50, { space: 36 }),
  ];
  const layout = planWorksheet(input);
  const first = crops(layout).filter(item => item.number === 1);
  close(first[0].x, 146);
  close(first[1].x, 146);
  close(crops(layout).find(item => item.number === 2).x, 146);
  assert.deepEqual(first.map(item => [item.width, item.height]), [[120, 60], [320, 80]]);
  assertAlignment(layout);
  assertLayout(layout, input);
});

test('overflow and writing-space continuation pages retain the complete problem block alignment', () => {
  const input = [{ regions: [crop('tall-narrow', 160, 1800), crop('wider-later', 360, 120)], space: 1200, scale: 100, fit: 'flow' }];
  const layout = planWorksheet(input, { title: 'Practice', nameLine: true });
  assert.ok(layout.pages.length > 3);
  assert.ok(layout.pages.some(page => page.items.every(item => item.type !== 'region')), 'includes a writing-space-only continuation');
  assert.ok(items(layout).filter(item => item.type !== 'space').every(item => item.x === 126));
  assertAlignment(layout);
  assertLayout(layout, input);
});

test('the shared column uses final fitted widths across pages while preserving aspect ratios and blank space', () => {
  const input = [problem('unshrunk', 80), { regions: [crop('wide', 1200, 1800), crop('narrow', 200, 900)], space: 216, scale: 100, fit: 'shrink', pageBreak: true }];
  const layout = planWorksheet(input, { paper: 'a4', margin: 54, title: 'Practice', nameLine: true });
  assert.equal(layout.pages.length, 2);
  assert.ok(layout.warnings.some(warning => warning.kind === 'shrink'));
  const finalWidth = Math.max(...crops(layout).map(item => item.width));
  assert.equal(finalWidth, 200, 'the unshrunk crop is wider than the much wider source after fitting');
  assert.ok(crops(layout).filter(item => item.number === 2).every(item => item.width < finalWidth));
  close(crops(layout)[0].x, (layout.width - finalWidth) / 2);
  close(totalSpace(layout, 2), 216);
  assertAlignment(layout);
  assertLayout(layout, input);
});

test('switching alignment changes only label and region x coordinates across mixed layouts', () => {
  const input = [
    problem('small', 80, { space: 36 }),
    { regions: [crop('overflow-one', 200, 1000, [0.5]), crop('overflow-two', 400, 180)], space: 1000, fit: 'flow' },
    { regions: [crop('fitted', 900, 1800), crop('fitted-two', 200, 300)], space: 144, fit: 'shrink', pageBreak: true },
  ];
  const settings = { paper: 'a4', margin: 54, title: 'Practice', nameLine: true };
  const centered = planWorksheet(input, settings);
  const left = planWorksheet(input, { ...settings, alignment: 'left' });
  const withoutContentX = layout => ({ ...layout, pages: layout.pages.map(page => ({ items: page.items.map(item => item.type === 'space' ? item : { ...item, x: null }) })) });
  assert.deepEqual(withoutContentX(centered), withoutContentX(left), 'pagination, dimensions, source slices, vertical positions, warnings, and writing space are unchanged');
  assertAlignment(centered);
  assertAlignment(left, 'left');
  assertLayout(centered, input);
  assertLayout(left, input);
});

test('balanced spacing uses spare page height after every complete problem including the last', () => {
  const input = [problem('one', 40, { space: 20 }), problem('two', 80, { space: 30 }), problem('three', 60, { space: 38 })];
  const layout = planWorksheet(input);
  const compact = planWorksheet(input, { spacing: 'compact' });
  assert.deepEqual(planWorksheet(input, { spacing: 'balanced' }), layout);
  assert.equal(layout.pages.length, compact.pages.length);
  assert.deepEqual(crops(compact).map(item => item.y), [36, 106, 226]);
  assert.deepEqual(crops(layout).map(item => item.y), [36, 244, 502]);
  const extra = items(layout).filter(item => item.extra);
  assert.deepEqual(extra.map(item => [item.number, item.height]), [[1, 138], [2, 138], [3, 138]]);
  assert.equal(extra.at(-1).y + extra.at(-1).height, layout.bottom, 'the last problem also receives additional writing room');
  assert.equal(items(compact).filter(item => item.extra).length, 0);
  for (const [index, p] of input.entries()) {
    close(totalSpace(layout, index + 1), p.space);
    if (index < input.length - 1) close(crops(layout)[index + 1].y - extra[index].y - extra[index].height, GAP);
  }
  assert.deepEqual(crops(layout).map(item => [item.width, item.height]), crops(compact).map(item => [item.width, item.height]));
  assertAlignment(layout);
  assertLayout(layout, input);
});

test('zero requested writing space still permits balanced extra room without changing the minimum', () => {
  const input = [problem('one', 30), problem('two', 70), problem('three', 50)];
  const layout = planWorksheet(input);
  const compact = planWorksheet(input, { spacing: 'compact' });
  const bonus = (702 - (30 + 70 + 50 + 2 * GAP)) / 3;
  assert.equal(items(layout).filter(item => item.extra).length, 3);
  crops(layout).forEach((item, index) => {
    close(item.y - crops(compact)[index].y, index * bonus);
    assert.equal(totalSpace(layout, index + 1), 0);
  });
  close(items(layout).at(-1).y + items(layout).at(-1).height, layout.bottom);
  assertLayout(layout, input);
});

test('single-problem pages gain trailing writing room without moving their content', () => {
  const input = [problem('one', 100, { space: 72 })];
  for (const numbering of [false, true]) {
    const settings = { paper: 'a4', margin: 54, title: 'Practice', nameLine: true, numbering };
    const compact = planWorksheet(input, { ...settings, spacing: 'compact' });
    const layout = planWorksheet(input, settings);
    assert.deepEqual(items(layout).filter(item => !item.extra), items(compact));
    const extra = items(layout).filter(item => item.extra);
    assert.equal(extra.length, 1);
    close(extra[0].y + extra[0].height, layout.bottom);
    close(extra[0].height, compact.bottom - items(compact).at(-1).y - items(compact).at(-1).height);
    close(totalSpace(layout, 1), 72);
    assertLayout(layout, input, settings);
  }
});

test('balancing keeps all regions and label offsets within a problem together', () => {
  const input = [{ regions: [crop('instructions', 300, 30), crop('question', 200, 40)], space: 36 }, problem('next', 50)];
  const settings = { numbering: true };
  const compact = planWorksheet(input, { ...settings, spacing: 'compact' });
  const layout = planWorksheet(input, settings);
  const regions = crops(layout);
  close(regions[1].y - regions[0].y - regions[0].height, REGION_GAP);
  assert.deepEqual(regions.slice(0, 2), crops(compact).slice(0, 2), 'instructions and question remain adjacent and start at the original top');
  assert.deepEqual(items(layout).filter(item => item.extra).map(item => item.number), [1, 2]);
  for (const label of items(layout).filter(item => item.type === 'label')) {
    close(regions.find(item => item.number === label.number).y - label.y, LABEL_HEIGHT);
  }
  assertLayout(layout, input, settings);
});

test('every page touched by a multi-page problem stays compact including mixed and writing-space continuations', () => {
  for (const continuing of [problem('continuing-crop', 1200), problem('continuing-space', 100, { space: 1100 })]) {
    const input = [problem('before', 80), continuing, problem('after', 40, { space: 20 }), problem('new-page', 80, { space: 20, pageBreak: true })];
    const compact = planWorksheet(input, { spacing: 'compact' });
    const layout = planWorksheet(input);
    assert.equal(layout.pages.length, 3);
    assert.deepEqual(layout.pages.slice(0, 2), compact.pages.slice(0, 2), 'neither the first nor continuation page redistributes space');
    assert.equal(layout.pages[2].items.filter(item => item.extra).length, 1, 'an independent whole-problem page can still be balanced');
    assert.deepEqual(layout.pages[2].items.filter(item => !item.extra), compact.pages[2].items);
    assertLayout(layout, input);
  }
});

test('full pages and sub-epsilon spare height do not produce negative or tiny bonus items', () => {
  const geometry = planWorksheet([]);
  const capacity = geometry.bottom - geometry.top;
  for (const difference of [-5e-8, 0, 5e-8]) {
    const input = [problem('full', capacity + difference)];
    const layout = planWorksheet(input);
    assert.equal(layout.pages.length, 1);
    assert.equal(items(layout).filter(item => item.extra).length, 0);
    assertLayout(layout, input);
  }
  const input = [problem('one', 100), problem('two', 100), problem('three', capacity - 200 - 2 * GAP - 2e-7)];
  assert.equal(items(planWorksheet(input)).filter(item => item.extra).length, 0, 'an imperceptible per-problem bonus is omitted');
});

test('numbering is off unless explicitly true and reserves no hidden first-label space', () => {
  const input = [problem('textbook-seven', 100, { space: 72 }), problem('textbook-nine', 80, { space: 36 })];
  const defaultLayout = planWorksheet(input, { spacing: 'compact' });
  for (const numbering of [false, undefined, null, 0, 'true']) {
    const layout = planWorksheet(input, { numbering, spacing: 'compact' });
    assert.deepEqual(layout, defaultLayout);
    assert.ok(items(layout).filter(item => item.type === 'label').every(item => item.text === '' && item.height === 0));
    close(crops(layout)[0].y, layout.top);
    close(crops(layout)[1].y, layout.top + 100 + 72 + GAP);
    assertLayout(layout, input);
  }
  const numbered = planWorksheet(input, { numbering: true, spacing: 'compact' });
  assert.deepEqual(items(numbered).filter(item => item.type === 'label').map(item => item.text), ['1.', '2.']);
  close(crops(numbered)[0].y, numbered.top + LABEL_HEIGHT);
  close(crops(numbered)[1].y - crops(defaultLayout)[1].y, LABEL_HEIGHT * 2);
  assert.deepEqual(crops(numbered).map(item => [item.width, item.height]), crops(defaultLayout).map(item => [item.width, item.height]));
  assertLayout(numbered, input, { numbering: true });
});

test('first-page and continuation label budgets retain full source coverage at an exact two-page boundary', () => {
  for (const numbering of [false, true]) {
    const settings = { numbering, paper: 'a4', margin: 54, title: 'Practice', nameLine: true };
    const geometry = planWorksheet([], settings);
    const capacity = geometry.bottom - geometry.top;
    const firstCapacity = capacity - (numbering ? LABEL_HEIGHT : 0);
    const continuationCapacity = capacity - LABEL_HEIGHT;
    const input = [problem('two-exact-pages', firstCapacity + continuationCapacity)];
    const layout = planWorksheet(input, settings);
    assert.equal(layout.pages.length, 2);
    const labels = items(layout).filter(item => item.type === 'label');
    assert.deepEqual(labels.map(item => item.text), numbering ? ['1.', '1. (continued)'] : ['', 'Continued']);
    close(crops(layout)[0].height, firstCapacity);
    close(crops(layout)[1].height, continuationCapacity);
    close(crops(layout)[0].y, layout.top + (numbering ? LABEL_HEIGHT : 0));
    close(crops(layout)[1].y, layout.top + LABEL_HEIGHT);
    assertAlignment(layout);
    assertLayout(layout, input, settings);
  }
});

test('removing initial numbering can fit content on one page without changing its dimensions', () => {
  const geometry = planWorksheet([]);
  const capacity = geometry.bottom - geometry.top;
  const input = [problem('nearly-full-page', capacity - LABEL_HEIGHT / 2)];
  const unnumbered = planWorksheet(input);
  const numbered = planWorksheet(input, { numbering: true });
  assert.equal(unnumbered.pages.length, 1);
  assert.equal(numbered.pages.length, 2);
  assert.equal(crops(unnumbered)[0].sourceHeight, 1);
  close(crops(unnumbered)[0].height, capacity - LABEL_HEIGHT / 2);
  close(crops(numbered).reduce((sum, item) => sum + item.height, 0), crops(unnumbered)[0].height);
  assertLayout(unnumbered, input);
  assertLayout(numbered, input, { numbering: true });
});

test('a fresh unnumbered problem uses the initial page capacity after preceding content', () => {
  const geometry = planWorksheet([]);
  const capacity = geometry.bottom - geometry.top;
  const input = [problem('preceding', 50), problem('nearly-full', capacity - 9)];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(crops(layout).map(item => item.sourceHeight), [1, 1]);
  assert.deepEqual(layout.pages.map(page => page.items[0].text), ['', '']);
  close(crops(layout)[1].y, layout.top);
  assertLayout(layout, input);
});

test('later regions respect the smaller continuation capacity without wasting initial-page room', () => {
  const geometry = planWorksheet([]);
  const capacity = geometry.bottom - geometry.top;
  for (const firstHeight of [1, 100]) {
    const input = [{ regions: [crop('first', 200, firstHeight), crop('near-page', 200, capacity - 9)], space: 0 }];
    const layout = planWorksheet(input);
    assert.equal(layout.pages.length, firstHeight === 1 ? 1 : 2);
    if (firstHeight === 1) assert.deepEqual(crops(layout).map(item => item.sourceHeight), [1, 1]);
    else assert.equal(layout.pages[1].items[0].text, 'Continued');
    assertLayout(layout, input);
  }
});

test('one-page fit can use reclaimed label height while preserving writing space and proportional scale', () => {
  const geometry = planWorksheet([]);
  const capacity = geometry.bottom - geometry.top;
  const input = [problem('tight-fit', 1000, { space: capacity - 9, fit: 'shrink' })];
  const unnumbered = planWorksheet(input);
  const numbered = planWorksheet(input, { numbering: true });
  assert.equal(unnumbered.pages.length, 1);
  assert.ok(unnumbered.warnings.some(warning => warning.kind === 'shrink'));
  close(crops(unnumbered)[0].height, 9);
  assert.equal(numbered.pages.length, 3);
  assert.ok(numbered.warnings.some(warning => warning.kind === 'overflow'));
  assert.ok(!numbered.warnings.some(warning => warning.kind === 'shrink'));
  close(totalSpace(unnumbered, 1), capacity - 9);
  close(totalSpace(numbered, 1), capacity - 9);
  assertLayout(unnumbered, input);
  assertLayout(numbered, input, { numbering: true });
});

test('empty input and unfinished empty cards produce no pages or phantom labels', () => {
  assert.deepEqual(planWorksheet().pages, []);
  assert.deepEqual(planWorksheet([]).warnings, []);
  assert.deepEqual(planWorksheet([{ regions: [], space: 100, pageBreak: true }]).pages, []);
  const input = [{ regions: [], pageBreak: true }, problem('one'), { regions: [], pageBreak: true }];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 1);
  assert.equal(layout.pages[0].items[0].number, 2);
  assertLayout(layout, input);
});

test('ordinary problems move as a unit, and a forced first-page break never creates an empty page', () => {
  const input = [problem('one', 450, { pageBreak: true }), problem('two', 160, { space: 100 }), problem('three', 20, { pageBreak: true })];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 3);
  assert.deepEqual(layout.pages.map(page => page.items[0].number), [1, 2, 3]);
  assert.ok(items(layout).filter(item => item.type === 'label').every(item => !item.continued));
  assertLayout(layout, input);
});

test('an overflowing multi-region problem does not leave its first label behind', () => {
  const input = [problem('previous', 450), { regions: [crop('first', 200, 600), crop('second', 200, 100)], space: 50 }];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 3);
  assert.deepEqual(layout.pages.map(page => page.items.filter(item => item.type === 'label').map(item => [item.number, item.continued])), [[[1, false]], [[2, false]], [[2, true]]]);
  assertLayout(layout, input);
});

test('multiple regions keep one problem number, gap only on the same page, and retain whole crops when possible', () => {
  const input = [{ regions: [crop('one', 200, 400), crop('two', 200, 200), crop('three', 200, 200)], space: 0 }];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(crops(layout).map(item => item.sourceHeight), [1, 1, 1]);
  const first = crops(layout);
  close(first[1].y - first[0].y - first[0].height, REGION_GAP);
  close(first[2].y, layout.top + LABEL_HEIGHT);
  assertLayout(layout, input);
});

test('oversized crops prefer the latest usable whitespace cut regardless of order, duplicates, or invalid cuts', () => {
  const input = [{ regions: [crop('tall', 200, 1000, [0.67, 0.1, 0.62, 0.67, -0.2, NaN, Infinity, 1.1, 0, 1])], space: 0 }];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 2);
  close(crops(layout)[0].sourceHeight, 0.67);
  close(crops(layout)[1].sourceTop, 0.67);
  assertLayout(layout, input);
});

test('oversized crops without whitespace still preserve every source fraction in order', () => {
  const input = [problem('tall', 2000)];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 3);
  close(crops(layout).reduce((sum, item) => sum + item.height, 0), 2000);
  assert.equal(layout.warnings.filter(warning => warning.kind === 'overflow').length, 1);
  assertLayout(layout, input);
});

test('whitespace near the crop top does not waste a page on a tiny fragment', () => {
  const input = [{ regions: [crop('tall', 200, 1500, [0.001])], space: 0 }];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 3);
  close(crops(layout)[0].height, layout.bottom - layout.top);
  assert.ok(crops(layout).every(item => item.height >= 100));
  assertLayout(layout, input);
});

test('both numbering modes preserve writing-space totals including fractional points and requests above ten inches', () => {
  for (const numbering of [false, true]) {
    for (const space of [0, 0.001, 0.125, 36, 720, 1400.75]) {
      const input = [problem('space', 100, { space })];
      const layout = planWorksheet(input, { numbering });
      close(totalSpace(layout, 1), space);
      assertLayout(layout, input, { numbering });
    }
  }
});

test('fit-to-one-page scales all regions together while preserving exact writing space', () => {
  const input = [problem('before', 50), { regions: [crop('one', 200, 1000), crop('two', 400, 900)], space: 288, scale: 100, fit: 'shrink' }];
  const layout = planWorksheet(input, { title: 'Practice', nameLine: true, paper: 'a4', margin: 54 });
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(layout.pages[1].items.filter(item => item.type === 'label').map(item => item.number), [2]);
  assert.equal(layout.warnings.filter(warning => warning.kind === 'shrink').length, 1);
  assert.equal(layout.warnings.filter(warning => warning.kind === 'overflow').length, 0);
  close(totalSpace(layout, 2), 288);
  const fitted = crops(layout).filter(item => item.number === 2);
  close(fitted[0].width / 200, fitted[1].width / 400);
  assertLayout(layout, input);
});

test('impossible one-page writing space flows with an accurate warning and no space reduction', () => {
  const input = [problem('space', 100, { space: 720, fit: 'shrink' })];
  const layout = planWorksheet(input);
  assert.equal(layout.pages.length, 2);
  assert.ok(layout.warnings.some(warning => warning.kind === 'overflow' && /preserving.*writing space/.test(warning.message)));
  assert.ok(!layout.warnings.some(warning => warning.kind === 'shrink'));
  close(totalSpace(layout, 1), 720);
  assertLayout(layout, input);
});

test('exact page-boundary arithmetic does not generate a final sliver page', () => {
  for (const paper of ['letter', 'a4']) {
    for (const margin of [36, 54, 72]) {
      for (const numbering of [false, true]) {
        for (const space of [0, 0.1, 72.3, 200.7]) {
          const settings = { paper, margin, title: 'Practice', nameLine: true, numbering };
          const geometry = planWorksheet([], settings);
          const height = geometry.bottom - geometry.top - (numbering ? LABEL_HEIGHT : 0) - space;
          const input = [problem('exact', height, { space })];
          const layout = planWorksheet(input, settings);
          assert.equal(layout.pages.length, 1, `${paper}/${margin}/${numbering}/${space}`);
          close(items(layout).at(-1).y + items(layout).at(-1).height, layout.bottom);
          assertLayout(layout, input, settings);
        }
      }
    }
  }
});

test('normal scale is bounded by paper width and warnings are not repeated per crop', () => {
  const input = [{ regions: [crop('wide', 2000, 100), crop('wide-again', 2000, 100)], scale: 200, space: 0 }];
  const layout = planWorksheet(input);
  close(crops(layout)[0].width, layout.width - 2 * layout.margin);
  assert.equal(layout.warnings.filter(warning => warning.kind === 'small').length, 1);
  assertLayout(layout, input);
});

test('sub-point crops and fitted writing spaces are retained without numerical continuation pages', () => {
  for (const value of [1e-12, 1e-9, 1e-7, 0.001]) {
    const tiny = [problem('tiny', value)];
    const tinyLayout = planWorksheet(tiny);
    assert.equal(tinyLayout.pages.length, 1);
    assert.equal(crops(tinyLayout).length, 1);
    assert.equal(crops(tinyLayout)[0].height, value);
    const fitted = [problem('fitted', 2000, { fit: 'shrink', space: value })];
    const fittedLayout = planWorksheet(fitted);
    assert.equal(fittedLayout.pages.length, 1);
    assert.equal(totalSpace(fittedLayout, 1), value);
    assertLayout(tinyLayout, tiny);
    assertLayout(fittedLayout, fitted);
  }
});

test('problem gaps are applied between content blocks without introducing empty trailing pages', () => {
  const input = [problem('one', 50), problem('two', 70)];
  const layout = planWorksheet(input, { spacing: 'compact' });
  const all = items(layout);
  close(all[2].y - all[1].y - all[1].height, GAP);
  assert.equal(layout.pages.length, 1);
  assertLayout(layout, input);
});

test('invalid dimensions are rejected and excessive pagination is bounded', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => planWorksheet([{ regions: [crop('bad', value, 100)] }]), /Invalid region/);
    assert.throws(() => planWorksheet([{ regions: [crop('bad', 100, value)] }]), /Invalid region/);
  }
  assert.throws(() => planWorksheet(null), /array/);
  assert.throws(() => planWorksheet([{}]), /region list/);
  assert.throws(() => planWorksheet([problem('huge', 1e9)]), /500 pages/);
  assert.throws(() => planWorksheet([problem('huge-space', 20, { space: 1e9 })]), /500 pages/);
});

test('settings and rectangle normalization return finite bounded geometry', () => {
  assert.equal(planWorksheet([], { paper: 'other', margin: NaN }).margin, 36);
  assert.equal(planWorksheet([], { margin: 0 }).margin, 18);
  assert.equal(planWorksheet([], { margin: 1000 }).margin, 72);
  assert.equal(planWorksheet([], { margin: Infinity }).margin, 36);
  for (const rect of [undefined, null, {}, { x: Infinity, y: NaN, w: -1, h: Infinity }, { x: 2, y: -2, w: 0.8, h: 5 }]) {
    const normalized = normalizeRect(rect);
    assert.ok(Object.values(normalized).every(Number.isFinite));
    assert.ok(normalized.x >= 0 && normalized.y >= 0);
    assert.ok(normalized.w >= 0.005 && normalized.h >= 0.005);
    assert.ok(normalized.x + normalized.w <= 1 && normalized.y + normalized.h <= 1);
  }
});

test('seeded layouts preserve geometry, source coverage, labels, and requested space across 400 mixed cases', () => {
  let seed = 0x4d415448;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let iteration = 0; iteration < 400; iteration++) {
    const input = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, pi) => ({
      regions: Array.from({ length: 1 + Math.floor(random() * 4) }, (_, ri) => crop(`${iteration}-${pi}-${ri}`, 20 + random() * 1600, 1 + random() * 2000, Array.from({ length: 10 }, () => random()))),
      scale: 25 + random() * 175,
      space: random() < 0.25 ? 0 : random() * 1600,
      fit: random() < 0.5 ? 'shrink' : 'flow',
      pageBreak: random() < 0.15,
    }));
    const before = structuredClone(input);
    const settings = { paper: random() < 0.5 ? 'letter' : 'a4', margin: 18 + random() * 54, title: random() < 0.5 ? 'Practice' : '', nameLine: random() < 0.5, alignment: random() < 0.5 ? 'center' : 'left', numbering: random() < 0.5, spacing: random() < 0.5 ? 'balanced' : 'compact' };
    const layout = planWorksheet(input, settings);
    assertLayout(layout, input, settings);
    assertAlignment(layout, settings.alignment);
    assert.deepEqual(input, before, 'planning does not mutate input data');
    const other = planWorksheet(input, { ...settings, spacing: settings.spacing === 'compact' ? 'balanced' : 'compact' });
    assert.equal(layout.pages.length, other.pages.length, 'spacing mode never changes page count');
    const withoutSpacing = result => ({ ...result, pages: result.pages.map(page => ({ items: page.items.filter(item => !item.extra).map(item => ({ ...item, y: 0 })) })) });
    assert.deepEqual(withoutSpacing(layout), withoutSpacing(other), 'spacing mode preserves original items, dimensions, source slices, page assignments, and warnings');
    assertLayout(other, input, settings);
    for (const [index, p] of input.entries()) {
      if (p.fit === 'shrink' && p.space < layout.bottom - layout.top - (settings.numbering ? LABEL_HEIGHT : 0)) {
        assert.equal(layout.pages.filter(page => page.items.some(item => item.number === index + 1)).length, 1, 'possible one-page fits use exactly one page');
      }
    }
  }
});
