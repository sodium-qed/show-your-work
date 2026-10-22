// Command box brain: instant rule reading, refined by the local model when it is loaded.
import { readRequest, readNumberSelection, reconcile } from './rules.js';

let worker = null;
let state = 'off'; // off | loading | ready | error
let device = null;
const listeners = new Set();
const pending = new Map();
let nextId = 1;
let loadIdleTimer = null;
let loadLimitTimer = null;

// A failed or stalled optional model must never trap the Apply button. Loading
// allows a large download; progress extends only the inactivity deadline.
const RUN_TIMEOUT = 30_000;
const LOAD_IDLE_TIMEOUT = 180_000;
const LOAD_LIMIT = 30 * 60_000;
const later = (fn, ms) => { const timer = setTimeout(fn, ms); timer?.unref?.(); return timer; };

function clearLoadTimers() {
  clearTimeout(loadIdleTimer); clearTimeout(loadLimitTimer);
  loadIdleTimer = loadLimitTimer = null;
}

function stopWorker(target, message) {
  if (worker !== target) return;
  clearLoadTimers();
  worker = null; state = 'error'; device = null;
  target?.terminate();
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
  emit({ message });
}

function watchLoad(target) {
  clearTimeout(loadIdleTimer);
  loadIdleTimer = later(() => stopWorker(target, 'Local AI stopped loading. Requests still work; retry the download when ready.'), LOAD_IDLE_TIMEOUT);
}

// Preserve standalone problem lists immediately, even when the optional model is ready.
export const isExplicitNumberList = text => readNumberSelection(text) !== null;

const emit = extra => { for (const fn of listeners) fn({ state, device, ...extra }); };
export const onAgentStatus = fn => { listeners.add(fn); fn({ state, device }); return () => listeners.delete(fn); };
export const agentReady = () => state === 'ready';

export const webgpuLikely = () => !!globalThis.navigator?.gpu;

export function loadAgent() {
  if (worker) return;
  state = 'loading'; emit({ loaded: 0, total: 0 });
  let current;
  try { current = worker = new Worker(new URL('./agent-worker.js', import.meta.url), { type: 'module' }); }
  catch (error) { stopWorker(worker, error.message || 'The local model could not start.'); return; }
  watchLoad(current);
  loadLimitTimer = later(() => stopWorker(current, 'Local AI took too long to load. Requests still work; retry when ready.'), LOAD_LIMIT);
  let loaded = -1;
  current.onmessage = ({ data }) => {
    // Events queued by a terminated worker cannot affect a fresh retry.
    if (worker !== current || !data || typeof data !== 'object') return;
    if (data.type === 'progress' && state === 'loading') {
      if (Number.isFinite(data.loaded) && data.loaded > loaded) { loaded = data.loaded; watchLoad(current); }
      emit({ loaded: data.loaded, total: data.total });
    }
    else if (data.type === 'ready' && state === 'loading') { clearLoadTimers(); state = 'ready'; device = data.device; emit(); }
    else if (data.type === 'result' || data.type === 'error') {
      const p = pending.get(data.id);
      if (data.type === 'error' && data.id == null) { stopWorker(current, data.message || 'The local model could not start.'); return; }
      // A late response to an already settled request is harmless.
      if (p) { pending.delete(data.id); clearTimeout(p.timer); data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data); }
    }
  };
  current.onerror = e => { e.preventDefault?.(); stopWorker(current, e.message || 'The local model stopped unexpectedly. Requests still work.'); };
  current.onmessageerror = () => stopWorker(current, 'The local model returned unreadable data. Requests still work.');
  let override = null;
  try { override = JSON.parse(localStorage.getItem('syw.model') || 'null'); } catch {}
  try { current.postMessage({ type: 'load', override }); }
  catch (error) { stopWorker(current, error.message || 'The local model could not start.'); }
}

/**
 * Interpret a request.
 * @returns {{ fields, source: 'rules'|'model', raw? }}
 */
export async function interpret(text) {
  const quick = readRequest(text);
  if (state !== 'ready' || !worker || isExplicitNumberList(text)) return { fields: quick, source: 'rules' };
  const id = nextId++;
  const current = worker;
  try {
    const res = await new Promise((resolve, reject) => {
      const timer = later(() => stopWorker(current, 'Local AI took too long. The request was read without it; retry Local AI when ready.'), RUN_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      try { current.postMessage({ type: 'run', id, text }); }
      catch (error) { stopWorker(current, error.message || 'The local model could not read the request.'); }
    });
    const proposal = Object.assign({}, ...res.calls.filter(c => c.name === 'update_worksheet').map(c => c.args || {}));
    return { fields: reconcile(text, proposal), source: 'model', raw: res.raw };
  } catch {
    return { fields: quick, source: 'rules' };
  }
}
