/** Only presentation settings are persisted. Source files and crops stay in memory. */
export const DEFAULT_SETTINGS = Object.freeze({
  title: 'Math practice',
  paper: 'letter',
  margin: 36,
  nameLine: true,
  alignment: 'center',
  numbering: false,
});

export const DEFAULT_PROBLEM = Object.freeze({
  space: 144,
  scale: 100,
  fit: 'flow',
  pageBreak: false,
});

const STORAGE_KEY = 'show-your-work.preferences.v1';
const VERSION = 1;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const defaults = () => ({ worksheet: { ...DEFAULT_SETTINGS }, problem: { ...DEFAULT_PROBLEM } });

/** Accept plain preferences or a version-1 envelope; return fresh whitelisted values. */
export function normalizePreferences(value) {
  const result = defaults();
  try {
    if (!isRecord(value) || (Object.hasOwn(value, 'version') && value.version !== VERSION)) return result;
    const worksheet = own(value, 'worksheet');
    const problem = own(value, 'problem');
    const title = own(worksheet, 'title');
    result.worksheet = {
      title: typeof title === 'string' ? title.slice(0, 90) : DEFAULT_SETTINGS.title,
      paper: oneOf(own(worksheet, 'paper'), ['letter', 'a4'], DEFAULT_SETTINGS.paper),
      margin: oneOf(own(worksheet, 'margin'), [36, 54, 72], DEFAULT_SETTINGS.margin),
      nameLine: boolean(own(worksheet, 'nameLine'), DEFAULT_SETTINGS.nameLine),
      alignment: oneOf(own(worksheet, 'alignment'), ['center', 'left'], DEFAULT_SETTINGS.alignment),
      numbering: boolean(own(worksheet, 'numbering'), DEFAULT_SETTINGS.numbering),
    };
    result.problem = {
      space: bounded(own(problem, 'space'), 0, 720, DEFAULT_PROBLEM.space),
      scale: bounded(own(problem, 'scale'), 25, 200, DEFAULT_PROBLEM.scale),
      fit: oneOf(own(problem, 'fit'), ['flow', 'shrink'], DEFAULT_PROBLEM.fit),
      pageBreak: boolean(own(problem, 'pageBreak'), DEFAULT_PROBLEM.pageBreak),
    };
    return result;
  } catch {
    // Malformed objects (including throwing getters) must not break startup.
    return defaults();
  }
}

export function loadPreferences(storage) {
  try {
    // Some browsers deny access to the localStorage getter itself.
    const target = storage === undefined ? globalThis.localStorage : storage;
    const raw = target?.getItem(STORAGE_KEY);
    if (typeof raw !== 'string') return defaults();
    const value = JSON.parse(raw);
    if (!isRecord(value) || value.version !== VERSION) return defaults();
    return normalizePreferences(value);
  } catch {
    return defaults();
  }
}

export function savePreferences(preferences, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target || typeof target.setItem !== 'function') return false;
    target.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...normalizePreferences(preferences) }));
    return true;
  } catch {
    return false;
  }
}
