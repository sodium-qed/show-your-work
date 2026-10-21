// Deterministic reading of a request (English + Chinese). Two jobs:
//  1. instant answer before / without the local model;
//  2. evidence check: a field the model proposes is kept only if the request
//     actually talks about that kind of thing (small models like to fill every field).

const COLORS = {
  green: /green|绿/i, yellow: /yellow|黄/i, pink: /pink|粉|magenta/i, blue: /blue|蓝|cyan|青/i,
  orange: /orange|橙|橘/i, purple: /purple|violet|紫/i, red: /\bred\b|红/i,
};
const EVIDENCE = {
  highlight_color: /highlight|marked|circled|colou?r|标|圈|画|高亮|荧光|颜色|green|yellow|pink|blue|orange|purple|violet|\bred\b|绿|黄|粉|蓝|橙|紫|红/i,
  add_numbers: /\d/,
  remove_numbers: /remove|drop|skip|without|delete|exclude|except|not\b|don'?t|no\s+\d|minus|rid of|take out|cut|leave out|omit|不要|去掉|删|除了|拿掉|别/i,
  clear: /start over|clear|reset|from scratch|empty|redo|instead|重新|清空|重置|全部删|换成/i,
  pages: /page|side|sheet|front|back|duplex|页|张|面/i,
  columns: /column|row|line|across|side by side|列|行|栏/i,
  space: /space|room|compact|tight|exam|test|waste|cram|spacious|紧凑|空间|考试|空白|浪费|地方|留|宽松/i,
  directions: /direction|instruction|prompt|heading|说明|题干|指示|要求/i,
  paper: /a4|letter|paper|europe|纸/i,
  graph: /graph|grid|polar|axes|axis|plot|坐标|网格|极坐标/i,
};

export const hasEvidence = (field, text) => EVIDENCE[field]?.test(text) ?? false;

export function colorIn(text) {
  for (const [name, re] of Object.entries(COLORS)) if (re.test(text)) return name;
  return null;
}

/** Best-effort parse. Returns the same fields as the model's update_worksheet call. */
export function readRequest(text) {
  const t = text.trim();
  const out = {};
  const color = colorIn(t);
  if (color) out.highlight_color = color;
  else if (/highlight|marked|circled|高亮|标记|圈/i.test(t)) out.highlight_color = 'any';

  if (EVIDENCE.clear.test(t)) out.clear = true;

  // Numbers: separate "remove ..." clauses from additions. Ignore page/column counts.
  const stripped = t
    .replace(/(\d+)\s*(?:pages?|sides?|sheets?|columns?|per row|页|张|列|栏|in a row)/gi, ' ')
    .replace(/(?:a4|letter)/gi, ' ');
  const removeRe = /(?:remove|drop|skip|without|delete|exclude|except|minus|get rid of|rid of|take out|leave out|omit|cut|不要|去掉|删掉|删除|除了|拿掉|别要)\s*((?:第?\s*\d{1,3}\s*(?:题|号)?\s*(?:[-–—~,，、&和与及]|and|to|through|odd|even|奇数|偶数|\s)*)+)/gi;
  const removed = [];
  let adds = stripped.replace(removeRe, (_, nums) => { removed.push(nums); return ' '; });
  if (removed.length) out.remove_numbers = removed.join(', ');
  const addNums = adds.match(/(?:第\s*)?\d{1,3}(?:\s*(?:题|号))?(?:\s*(?:[-–—~,，、&和与及]|\band\b|\bto\b|\bthrough\b|\bthru\b|至|到)\s*(?:第\s*)?\d{1,3}(?:\s*(?:题|号))?)*(?:\s*(?:odd|even|奇数|偶数))?/gi);
  if (addNums) {
    const cleaned = addNums.filter(s => /\d/.test(s)).join(', ');
    if (cleaned) out.add_numbers = cleaned;
  }

  // Pages.
  if (/double[- ]?sid|front and back|both sides|duplex|one sheet|1 sheet|双面|正反/i.test(t)) out.pages = 2;
  else {
    const m = t.match(/(\d+|one|two|three|four|一|两|二|三|四)\s*(?:pages?|sides?|页|张)/i);
    if (m) out.pages = ({ one: 1, two: 2, three: 3, four: 4, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 })[m[1].toLowerCase()] || +m[1];
    else if (/single page|one page|一页/i.test(t)) out.pages = 1;
  }
  const cols = t.match(/(\d|one|two|three|一|两|二|三)\s*(?:columns?|per row|in a row|across|列|栏)|每行\s*(\d|一|两|二|三)/i);
  if (cols) { const v = cols[1] || cols[2]; out.columns = ({ one: 1, two: 2, three: 3, 一: 1, 两: 2, 二: 2, 三: 3 })[v.toLowerCase()] || +v; }

  if (/no (?:work )?space|without space|just the problems|不留空|不要空/i.test(t)) out.space = 'none';
  else if (/lots of|more (?:space|room)|plenty|big space|spacious|宽松|多留|大量/i.test(t)) out.space = 'large';
  else if (/a little|some room|small space|少留|一点/i.test(t)) out.space = 'small';
  else if (/compact|tight|exam|test style|don'?t waste|no wasted|cram|fill|紧凑|考试|不要浪费|留出|留空间|过程/i.test(t)) out.space = 'fill';

  if (/no (?:directions|instructions)|without (?:directions|instructions)|hide (?:directions|instructions)|不要(?:说明|题干|指示)/i.test(t)) out.directions = false;
  else if (/(?:keep|show|with|include) (?:the )?(?:directions|instructions)|保留(?:说明|题干)/i.test(t)) out.directions = true;

  if (/\ba4\b/i.test(t)) out.paper = 'a4';
  else if (/\bletter\b|us letter/i.test(t)) out.paper = 'letter';

  if (/no (?:graph|grid)s?|不要(?:坐标|网格)/i.test(t)) out.graph = 'none';
  else if (/polar|极坐标/i.test(t)) out.graph = 'polar';
  else if (/graph paper|grid|coordinate plane|xy|坐标纸|网格/i.test(t)) out.graph = 'xy';
  return out;
}

const VALID = {
  highlight_color: v => typeof v === 'string' && /^(any|green|yellow|pink|blue|orange|purple|red)$/i.test(v.trim()),
  add_numbers: v => /\d/.test(String(v)),
  remove_numbers: v => /\d/.test(String(v)),
  clear: v => v === true,
  pages: v => Number.isInteger(+v) && +v >= 1 && +v <= 20,
  columns: v => Number.isInteger(+v) && +v >= 1 && +v <= 3,
  space: v => ['none', 'small', 'medium', 'large', 'fill'].includes(v),
  directions: v => typeof v === 'boolean',
  paper: v => ['letter', 'a4'].includes(v),
  graph: v => ['polar', 'xy', 'none'].includes(v),
};

/**
 * Combine a model proposal with the request text: keep only valid, evidenced fields;
 * numbers must literally appear in the request; fill gaps from the rule reader.
 */
export function reconcile(text, proposal = {}) {
  const rules = readRequest(text);
  const out = {};
  const digits = new Set((text.match(/\d{1,3}/g) || []).map(Number));
  for (const [k, raw] of Object.entries(proposal || {})) {
    let v = raw;
    if (k === 'pages' || k === 'columns') v = +v;
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
      const nums = String(v).match(/\d{1,3}/g) || [];
      if (!nums.every(n => digits.has(+n))) { if (rules[k]) v = rules[k]; else continue; }
    }
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
