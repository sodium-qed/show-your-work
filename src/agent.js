// Command box brain: instant rule reading, refined by the local model when it is loaded.
import { readRequest, reconcile } from './rules.js';

let worker = null;
let state = 'off'; // off | loading | ready | error
let device = null;
const listeners = new Set();
const pending = new Map();
let nextId = 1;

const emit = extra => { for (const fn of listeners) fn({ state, device, ...extra }); };
export const onAgentStatus = fn => { listeners.add(fn); fn({ state, device }); return () => listeners.delete(fn); };
export const agentReady = () => state === 'ready';

export const webgpuLikely = () => !!globalThis.navigator?.gpu;

export function loadAgent() {
  if (worker) return;
  state = 'loading'; emit({ loaded: 0, total: 0 });
  worker = new Worker(new URL('./agent-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') emit({ loaded: data.loaded, total: data.total });
    else if (data.type === 'ready') { state = 'ready'; device = data.device; emit(); }
    else if (data.type === 'result' || data.type === 'error') {
      const p = pending.get(data.id);
      if (data.type === 'error' && !p) { state = 'error'; emit({ message: data.message }); worker.terminate(); worker = null; }
      if (p) { pending.delete(data.id); data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data); }
    }
  };
  worker.onerror = e => { state = 'error'; emit({ message: e.message || 'The local model could not start.' }); worker = null; };
  let override = null;
  try { override = JSON.parse(localStorage.getItem('syw.model') || 'null'); } catch {}
  worker.postMessage({ type: 'load', override });
}

/**
 * Interpret a request.
 * @returns {{ fields, source: 'rules'|'model', raw? }}
 */
export async function interpret(text) {
  const quick = readRequest(text);
  if (state !== 'ready') return { fields: quick, source: 'rules' };
  const id = nextId++;
  try {
    const res = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ type: 'run', id, text }); });
    const proposal = Object.assign({}, ...res.calls.filter(c => c.name === 'update_worksheet').map(c => c.args || {}));
    return { fields: reconcile(text, proposal), source: 'model', raw: res.raw };
  } catch {
    return { fields: quick, source: 'rules' };
  }
}
