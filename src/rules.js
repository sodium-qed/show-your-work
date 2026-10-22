// Deterministic reading of a request (English + Chinese). Two jobs:
//  1. instant answer before / without the local model;
//  2. evidence check: a field the model proposes is kept only if the request
//     actually talks about that kind of thing (small models like to fill every field).

import { parseNumbers, formatNumbers } from './numbers.js';

const numberItem = String.raw`(?:\b(?:odd|even)\s+)?\d{1,3}(?:\s*(?:[-–—−~]|\b(?:to|through|thru)\b|至|到)\s*\d{1,3})?(?:\s*(?:odd|even|奇数|偶数|单数|双数))?`;
const numberList = new RegExp(
  String.raw`^${numberItem}(?:(?:\s*[,，、;；&和与及]\s*(?:and\s+)?|\s+and\s+|\s+)${numberItem})*$`, 'i',
);
const allPagesTail = /(?:[,;，；]\s*|\s+)(?:(?:(?:look|check)\s+(?:at|through)\s+|(?:search|scan|read|from|across|on|in)\s+)?all\s+(?:(?:the|loaded|source)\s+)?pages?|(?:查看|检查|搜索|扫描|读取|从)?所有页(?:面)?)\s*$/i;
// Share the same extent grammar between extraction and number suppression.
// Otherwise a valid layout parameter can accidentally become a question label.
const graphExtent = /(?:(?:(?:(?:coordinate|cartesian|complex|polar)\s+)?(?:graphs?|grids?|planes?)|polar|axis|axes|number[ -]?lines?)\s*(?:(?:range|extent|maximum|max|radius|limit)\s*(?:to|up to|out to|of|=|:)?|(?:to|up to|out to|of|=|:))|(?:radius|半径|坐标范围)\s*(?:of|=|:|为|是)?)\s*([-+]?\d+(?:\.\d+)?)/i;
const layoutTail = /(?:\s*[,;]\s*|\s+(?:and|with)\s+)(?:(?:use\s+)?(?:compact|tight|save paper|fewest pages|fill the page|(?:no|lots of|more|some) (?:work )?(?:space|room)|(?:\d+|one|two|three|four|一|两|二|三|四)\s*(?:columns?|pages?|sides?|per row|列|页|面)|(?:polar|complex|coordinate) (?:grids?|planes?)|graph paper|number line|lined paper|dot grid|blank space|a4(?: paper)?|letter(?: paper)?|(?:no|skip|hide) (?:the )?(?:directions|instructions)|紧凑(?:一些)?|省纸|两列|不要说明|极坐标|复数平面))\s*$/i;

const normalizeRequest = text => String(text ?? '').normalize('NFKC').trim();
const cleanList = text => text.replace(/\b(?:problems?|questions?|exercises?|numbers?)\b\s*:?|第|题目|题|號|号|#/gi, ' ').trim();
const parseList = text => {
  const clean = cleanList(text);
  return numberList.test(clean) ? parseNumbers(clean) : null;
};

/** A complete desired-number request. Incremental add/remove commands return null.
 * The grammar is deliberately anchored: stray prose, dimensions and page counts
 * must never become exercise numbers. Chinese/English "only" means replacement.
 */
export function readNumberSelection(text) {
  let t = normalizeRequest(text).replace(/[.!?。！？]+$/, '').replace(allPagesTail, '').trim().replace(/[,;]\s*$/, '');
  // Peel off recognized layout clauses, never arbitrary prose. This retains
  // exact-set semantics for "only 15, 17, compact, 2 columns".
  let previous;
  do {
    previous = t;
    t = t.replace(layoutTail, '').replace(allPagesTail, '').trim();
    const extentTail = new RegExp(`(?:[,;]\\s*|\\s+with\\s+)${graphExtent.source}$`, 'i');
    t = t.replace(extentTail, '').trim();
  } while (t !== previous);
  t = t.replace(/^(?:(?:please|can you|could you|would you)\s+|请(?:帮我)?\s*)+/i, '')
    .replace(/^replace\s+(?:(?:the|my|current)\s+)*(?:selection|problems|questions)\s+with\s+/i, '')
    .replace(/^(?:把(?:题目|选择)(?:换成|改成)|换成|改成)\s*/, '')
    .replace(/^(?:i\s+)?(?:only|just)\s+want\s+/i, '')
    .replace(/^(?:i(?:'d|\s+would)?\s+(?:like|want)|give\s+me|show\s+me)\s+/i, '')
    .replace(/^(?:(?:select|choose|use|keep|include|only|just|exactly|the)\s+)+/i, '')
    .replace(/^(?:我)?(?:(?:只要|仅要|仅选|只选|选择|选取|选中|只保留|仅保留|保留)\s*)+/, '')
    .replace(/(?:[,;]?\s+(?:please|only)|(?:就好|即可))$/i, '').trim();
  const exclusion = t.match(/\b(?:omit|exclude|excluding|except(?:\s+for)?|without|skip|minus|leave\s+out)\b|不要|去掉|排除|除了/i);
  let omitted = [];
  if (exclusion) {
    let tail = t.slice(exclusion.index + exclusion[0].length).trim().replace(/(?:以外|之外)$/, '');
    if (tail.startsWith('(') && tail.endsWith(')')) tail = tail.slice(1, -1).trim();
    omitted = parseList(tail);
    if (omitted === null) return null;
    t = t.slice(0, exclusion.index).trim().replace(/[,;]\s*$/, '').trim();
  }
  const included = parseList(t);
  if (included === null) return null;
  const excluded = new Set(omitted);
  return included.filter(n => !excluded.has(n));
}

const COLORS = {
  green: /green|绿/i, yellow: /yellow|黄/i, pink: /pink|粉|magenta/i, blue: /blue|蓝|cyan|青/i,
  orange: /orange|橙|橘/i, purple: /purple|violet|紫/i, red: /\bred\b|红/i,
};
const EVIDENCE = {
  highlight_color: /highlight|marked|circled|colou?r|标|圈|画|高亮|荧光|颜色|green|yellow|pink|blue|orange|purple|violet|\bred\b|绿|黄|粉|蓝|橙|紫|红/i,
  add_numbers: /\d/,
  remove_numbers: /remove|drop|skip|without|delete|exclude|except|not\b|don'?t|no\s+\d|minus|rid of|take out|cut|leave out|omit|不要|去掉|删|除了|拿掉|别/i,
  clear: /start over|clear|reset|from scratch|empty|redo|instead|重新|清空|重置|全部删|换成/i,
  pages: /page|side|sheet|front|back|duplex|fewest|save paper|saving paper|节省纸|省纸|页|张|面/i,
  columns: /column|row|line|across|side by side|列|行|栏/i,
  space: /space|room|compact|tight|exam|test|waste|cram|spacious|save paper|saving paper|紧凑|空间|考试|空白|浪费|地方|留|宽松|省纸/i,
  directions: /direction|instruction|prompt|heading|说明|题干|指示|要求/i,
  paper: /a4|letter|paper|europe|纸/i,
  graph: /graph|grid|polar|axes|axis|plot|plane|argand|complex|number.?line|lined|dot.?paper|blank|坐标|网格|极坐标|复平面|复数|数轴|横线|点阵|空白/i,
  graph_extent: /(?:graph|grid|plane|polar|axis|axes|radius|坐标|网格|半径)/i,
};

export const hasEvidence = (field, text) => EVIDENCE[field]?.test(field === 'pages' ? text.replace(allPagesTail, '') : text) ?? false;

export function colorIn(text) {
  for (const [name, re] of Object.entries(COLORS)) if (re.test(text)) return name;
  return null;
}

/** Best-effort parse. Returns the same fields as the model's update_worksheet call. */
export function readRequest(text) {
  const t = normalizeRequest(text);
  const selection = readNumberSelection(t);
  // Source-page scope does not change printed page count. Exclusions are resolved
  // before lookup so omitted labels neither get selected nor trigger warnings.
  const out = {};
  const color = colorIn(t);
  if (color) out.highlight_color = color;
  else if (/highlight|marked|circled|高亮|标记|圈/i.test(t)) out.highlight_color = 'any';

  if (EVIDENCE.clear.test(t)) out.clear = true;

  // Numbers: separate "remove ..." clauses from additions. Ignore page/column counts.
  const stripped = t
    .replace(/(\d+)\s*(?:pages?|sides?|sheets?|columns?|per row|页|张|列|栏|in a row)/gi, ' ')
    .replace(/(?:a4|letter)/gi, ' ')
    .replace(new RegExp(graphExtent.source, 'gi'), ' ');
  const removeRe = /(?:remove|drop|skip|without|delete|exclude|except|minus|get rid of|rid of|take out|leave out|omit|cut|不要|去掉|删掉|删除|除了|拿掉|别要)\s*(?:(?:the\s+)?(?:numbers?|problems?|questions?|exercises?)\s*)?\(?\s*((?:第?\s*\d{1,3}\s*(?:题|号)?\s*(?:[-–—~,，、&和与及]|and|to|through|odd|even|奇数|偶数|\s)*)+)\s*\)?/gi;
  const removed = [];
  let adds = stripped.replace(removeRe, (_, nums) => { removed.push(nums); return ' '; });
  if (removed.length) out.remove_numbers = removed.join(', ');
  const addNums = adds.match(/(?:第\s*)?\d{1,3}(?:\s*(?:题|号))?(?:\s*(?:[-–—~,，、&和与及]|\band\b|\bto\b|\bthrough\b|\bthru\b|至|到)\s*(?:第\s*)?\d{1,3}(?:\s*(?:题|号))?)*(?:\s*(?:odd|even|奇数|偶数))?/gi);
  if (addNums) {
    const cleaned = addNums.filter(s => /\d/.test(s)).join(', ');
    if (cleaned) out.add_numbers = cleaned;
  }

  // Pages.
  if (/fewest|as few (?:pages|sides)|save paper|saving paper|省纸|节省纸|最少页/i.test(t)) out.pages = 0;
  else if (/double[- ]?sid|two[- ]sid|front and back|both sides|duplex|one sheet|1 sheet|双面|正反/i.test(t)) out.pages = 2;
  else {
    const m = t.match(/(\d+|one|two|three|four|一|两|二|三|四)\s*(?:pages?|sides?|页|张)/i);
    if (m) out.pages = ({ one: 1, two: 2, three: 3, four: 4, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 })[m[1].toLowerCase()] || +m[1];
    else if (/single (?:page|side)|one page|一页/i.test(t)) out.pages = 1;
  }
  const cols = t.match(/(\d|one|two|three|一|两|二|三)\s*(?:columns?|per row|in a row|across|problems? on each line|列|栏)|每行(?:放)?\s*(\d|一|两|二|三)/i);
  if (cols) { const v = cols[1] || cols[2]; out.columns = ({ one: 1, two: 2, three: 3, 一: 1, 两: 2, 二: 2, 三: 3 })[v.toLowerCase()] || +v; }

  if (/no (?:work )?(?:space|room)|without space|just (?:the problems|list the questions)|不留空|不要空/i.test(t)) out.space = 'none';
  else if (/lots of|more (?:space|room)|plenty|big space|spacious|宽松|多留|大量/i.test(t)) out.space = 'large';
  else if (/a little|some room|small space|少留|一点/i.test(t)) out.space = 'small';
  else if (/compact|tight|don'?t waste|no wasted|cram|save paper|saving paper|紧凑|不要浪费|省纸/i.test(t)) out.space = 'compact';
  else if (/exam|test style|fill|考试|留出|留空间|过程/i.test(t)) out.space = 'fill';

  if (/no (?:directions|instructions)|without (?:directions|instructions)|(?:hide|skip|drop) (?:the )?(?:directions|instructions)|不要(?:说明|题干|指示)/i.test(t)) out.directions = false;
  else if (/(?:keep|show|with|include) (?:the )?(?:directions|instructions)|保留(?:说明|题干)/i.test(t)) out.directions = true;

  if (/\ba4\b|(?:european|international) paper/i.test(t)) out.paper = 'a4';
  else if (/\bletter\b|us letter|american paper/i.test(t)) out.paper = 'letter';

  if (/(?:no|without|remove)\s+(?:(?:complex|coordinate|cartesian|polar|dot|dotted|lined)\s+)?(?:graphs?|grids?|planes?|number[ -]?lines?|lined paper|dot paper)|不要(?:坐标|网格|复数平面|复平面|数轴|横线纸|点阵)/i.test(t)) out.graph = 'none';
  else if (/blank (?:space|work area|paper)|空白(?:区|纸)/i.test(t)) out.graph = 'blank';
  else if (/complex (?:plane|grid)|argand|复平面|复数平面/i.test(t)) out.graph = 'complex';
  else if (/number[ -]?line|数轴/i.test(t)) out.graph = 'numberline';
  else if (/dot(?:ted)?[ -]?(?:paper|grid)|点阵/i.test(t)) out.graph = 'dot';
  else if (/lined (?:paper|space)|ruled (?:paper|lines)|横线纸/i.test(t)) out.graph = 'lined';
  else if (/polar|极坐标/i.test(t)) out.graph = 'polar';
  else if (/graph paper|grid|coordinate plane|xy|坐标纸|网格/i.test(t)) out.graph = 'xy';
  const extent = t.match(graphExtent);
  if (extent && +extent[1] > 0 && +extent[1] <= 10000) out.graph_extent = +extent[1];
  if (selection !== null) {
    out.add_numbers = formatNumbers(selection);
    delete out.remove_numbers;
    delete out.clear;
  }
  return out;
}

const VALID = {
  highlight_color: v => typeof v === 'string' && /^(any|green|yellow|pink|blue|orange|purple|red)$/i.test(v.trim()),
  add_numbers: v => /\d/.test(String(v)),
  remove_numbers: v => /\d/.test(String(v)),
  clear: v => v === true,
  pages: v => Number.isInteger(+v) && +v >= 0 && +v <= 20,
  columns: v => Number.isInteger(+v) && +v >= 1 && +v <= 3,
  space: v => ['none', 'small', 'medium', 'large', 'fill', 'compact'].includes(v),
  directions: v => typeof v === 'boolean',
  paper: v => ['letter', 'a4'].includes(v),
  graph: v => ['polar', 'xy', 'complex', 'numberline', 'lined', 'dot', 'blank', 'none'].includes(v),
  graph_extent: v => Number.isFinite(+v) && +v > 0 && +v <= 10000,
};

/**
 * Combine a model proposal with the request text: keep only valid, evidenced fields;
 * numbers must literally appear in the request; fill gaps from the rule reader.
 */
export function reconcile(text, proposal = {}) {
  const rules = readRequest(text);
  if (readNumberSelection(text) !== null) return rules;
  const out = {};
  for (const [k, raw] of Object.entries(proposal || {})) {
    let v = raw;
    if (k === 'pages' || k === 'columns' || k === 'graph_extent') v = +v;
    if (k === 'directions' && typeof v === 'string') v = v === 'true';
    if (k === 'clear' && typeof v === 'string') v = v === 'true';
    if (!(k in VALID) || !VALID[k](v)) continue;
    if (!hasEvidence(k, text)) continue;
    if (k === 'highlight_color') {
      v = v.toLowerCase().trim();
      const named = colorIn(text);
      if (v !== 'any' && named && named !== v) v = named; // trust the color the user actually typed
      if (v !== 'any' && !named) v = 'any';
    }
    if (k === 'add_numbers' || k === 'remove_numbers') {
      const nums = parseNumbers(v);
      // Validate expanded sets, not only literal range endpoints: a model must
      // never turn '15, 41' into every exercise from 15 through 41.
      const evidence = rules[k] ?? (k === 'remove_numbers' ? rules.add_numbers : null);
      const allowed = new Set(evidence ? parseNumbers(evidence) : []);
      if (!nums.length || !nums.every(n => allowed.has(n))) { if (rules[k]) v = rules[k]; else continue; }
    }
    // Numeric graph settings are accepted only when the rule reader found the
    // actual extent phrase; a nearby exercise or page number is not evidence.
    if (k === 'graph_extent' && rules.graph_extent === undefined) continue;
    out[k] = v;
  }
  // The model heard a removal the rules read as an addition: the rules missed the verb.
  if (out.remove_numbers && !rules.remove_numbers && rules.add_numbers && !('add_numbers' in out)) {
    out.remove_numbers = rules.add_numbers;
    delete rules.add_numbers;
  }
  // The rule reader only fires on explicit phrasings, so where both answered, it wins;
  // the model fills in what the rules could not read.
  for (const [k, v] of Object.entries(rules)) {
    if (k === 'add_numbers' && 'remove_numbers' in out && !rules.remove_numbers) continue;
    out[k] = v;
  }
  // Never add and remove the same number in one request.
  if (out.add_numbers && out.remove_numbers) {
    const rm = new Set(String(out.remove_numbers).match(/\d{1,3}/g).map(Number));
    if ((String(out.add_numbers).match(/\d{1,3}/g) || []).every(n => rm.has(+n))) delete out.add_numbers;
  }
  return out;
}
