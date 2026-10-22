// Parse problem-number lists: "11, 13, 15-21 odd", "41–56 even", "第23题和第25题", "23 & 25".

const NUM = '\\d{1,3}';

/** @returns {number[]} sorted unique numbers */
export function parseNumbers(input, available = null) {
  if (input == null) return [];
  let text = String(input).normalize('NFKC')
    .replace(/[，、；;]/g, ',')
    .replace(/\b(?:and|plus)\b|&|和|与|及|还有|以及/gi, ',')
    .replace(/\b(?:through|thru|to)\b|至|到|~/gi, '-')
    .replace(/[–—−]/g, '-')
    .replace(/第|题|號|号|problems?|questions?|exercises?|#|no\./gi, ' ');
  const out = new Set();
  // Split into chunks; a parity word applies to the range just before it (or after "odd 1-9").
  const chunks = text.split(',');
  for (let chunk of chunks) {
    chunk = chunk.trim();
    if (!chunk) continue;
    const parity = /\b(odd|奇数|单数)\b|奇数|单数/i.test(chunk) ? 1 : /\b(even)\b|偶数|双数/i.test(chunk) ? 0 : null;
    const ranges = [...chunk.matchAll(new RegExp(`(?<![\\d.])(${NUM})\\s*-\\s*(${NUM})(?!\\d|\\.\\d)`, 'g'))];
    let rest = chunk;
    for (const r of ranges) {
      let a = +r[1], b = +r[2];
      if (a > b) [a, b] = [b, a];
      rest = rest.replace(r[0], ' ');
      for (let n = a; n <= b; n++) if (parity == null || n % 2 === parity) out.add(n);
    }
    for (const m of rest.matchAll(new RegExp(`(?<![\\d.])(${NUM})(?!\\d|\\.\\d)`, 'g'))) {
      const n = +m[1];
      if (parity == null || n % 2 === parity) out.add(n);
    }
  }
  let list = [...out].sort((a, b) => a - b);
  if (available) list = list.filter(n => available.has(n));
  return list;
}

/** Compact display: [11,13,15,16,17] → "11, 13, 15–17" */
export function formatNumbers(list) {
  const s = [...new Set(list)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j - i >= 2 ? `${s[i]}–${s[j]}` : j > i ? `${s[i]}, ${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.join(', ');
}
