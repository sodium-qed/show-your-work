import { openFile, preparePage, cropImage, directionsImage, pngBytes, manualProblem } from './document.js';
import { layoutExam } from './layout.js';
import { renderExamPdf } from './render-pdf.js';
import { parseNumbers, formatNumbers } from './numbers.js';
import { interpret, isExplicitNumberList, loadAgent, onAgentStatus } from './agent.js';
import * as PDFLib from '../vendor/pdf-lib.esm.min.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const remember = (k, v) => { try { store?.setItem(`syw.${k}`, JSON.stringify(v)); } catch {} };
const recall = (k, d) => { try { const v = store?.getItem(`syw.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };

const state = {
  sources: [],
  view: { source: 0, page: 0 },
  selected: new Map(),   // id → problem (insertion order irrelevant; sorted when building)
  manualCount: 0,
  mode: 'highlights',
  color: null,
  aids: new Map(),       // group key → { kind, parts }
  settings: { pages: 2, space: 'fill', columns: 0, paper: 'letter', directions: true, ...recall('settings', {}) },
  revision: 0,
  pdf: null,
};

/* ---------- small UI helpers ---------- */
let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message; t.classList.toggle('bad', bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 4200);
}
const allPages = () => state.sources.flatMap(s => s.pages.filter(Boolean));
const allProblems = () => allPages().flatMap(p => p.problems);
const currentPage = () => state.sources[state.view.source]?.pages[state.view.page];

/* ---------- loading files ---------- */
let fileQueue = Promise.resolve();
let readingBatches = 0;
let pageProgress = null;
const visualReads = new Set();

function queueRead(read) {
  readingBatches++;
  // Uploads and visual retries share the reader; number requests wait for both.
  fileQueue = fileQueue.then(read).catch(error => {
    console.error(error);
    toast(`Could not finish reading the pages: ${error.message}`, true);
  }).finally(() => { readingBatches--; syncPageReading(); });
  return fileQueue;
}

function addFiles(files) {
  const batch = [...files];
  return batch.length ? queueRead(() => readFiles(batch)) : fileQueue;
}

async function waitForFiles() {
  while (readingBatches) await fileQueue;
}

function syncPageReading() {
  const source = state.sources[state.view.source];
  const page = currentPage();
  const pending = source && visualReads.has(`${source.id}:${state.view.page}`);
  const active = pageProgress?.source === source && pageProgress?.index === state.view.page;
  const status = $('#page-status');
  status.textContent = active ? pageProgress.message : pending ? 'Waiting for the page reader…' :
    page?.readWarning || page?.readNotice || (pageProgress ? `Page ${pageProgress.index + 1}: ${pageProgress.message}` : '');
  status.classList.toggle('bad', !active && !pending && !!page?.readWarning);
  const btn = $('#read-page');
  btn.disabled = !page || !!pending;
  btn.textContent = pending ? 'Reading page…' : 'Read page visually';
}

function readingPage(source, index, message) {
  pageProgress = { source, index, message };
  syncPageReading();
}

async function readFiles(files) {
  $('#start').hidden = true; $('#work').hidden = false; $('#ask').hidden = false; $('#ai').hidden = false;
  for (const file of files) {
    try {
      const source = await openFile(file);
      state.sources.push(source);
      const sIndex = state.sources.length - 1;
      if (state.sources.length === 1 || state.view.source == null) state.view = { source: sIndex, page: 0 };
      for (let i = 0; i < Math.min(source.pageCount, 80); i++) {
        readingPage(source, i, `Reading page ${i + 1} of ${source.pageCount}…`);
        await preparePage(source, i, msg => readingPage(source, i, msg));
        if (sIndex === state.view.source && i === state.view.page) await showPage();
        refreshColors();
      }
      if (source.pageCount > 80) toast(`Only the first 80 pages of ${source.name} were read.`);
    } catch (error) {
      console.error(error);
      toast(`${file.name}: ${error.message || 'could not be opened.'}`, true);
    }
  }
  pageProgress = null;
  await showPage();
  autoSelect();
}

function readPageVisually() {
  const source = state.sources[state.view.source];
  const index = state.view.page;
  if (!source?.pages[index]) return Promise.resolve();
  const key = `${source.id}:${index}`;
  if (visualReads.has(key)) return fileQueue;
  visualReads.add(key);
  syncPageReading();
  return queueRead(async () => {
    const previous = source.pages[index];
    try {
      const page = await preparePage(source, index, msg => readingPage(source, index, msg), { forceOcr: true });
      if (page !== previous) {
        refreshReadPage(previous, page);
        if (state.sources[state.view.source] === source && state.view.page === index && state.mode === 'draw' && page.problems.length) setMode('numbers');
      }
      refreshColors();
      await showPage();
      toast(`Page ${index + 1}: ${page.readWarning || page.readNotice || `Found ${page.problems.length} numbered problems.`}`, !!page.readWarning);
    } catch (error) {
      console.error(error);
      previous.readWarning = `Could not read this page visually: ${error.message}. You can retry or use Draw.`;
      previous.readNotice = '';
      toast(previous.readWarning, true);
    } finally {
      visualReads.delete(key);
      pageProgress = null;
      syncPageReading();
    }
  });
}

/** Refresh a reread page without losing chosen problems, manual boxes, or clear formatting preferences. */
function refreshReadPage(previous, page) {
  const prefix = `${page.source.id}:${page.index}:`;
  const replacements = new Map(page.problems.map(p => [p.id, p]));
  const moves = new Map();
  const move = (from, to) => {
    if (!moves.has(from)) moves.set(from, new Set());
    moves.get(from).add(to);
  };
  const rangedGroup = (number, index) => number == null ? null : page.source.pages.slice(0, index + 1)
    .filter(Boolean).flatMap(p => p.directions).reverse()
    .find(d => d.range && number >= d.range.from && number <= d.range.to)?.key;
  for (const p of page.problems) {
    if (p.group.endsWith(':none')) p.group = rangedGroup(p.number, p.page) || p.group;
  }
  for (const p of previous.problems) {
    const replacement = replacements.get(p.id);
    if (replacement) move(p.group, replacement.group);
  }
  for (const old of previous.directions) {
    const matches = page.directions.filter(d => old.range && d.range && old.range.from === d.range.from && old.range.to === d.range.to);
    if (matches.length === 1) move(old.key, matches[0].key);
  }
  const remap = p => {
    const replacement = p.page === page.index && page.problems.find(n => n.number === p.number);
    if (replacement && !replacement.group.endsWith(':none')) return replacement.group;
    const ranged = rangedGroup(p.number, p.page);
    if (ranged) return ranged;
    const targets = moves.get(p.group);
    if (targets?.size === 1) {
      const target = [...targets][0];
      if (!p.manual || !target.endsWith(':none')) return target;
    }
    return `${p.sourceId}:${p.page}:${p.manual ? 'manual' : 'none'}`;
  };
  // Later pages can inherit this page's directions, including previously deselected problems.
  for (const p of allProblems()) {
    if (p.sourceId !== page.source.id || p.page === page.index || !p.group.startsWith(prefix)) continue;
    const old = p.group;
    p.group = remap(p);
    move(old, p.group);
  }
  for (const [id, p] of state.selected) {
    if (p.sourceId !== page.source.id) continue;
    if (!p.manual && p.page === page.index) {
      if (replacements.has(id)) state.selected.set(id, replacements.get(id));
    } else if (p.manual && (p.page === page.index || p.group.startsWith(prefix))) {
      const old = p.group;
      p.group = remap(p);
      move(old, p.group);
    }
  }
  // Copy a preference only when the old group has one destination and merged groups agree.
  const oldAids = new Map(state.aids);
  for (const key of state.aids.keys()) if (key.startsWith(prefix)) state.aids.delete(key);
  if (!moves.has(`${prefix}manual`)) move(`${prefix}manual`, `${prefix}manual`);
  const preferences = new Map();
  for (const [from, targets] of moves) {
    if (targets.size !== 1 || !oldAids.has(from)) continue;
    const target = [...targets][0];
    if (!preferences.has(target)) preferences.set(target, []);
    preferences.get(target).push(oldAids.get(from));
  }
  for (const [target, aids] of preferences) {
    if (state.aids.has(target)) aids.push(state.aids.get(target));
    if (aids.every(aid => JSON.stringify(aid) === JSON.stringify(aids[0]))) state.aids.set(target, aids[0]);
  }
  imageCache.clear();
  changed();
}

/** On first load: if the pages carry highlights, select them straight away. */
function autoSelect() {
  if (state.selected.size) return;
  const colors = tallyColors();
  if (!colors.length) {
    const n = allProblems().length;
    toast(n ? `No highlights found. Found ${n} numbered problems: type numbers or click boxes to pick.` : 'No numbered problems found here. Draw a box around each problem.');
    setMode(n ? 'numbers' : 'draw');
    return;
  }
  selectColor(colors[0].color, { replace: true });
}

/* ---------- highlight colors ---------- */
function tallyColors() {
  const map = new Map();
  for (const page of allPages()) {
    for (const m of page.marks) {
      if (m.anchor == null) continue;
      const entry = map.get(m.color) || { color: m.color, rgb: m.rgb, problems: new Set() };
      entry.problems.add(`${page.source.id}:${page.index}:${m.anchor}`);
      map.set(m.color, entry);
    }
  }
  return [...map.values()].map(e => ({ ...e, count: e.problems.size })).sort((a, b) => b.count - a.count);
}

function refreshColors() {
  const colors = tallyColors();
  const box = $('#colors');
  box.replaceChildren();
  if (!colors.length) {
    const p = document.createElement('p');
    p.className = 'hint'; p.textContent = allPages().length ? 'No highlighter marks found on these pages.' : 'Reading pages…';
    box.append(p);
    return;
  }
  for (const c of colors) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${state.color === c.color ? ' on' : ''}`;
    b.innerHTML = `<span class="sw"></span><span>${cap(c.color)}</span><small>${c.count}</small>`;
    b.querySelector('.sw').style.background = `rgb(${c.rgb.join(',')})`;
    b.title = `Select every problem marked in ${c.color}`;
    b.onclick = () => selectColor(c.color, { replace: state.color !== c.color && !state.selected.size ? true : false, toggle: true });
    box.append(b);
  }
}
const cap = s => s[0].toUpperCase() + s.slice(1);

function problemsMarked(color) {
  const out = [];
  for (const page of allPages()) {
    const nums = new Set(page.marks.filter(m => m.anchor != null && (color === 'any' || m.color === color)).map(m => m.anchor));
    out.push(...page.problems.filter(p => nums.has(p.number)));
  }
  return out;
}

function selectColor(color, { replace = false, toggle = false } = {}) {
  const list = problemsMarked(color);
  if (!list.length) { toast(color === 'any' ? 'No highlighted problems found.' : `No problems are marked in ${color}.`, true); return 0; }
  const allOn = list.every(p => state.selected.has(p.id));
  if (replace) state.selected.clear();
  if (toggle && allOn && !replace) { list.forEach(p => state.selected.delete(p.id)); state.color = null; }
  else { list.forEach(p => state.selected.set(p.id, p)); state.color = color === 'any' ? null : color; }
  const hit = tallyColors().find(c => c.color === color);
  if (hit) document.documentElement.style.setProperty('--mark', `rgb(${hit.rgb.join(',')})`);
  changed();
  toast(`${allOn && toggle && !replace ? 'Removed' : 'Selected'} ${list.length} ${color === 'any' ? 'highlighted' : color} problems: ${formatNumbers(list.map(p => p.number))}.`);
  return list.length;
}

/* ---------- numbers ---------- */
function numberCandidates() {
  const manual = [...state.selected.values()].filter(p => p.manual && p.number != null);
  // A chosen manual crop replaces the automatic crop of that same exercise.
  const candidates = [...allProblems().filter(p => !manual.some(m => m.sourceId === p.sourceId && m.page === p.page && m.number === p.number)), ...manual];
  // Numbering can restart in a Quick Review section. Prefer the main exercise
  // only within that same source; ordinary duplicate numbers remain selectable.
  return candidates.filter(p => !p.review || !candidates.some(q =>
    !q.review && q.sourceId === p.sourceId && q.number === p.number
  ));
}

function findNumbers(nums, candidates = numberCandidates()) {
  const found = candidates.filter(p => nums.includes(p.number));
  const missing = nums.filter(n => !found.some(p => p.number === n));
  return { found, missing };
}

function applyNumberSelection(found, { remove = false, replace = false, empty = false } = {}) {
  if (replace && (found.length || empty)) {
    // A literal list/range sets the desired numbered selection, including when
    // only part is detected. Keep unnumbered drawn boxes, which it cannot name.
    for (const [id, p] of state.selected) if (p.number != null || !p.manual) state.selected.delete(id);
    state.color = null;
  }
  for (const p of found) remove ? state.selected.delete(p.id) : state.selected.set(p.id, p);
}

const missingNumbersMessage = nums => `Not detected on the loaded pages: ${formatNumbers(nums)}. On the page containing them, choose “Read page visually” or use Draw.`;

async function selectNumbers(text, remove = false) {
  const nums = parseNumbers(text);
  if (!nums.length) { toast('Type problem numbers like 11, 13, 15–21 odd.', true); return; }
  const btn = $('#numbers-form button');
  btn.disabled = true;
  if (readingBatches) btn.textContent = 'Reading pages…';
  try {
    await waitForFiles();
    const { found, missing } = findNumbers(nums, remove ? [...state.selected.values()] : numberCandidates());
    applyNumberSelection(found, { remove, replace: !remove });
    if (found.length) changed();
    const messages = [];
    if (found.length) messages.push(`${remove ? 'Removed' : 'Selected'} ${formatNumbers(found.map(p => p.number))}.`);
    if (missing.length) messages.push(remove ? `Not selected: ${formatNumbers(missing)}.` : missingNumbersMessage(missing));
    toast(messages.join(' '), missing.length > 0);
  } finally { btn.disabled = false; btn.textContent = 'Select'; }
}

/* ---------- page view ---------- */
async function showPage() {
  const source = state.sources[state.view.source];
  if (!source) return;
  const page = source.pages[state.view.page];
  const total = state.sources.reduce((a, s) => a + s.pageCount, 0);
  const flat = state.sources.slice(0, state.view.source).reduce((a, s) => a + s.pageCount, 0) + state.view.page;
  $('#page-label').textContent = `${state.sources.length > 1 ? source.name + ', ' : ''}page ${state.view.page + 1} of ${source.pageCount}`;
  $('#prev').disabled = flat === 0; $('#next').disabled = flat >= total - 1;
  syncPageReading();
  const c = $('#page');
  if (!page) {
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    $('#overlay').replaceChildren();
    return;
  }
  c.width = page.canvas.width; c.height = page.canvas.height;
  c.getContext('2d').drawImage(page.canvas, 0, 0);
  $('#surface').style.maxWidth = `${Math.min(1100, page.width * 1.6)}px`;
  drawOverlay();
}

function drawOverlay() {
  const page = currentPage();
  const ov = $('#overlay');
  ov.replaceChildren();
  ov.classList.toggle('drawing', state.mode === 'draw');
  if (!page) return;
  const pct = (v, total) => `${(v / total) * 100}%`;
  const extra = [...state.selected.values()].filter(p => p.manual && p.sourceId === page.source.id && p.page === page.index);
  for (const p of [...page.problems, ...extra]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `box${state.selected.has(p.id) ? ' on' : ''}${p.manual ? ' manual' : ''}`;
    Object.assign(b.style, { left: pct(p.rect.x0, page.width), top: pct(p.rect.y0, page.height), width: pct(p.rect.x1 - p.rect.x0, page.width), height: pct(p.rect.y1 - p.rect.y0, page.height) });
    b.setAttribute('aria-label', `Problem ${p.label ?? p.number}${state.selected.has(p.id) ? ', selected' : ''}`);
    b.setAttribute('aria-pressed', state.selected.has(p.id));
    const n = document.createElement('span'); n.className = 'num'; n.textContent = '✓'; n.setAttribute('aria-hidden', 'true');
    b.append(n);
    b.onclick = e => {
      if (state.mode === 'draw' && !p.manual) return;
      e.stopPropagation();
      if (state.selected.has(p.id)) state.selected.delete(p.id); else state.selected.set(p.id, p);
      changed();
    };
    if (state.mode === 'draw' && !p.manual) b.style.pointerEvents = 'none';
    ov.append(b);
  }
}

/* ---------- drawing manual boxes ---------- */
function setupDrawing() {
  const ov = $('#overlay');
  let start = null, rectEl = null;
  const point = e => {
    const r = ov.getBoundingClientRect(), page = currentPage();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * page.width, y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * page.height };
  };
  ov.addEventListener('pointerdown', e => {
    if (state.mode !== 'draw' || !currentPage() || e.target !== ov) return;
    start = point(e); ov.setPointerCapture(e.pointerId);
    rectEl = document.createElement('div'); rectEl.className = 'drag'; ov.append(rectEl);
  });
  ov.addEventListener('pointermove', e => {
    if (!start) return;
    const p = point(e), page = currentPage();
    Object.assign(rectEl.style, { left: `${Math.min(start.x, p.x) / page.width * 100}%`, top: `${Math.min(start.y, p.y) / page.height * 100}%`, width: `${Math.abs(p.x - start.x) / page.width * 100}%`, height: `${Math.abs(p.y - start.y) / page.height * 100}%` });
  });
  ov.addEventListener('pointerup', e => {
    if (!start) return;
    const p = point(e), page = currentPage();
    const rect = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) };
    start = null; rectEl?.remove();
    if (rect.x1 - rect.x0 < 8 || rect.y1 - rect.y0 < 6) return;
    const prob = manualProblem(page, rect, ++state.manualCount);
    state.selected.set(prob.id, prob);
    changed();
    toast(`Added ${prob.number != null ? `problem ${prob.number}` : 'your selection'}.`);
  });
}

/* ---------- modes ---------- */
function setMode(mode) {
  state.mode = mode;
  for (const b of $$('.mode')) { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  for (const p of $$('.mode-panel')) p.hidden = p.dataset.panel !== mode;
  drawOverlay();
  if (mode === 'numbers') $('#numbers').focus();
}

/* ---------- exam building ---------- */
function orderedSelection() {
  const sourceIndex = new Map(state.sources.map((s, i) => [s.id, i]));
  return [...state.selected.values()].sort((a, b) =>
    sourceIndex.get(a.sourceId) - sourceIndex.get(b.sourceId) || a.page - b.page || (a.number ?? 1e9) - (b.number ?? 1e9) || a.rect.y0 - b.rect.y0);
}

function groupInfo(key) {
  for (const page of allPages()) {
    const d = page.directions.find(x => x.key === key);
    if (d) return { page, dir: d };
  }
  return null;
}

function buildGroups() {
  const groups = [];
  const byKey = new Map();
  for (const p of orderedSelection()) {
    // Directions on an earlier page can still govern this one ("In Problems 41–56" over a page break).
    if (p.group.endsWith(':none') && p.number != null) {
      const src = state.sources.find(s => s.id === p.sourceId);
      const carried = src?.pages.slice(0, p.page + 1).filter(Boolean).flatMap(pg => pg.directions).reverse()
        .find(d => d.range && p.number >= d.range.from && p.number <= d.range.to);
      if (carried) p.group = carried.key;
    }
    let g = byKey.get(p.group);
    if (!g) {
      const info = groupInfo(p.group);
      g = { key: p.group, info, problems: [], aid: state.aids.get(p.group) || info?.dir.aid || { kind: 'blank', parts: [] } };
      byKey.set(p.group, g); groups.push(g);
    }
    g.problems.push(p);
  }
  return groups;
}

function renderGroups(groups) {
  const box = $('#groups');
  box.replaceChildren();
  for (const g of groups) {
    const el = document.createElement('div');
    el.className = 'group';
    const p = document.createElement('p');
    p.textContent = g.info ? g.info.dir.label : g.key.endsWith(':manual') ? 'Your boxes' : 'No directions';
    p.title = p.textContent;
    const row = document.createElement('div'); row.className = 'group-row';
    for (const prob of g.problems) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pill'; b.textContent = prob.label ?? prob.number;
      b.title = 'Remove from the exam';
      b.onclick = () => { state.selected.delete(prob.id); changed(); };
      row.append(b);
    }
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Work area for this group');
    const parts = g.aid.parts?.length ? g.aid.parts : [];
    const opts = [['blank', 'Blank space'], ['polar', 'Polar grid'], ['xy', 'Graph paper'], ['line', 'Answer line']];
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t + (parts.length && v !== 'line' ? ` + (${parts.join(')(')}) lines` : ''); sel.append(o); }
    sel.value = g.aid.kind;
    sel.onchange = () => { state.aids.set(g.key, { kind: sel.value, parts }); changed(false); };
    row.append(sel);
    el.append(p, row);
    box.append(el);
  }
}

const imageCache = new Map();
async function imageFor(key, make) {
  if (!imageCache.has(key)) imageCache.set(key, make().then(async r => ({ w: r.w, h: r.h, bytes: await pngBytes(r.canvas) })));
  return imageCache.get(key);
}

let measureFont = null;
async function measurer() {
  if (!measureFont) {
    const doc = await PDFLib.PDFDocument.create();
    measureFont = await doc.embedFont(PDFLib.StandardFonts.TimesRomanItalic);
  }
  return (text, size) => { try { return measureFont.widthOfTextAtSize(text, size); } catch { return text.length * size * 0.45; } };
}

let building = null, queued = false;
async function rebuild() {
  if (building) { queued = true; return; }
  const revision = state.revision;
  building = (async () => {
    const groups = buildGroups();
    renderGroups(groups);
    const has = groups.length > 0;
    $('#download').disabled = $('#print').disabled = !has;
    if (!has) { $('#preview').replaceChildren(); $('#exam-status').textContent = ''; state.pdf = null; return; }
    $('#exam-status').textContent = 'Laying out…'; $('#exam-status').classList.remove('bad');
    const images = new Map();
    const layoutGroups = [];
    for (const g of groups) {
      const pageOf = p => state.sources.find(s => s.id === p.sourceId).pages[p.page];
      const problems = [];
      for (const p of g.problems) {
        const ref = `p:${p.id}:${p.rect.x0.toFixed(1)},${p.rect.y0.toFixed(1)},${p.rect.x1.toFixed(1)},${p.rect.y1.toFixed(1)}`;
        const img = await imageFor(ref, () => cropImage(pageOf(p), p.rect, { parts: p.parts }));
        if (revision !== state.revision) return;
        images.set(ref, { bytes: img.bytes, type: 'png' });
        problems.push({ id: p.id, w: img.w, h: img.h, ref, extent: p.extent, baseline: p.baseline });
      }
      let directions = null, figure = null;
      if (g.info) {
        const { page, dir } = g.info;
        if (dir.printable) directions = { text: dir.text };
        else {
          const ref = `d:${dir.key}`;
          const img = await imageFor(ref, () => directionsImage(page, dir));
          if (revision !== state.revision) return;
          images.set(ref, { bytes: img.bytes, type: 'png' });
          directions = { image: { w: img.w, h: img.h, ref } };
        }
        if (dir.figure) {
          const ref = `f:${dir.key}`;
          const img = await imageFor(ref, () => cropImage(page, dir.figure));
          if (revision !== state.revision) return;
          images.set(ref, { bytes: img.bytes, type: 'png' });
          figure = { w: img.w, h: img.h, ref };
        }
      }
      layoutGroups.push({ directions, figure, aid: g.aid, problems });
    }
    const layout = layoutExam(layoutGroups, state.settings, await measurer());
    const bytes = await renderExamPdf(PDFLib, layout, images);
    if (revision !== state.revision) return;
    state.pdf = bytes;
    const n = groups.reduce((a, g) => a + g.problems.length, 0);
    $('#exam-status').textContent = layout.warnings[0] || `${n} problem${n === 1 ? '' : 's'} on ${layout.pages.length} side${layout.pages.length === 1 ? '' : 's'}${layout.pages.length === 2 && state.settings.pages === 2 ? ' — print double-sided' : ''}.`;
    $('#exam-status').classList.toggle('bad', layout.warnings.length > 0);
    await showPreview(bytes);
  })();
  try { await building; }
  catch (error) { console.error(error); $('#exam-status').textContent = `Could not build the PDF: ${error.message}`; $('#exam-status').classList.add('bad'); }
  finally { building = null; if (queued) { queued = false; rebuild(); } }
}

async function showPreview(bytes) {
  const lib = await import('../vendor/pdfjs/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc ||= new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  const frag = document.createDocumentFragment();
  const width = Math.max(320, $('.exam').clientWidth - 52);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * Math.min(2, devicePixelRatio || 1) });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption'); cap.textContent = doc.numPages === 2 ? (i === 1 ? 'Front' : 'Back') : `Page ${i}`;
    fig.append(c, cap); frag.append(fig);
  }
  $('#preview').replaceChildren(frag);
  doc.destroy();
}

let timer;
function changed(redrawOverlay = true) {
  state.revision++;
  if (redrawOverlay) drawOverlay();
  clearTimeout(timer);
  timer = setTimeout(rebuild, 120);
}

/* ---------- settings ---------- */
function syncSettings() {
  const s = state.settings;
  $('#set-pages').value = String(s.pages); $('#set-space').value = s.space; $('#set-columns').value = String(s.columns);
  $('#set-paper').value = s.paper; $('#set-directions').checked = s.directions;
}
function bindSettings() {
  const on = (id, key, conv = v => v) => $(id).addEventListener('change', e => {
    state.settings[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    remember('settings', state.settings); changed(false);
  });
  on('#set-pages', 'pages', Number); on('#set-space', 'space'); on('#set-columns', 'columns', Number); on('#set-paper', 'paper'); on('#set-directions', 'directions');
}

/* ---------- the request box ---------- */
async function ask(text) {
  if (!text.trim()) return;
  const btn = $('#ask button');
  btn.disabled = true; btn.textContent = 'Reading…';
  try {
    if (readingBatches) btn.textContent = 'Reading pages…';
    await waitForFiles();
    btn.textContent = 'Reading…';
    const { fields, source } = await interpret(text);
    // A file may have been added while the optional model was interpreting prose.
    if (readingBatches) btn.textContent = 'Reading pages…';
    await waitForFiles();
    const { done, warnings } = applyFields(fields, { replaceNumbers: isExplicitNumberList(text) });
    const summary = done.length ? `${done.join(' · ')}${source === 'model' ? '  (local AI)' : ''}.` : '';
    toast([summary, ...warnings].filter(Boolean).join(' ') || 'Nothing to change in that request. Try “green ones, 2 pages” or “11, 13, 15–21 odd”.', warnings.length > 0 || !done.length);
  } catch (error) {
    console.error(error);
    toast(`Could not apply the request: ${error.message}`, true);
  } finally { btn.disabled = false; btn.textContent = 'Apply'; }
}

function applyFields(f, { replaceNumbers = false } = {}) {
  const done = [];
  const warnings = [];
  if (f.clear) { state.selected.clear(); done.push('cleared'); }
  if (f.highlight_color) {
    const list = problemsMarked(f.highlight_color);
    if (list.length) {
      if (!f.add_numbers) state.selected.clear();
      list.forEach(p => state.selected.set(p.id, p));
      state.color = f.highlight_color === 'any' ? null : f.highlight_color;
      done.push(`${list.length} ${f.highlight_color === 'any' ? 'highlighted' : f.highlight_color} problems`);
    } else warnings.push(`No ${f.highlight_color} marks found.`);
  }
  if (f.add_numbers !== undefined) {
    const nums = parseNumbers(f.add_numbers);
    const { found, missing } = findNumbers(nums);
    applyNumberSelection(found, { replace: replaceNumbers, empty: !nums.length });
    if (found.length) done.push(`selected ${formatNumbers(found.map(p => p.number))}`);
    else if (replaceNumbers && !nums.length) done.push('cleared numbered selection');
    if (missing.length) warnings.push(missingNumbersMessage(missing));
  }
  if (f.remove_numbers) {
    const nums = parseNumbers(f.remove_numbers);
    const { found, missing } = findNumbers(nums, [...state.selected.values()]);
    for (const p of found) state.selected.delete(p.id);
    if (found.length) done.push(`removed ${formatNumbers(found.map(p => p.number))}`);
    if (missing.length) warnings.push(`Not selected: ${formatNumbers(missing)}.`);
  }
  const s = state.settings;
  if (f.pages) { s.pages = Math.min(4, f.pages); done.push(f.pages === 2 ? '2 sides' : `${f.pages} side${f.pages > 1 ? 's' : ''}`); }
  if (f.columns) { s.columns = f.columns; done.push(`${f.columns} per row`); }
  if (f.space) { s.space = f.space === 'medium' ? 'small' : f.space; done.push({ fill: 'fill the page', small: 'a little room', large: 'lots of room', none: 'no work space' }[s.space]); }
  if (typeof f.directions === 'boolean') { s.directions = f.directions; done.push(f.directions ? 'with directions' : 'no directions'); }
  if (f.paper) { s.paper = f.paper; done.push(f.paper === 'a4' ? 'A4' : 'Letter'); }
  if (f.graph) {
    const groups = buildGroups();
    const plotting = groups.filter(g => /plot|graph|sketch/i.test(g.info?.dir.raw || ''));
    for (const g of plotting.length ? plotting : groups) state.aids.set(g.key, { kind: f.graph === 'none' ? 'blank' : f.graph, parts: g.aid.parts || [] });
    done.push(f.graph === 'none' ? 'no grids' : `${f.graph === 'polar' ? 'polar grids' : 'graph paper'}`);
  }
  remember('settings', s); syncSettings(); refreshColors();
  if (done.length) changed();
  return { done, warnings };
}

/* ---------- local AI status ---------- */
function bindAgent() {
  $('#ai-load').onclick = () => { remember('ai', true); loadAgent(); };
  onAgentStatus(s => {
    const st = $('#ai-status');
    st.classList.toggle('ready', s.state === 'ready');
    $('#ai-load').hidden = s.state !== 'off' && s.state !== 'error';
    if (s.state === 'loading') st.textContent = s.total ? `Downloading local AI ${Math.round(100 * s.loaded / s.total)}% of ${Math.round(s.total / 1e6)} MB` : 'Starting local AI…';
    else if (s.state === 'ready') st.textContent = `Local AI on${s.device === 'wasm' ? ' (CPU, slower)' : ''}`;
    else if (s.state === 'error') { st.textContent = /WebGPU/.test(s.message || '') ? 'Local AI needs WebGPU' : 'Local AI unavailable'; st.title = s.message || ''; if (s.message) toast(s.message, true); }
    else st.textContent = '';
  });
  if (recall('ai', false)) loadAgent();
}

/* ---------- wiring ---------- */
function init() {
  syncSettings(); bindSettings(); bindAgent(); setupDrawing();
  $('#choose').onclick = () => $('#file').click();
  $('#add-files').onclick = () => $('#file').click();
  $('#read-page').onclick = readPageVisually;
  $('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#sample').onclick = async () => {
    const res = await fetch(new URL('../samples/sample.pdf', import.meta.url));
    addFiles([new File([await res.blob()], 'sample.pdf', { type: 'application/pdf' })]);
  };
  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === drop) drop.classList.remove('over'); });
  document.addEventListener('drop', e => addFiles([...(e.dataTransfer?.files || [])]));
  document.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => /^image\/|pdf/.test(f.type));
    if (files.length) addFiles(files);
  });
  for (const b of $$('.mode')) b.onclick = () => setMode(b.dataset.mode);
  $('#numbers-form').onsubmit = e => { e.preventDefault(); selectNumbers($('#numbers').value); };
  $('#ask').onsubmit = e => { e.preventDefault(); ask($('#ask-input').value); };
  const step = d => {
    const flat = [];
    state.sources.forEach((s, si) => { for (let i = 0; i < s.pageCount; i++) flat.push([si, i]); });
    const at = flat.findIndex(([si, i]) => si === state.view.source && i === state.view.page);
    const next = flat[at + d];
    if (next) { state.view = { source: next[0], page: next[1] }; showPage(); }
  };
  $('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || $('#work').hidden) return;
    if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1);
  });
  $('#download').onclick = () => {
    if (!state.pdf) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([state.pdf], { type: 'application/pdf' }));
    a.download = `${(state.sources[0]?.name || 'problems').replace(/\.[^.]+$/, '')}-exam.pdf`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#print').onclick = () => {
    if (!state.pdf) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    frame.src = URL.createObjectURL(new Blob([state.pdf], { type: 'application/pdf' }));
    frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(frame.src); } setTimeout(() => frame.remove(), 60000); };
    document.body.append(frame);
  };
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => state.pdf && showPreview(state.pdf), 250); });
  window.__syw = { state, addFiles, ask, selectNumbers, selectColor, readPageVisually, rebuild: () => { state.revision++; return rebuild(); } };
}
init();
