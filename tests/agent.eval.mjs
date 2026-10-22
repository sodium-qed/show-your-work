// Scores the request box on 28 requests (English + Chinese, including paraphrases).
//   node tests/agent.eval.mjs rules                      # rule reader only, instant
//   npm i --no-save @huggingface/transformers@4.3.1      # once, for model runs
//   node tests/agent.eval.mjs                            # Qwen3.5-0.8B on CPU, a few minutes
//   node tests/agent.eval.mjs <onnx-community/model> q4  # compare another model
// A case passes only when the final fields match exactly (nothing extra).
import { reconcile, readRequest } from '../src/rules.js';
import { parseNumbers } from '../src/numbers.js';
import { MODEL_ID, TOOLS, systemPrompt, parseToolCalls } from '../src/agent-prompt.js';

const [modelId = MODEL_ID, dtype = 'q4'] = process.argv.slice(2);
const CASES = [
  ['请帮我把所有绿色的问题全部都提取出来，制作成一个数学考试风格的题目，在一个 PDF 上面，就是白纸上打印出来。题目要留出一定空间给我当过程，完全考试风格，不要浪费空间，紧凑一些。一页double side。不要加那种什么 "School Math" 或者什么 "Good PDF" 那种上面的那些莫名其妙的 text。只要题目不要有任何那种名字什么那种垃圾东西。', { highlight_color: 'green', pages: 2, space: 'compact' }],
  ['extract the green ones', { highlight_color: 'green' }],
  ['do 11, 13, and 41-45 odd', { add: [11, 13, 41, 43, 45] }],
  ['只要第23题和第25题', { add: [23, 25] }],
  ['remove 47', { remove: [47] }],
  ['make it fit on one page', { pages: 1 }],
  ['two columns, lots of room to work', { columns: 2, space: 'large' }],
  ['give me polar grids for the plotting problems', { graph: 'polar' }],
  ['all the green problems, front and back, no directions', { highlight_color: 'green', pages: 2, directions: false }],
  ['start over', { clear: true }],
  ['A4 paper please', { paper: 'a4' }],
  ['把黄色的题目做成两页', { highlight_color: 'yellow', pages: 2 }],
  ['problems 57 through 67 odd, compact', { add: [57, 59, 61, 63, 65, 67], space: 'compact' }],
  ['不要35题', { remove: [35] }],
  ['highlighted problems only, 3 per row', { highlight_color: 'any', columns: 3 }],
  // Paraphrases the rules don't anticipate.
  ['I only want the stuff I marked in green', { highlight_color: 'green' }],
  ['squeeze everything onto a single side', { pages: 1 }],
  ['get rid of number 47 and 49', { remove: [47, 49] }],
  ['put three problems on each line', { columns: 3 }],
  ['make it two-sided', { pages: 2 }],
  ['print it on European paper', { paper: 'a4' }],
  ['skip the instructions', { directions: false }],
  ['redo everything with just the yellow ones', { clear: true, highlight_color: 'yellow' }],
  ['我只要黄色的，不要说明', { highlight_color: 'yellow', directions: false }],
  ['把每行放三道题', { columns: 3 }],
  ['题目之间多留点空', { space: 'large' }],
  ['no room needed, just list the questions', { space: 'none' }],
  ['add 5, 7 and 9 too', { add: [5, 7, 9] }],
];

function normalize(f) {
  const o = { ...f };
  if (o.add_numbers) { o.add = parseNumbers(o.add_numbers); delete o.add_numbers; }
  if (o.remove_numbers) { o.remove = parseNumbers(o.remove_numbers); delete o.remove_numbers; }
  return o;
}
const same = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]));

let tokenizer, model;
if (modelId !== 'rules') {
  const { AutoTokenizer, AutoModelForCausalLM } = await import('@huggingface/transformers');
  tokenizer = await AutoTokenizer.from_pretrained(modelId);
  model = await AutoModelForCausalLM.from_pretrained(modelId, { dtype });
}
let pass = 0, raw = 0;
for (const [prompt, want] of CASES) {
  let proposal = {};
  let ms = 0;
  if (model) {
    const messages = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: prompt }];
    const inputs = tokenizer.apply_chat_template(messages, { tools: TOOLS, add_generation_prompt: true, return_dict: true, enable_thinking: false });
    const eos = [tokenizer.convert_tokens_to_ids('<|im_end|>'), model.generation_config?.eos_token_id].flat().filter(Number.isInteger);
    const s = Date.now();
    const out = await model.generate({ ...inputs, max_new_tokens: 100, do_sample: false, eos_token_id: eos });
    ms = Date.now() - s;
    const text = tokenizer.decode(out.slice(null, [inputs.input_ids.dims.at(-1), null])[0], { skip_special_tokens: false });
    proposal = Object.assign({}, ...parseToolCalls(text).map(c => c.args));
  }
  const got = normalize(model ? reconcile(prompt, proposal) : readRequest(prompt));
  const ok = same(got, want);
  if (model && same(normalize(proposal), want)) raw++;
  pass += ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${(ms / 1000).toFixed(1)}s | ${prompt.slice(0, 45).padEnd(45)} => ${JSON.stringify(got)}${ok ? '' : '   want ' + JSON.stringify(want) + (model ? '   model ' + JSON.stringify(proposal) : '')}`);
}
console.log(`\n${modelId}: reconciled ${pass}/${CASES.length}${model ? `, raw model exact ${raw}/${CASES.length}` : ''}`);
