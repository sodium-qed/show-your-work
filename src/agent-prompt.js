// The local model's tool and instructions, plus a tolerant parser for its tool calls.
// Shared by the browser worker and the Node eval (tests/agent.eval.mjs).

export const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-Text-ONNX';

export const TOOLS = [
  { type: 'function', function: { name: 'update_worksheet', description: 'Change the worksheet. Include ONLY the fields the user asked about.', parameters: { type: 'object', properties: {
    highlight_color: { type: 'string', enum: ['green', 'yellow', 'pink', 'blue', 'orange', 'purple', 'red', 'any'], description: 'select problems marked in this color' },
    add_numbers: { type: 'string', description: 'problem numbers to add, copied from the request' },
    remove_numbers: { type: 'string', description: 'problem numbers to take out, copied from the request' },
    clear: { type: 'boolean', description: 'empty the selection first' },
    pages: { type: 'integer', description: 'printed sides' },
    columns: { type: 'integer', description: 'problems per row' },
    space: { type: 'string', enum: ['none', 'small', 'large', 'fill'], description: 'writing room' },
    directions: { type: 'boolean', description: 'print instruction sentences' },
    paper: { type: 'string', enum: ['letter', 'a4'] },
    graph: { type: 'string', enum: ['polar', 'xy', 'none'] },
  } } } },
];

export function systemPrompt() {
  return `You are the command reader of a worksheet app. Read the student's request and call update_worksheet once.
Most requests change one or two things. Include ONLY fields the request clearly asks for. Never add a field just because it exists. Never invent problem numbers: copy digits that appear in the request.

Meaning of words:
- color words (绿 green, 黄 yellow, 粉 pink, 蓝 blue, 橙 orange, 紫 purple, 红 red) -> highlight_color. "highlighted/marked" without a color -> "any".
- remove, get rid of, drop, skip, 不要, 去掉 + numbers -> remove_numbers. Other numbers -> add_numbers.
- start over, redo, instead, 重新 -> clear true.
- one page, single side -> pages 1. double-sided, two-sided, front and back, 双面 -> pages 2.
- N per row, N on each line, N columns, 每行N -> columns N (三 = 3, 两 = 2).
- compact, exam style, don't waste space, 紧凑 -> space "fill". more/lots of room, 多留 -> "large". no room, just list -> "none".
- skip/hide/no instructions or directions, 不要说明 -> directions false.
- European or international paper -> paper "a4". American paper -> "letter".
- polar grid -> graph "polar". graph paper, coordinate grid -> "xy".
- Titles, names, headers and logos are never printed: ignore them.

Examples:
User: only the blue ones please
Call: update_worksheet(highlight_color="blue")
User: take out 12
Call: update_worksheet(remove_numbers="12")
User: fit it on one side and give me more room
Call: update_worksheet(pages=1, space="large")
User: 两列，A4纸
Call: update_worksheet(columns=2, paper="a4")
User: drop the directions
Call: update_worksheet(directions=false)`;
}

// Accepts Qwen-style <tool_call>{json}</tool_call>, LFM pythonic [f(a=1)], or bare JSON.
export function parseToolCalls(text) {
  text = text.split(/<\|im_end\|>|<end_of_turn>|<\|endoftext\|>/)[0];
  const calls = [];
  for (const m of text.matchAll(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    const args = {};
    for (const a of m[2].matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) args[a[1]] = coerce(a[2]);
    calls.push({ name: m[1], args });
  }
  if (calls.length) return calls;
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try { const j = JSON.parse(m[1]); if (typeof j.arguments === 'string') j.arguments = JSON.parse(j.arguments); calls.push({ name: j.name, args: j.arguments || j.parameters || {} }); } catch {}
  }
  if (calls.length) return calls;
  let body = text;
  const lfm = text.match(/<\|tool_call_start\|>([\s\S]*?)(<\|tool_call_end\|>|$)/);
  if (lfm) body = lfm[1];
  body = body.trim();
  if (/^\[?\s*\{/.test(body)) {
    try { const j = JSON.parse(body.startsWith('[') ? body : `[${body}]`); return j.map(x => ({ name: x.name, args: x.arguments || x.parameters || {} })); } catch {}
  }
  for (const m of body.matchAll(/([a-z_]+)\(([^()]*)\)/g)) {
    const args = {};
    for (const a of m[2].matchAll(/(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/g)) {
      let v = a[2].trim();
      if (/^['"]/.test(v)) v = v.slice(1, -1);
      else if (v === 'True' || v === 'true') v = true;
      else if (v === 'False' || v === 'false') v = false;
      else if (/^-?\d+$/.test(v)) v = Number(v);
      args[a[1]] = v;
    }
    calls.push({ name: m[1], args });
  }
  return calls;
}

function coerce(v) {
  v = v.trim();
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}
