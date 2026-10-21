// Runs the small local model off the main thread. Weights download once and stay in the browser cache.
import { AutoTokenizer, AutoModelForCausalLM, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
import { MODEL_ID, TOOLS, systemPrompt, parseToolCalls } from './agent-prompt.js';

env.allowLocalModels = false;
let tokenizer, model, device;

async function load(override) {
  if (model) return;
  let gpu = false;
  try { gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch {}
  device = gpu ? 'webgpu' : 'wasm';
  const files = new Map();
  const progress_callback = p => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      self.postMessage({ type: 'progress', loaded, total });
    }
  };
  // A test hook (localStorage syw.model) can swap in another model to exercise the plumbing.
  const id = override?.id || MODEL_ID;
  if (!gpu && !override) throw new Error('Local AI needs WebGPU (Chrome or Edge on a computer, or Safari 26+). Requests still work without it.');
  tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback });
  if (override) {
    device = override.device || device;
    model = await AutoModelForCausalLM.from_pretrained(id, { dtype: override.dtype, device, progress_callback });
    return;
  }
  // The 4-bit build (~470 MB) needs WebGPU: the CPU (WASM) runtime has no kernel for its
  // quantized embedding lookup. Without WebGPU the app keeps using the rule reader.
  model = await AutoModelForCausalLM.from_pretrained(id, { dtype: 'q4f16', device: 'webgpu', progress_callback });
}

async function run(text) {
  const messages = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: text }];
  const inputs = tokenizer.apply_chat_template(messages, { tools: TOOLS, add_generation_prompt: true, return_dict: true, enable_thinking: false });
  const eos = [tokenizer.convert_tokens_to_ids('<|im_end|>'), model.generation_config?.eos_token_id].flat().filter(Number.isInteger);
  const out = await model.generate({ ...inputs, max_new_tokens: 90, do_sample: false, eos_token_id: eos });
  const raw = tokenizer.decode(out.slice(null, [inputs.input_ids.dims.at(-1), null])[0], { skip_special_tokens: false });
  return { raw, calls: parseToolCalls(raw) };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') { await load(data.override); self.postMessage({ type: 'ready', device }); }
    if (data.type === 'run') { const r = await run(data.text); self.postMessage({ type: 'result', id: data.id, ...r }); }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error?.message || String(error) });
  }
};
