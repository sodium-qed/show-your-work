import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, DEFAULT_PROBLEM, normalizePreferences, loadPreferences, savePreferences } from '../src/preferences.js';

const KEY = 'show-your-work.preferences.v1';
const expectedDefaults = () => ({
  worksheet: { title: 'Math practice', paper: 'letter', margin: 36, nameLine: true, alignment: 'center', numbering: false, spacing: 'balanced' },
  problem: { space: 144, scale: 100, fit: 'flow', pageBreak: false },
});
function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[KEY, initial]]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function withGlobalStorage(descriptor, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  try { return callback(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('defaults are immutable and every result has independent mutable settings', () => {
  assert.deepEqual(DEFAULT_SETTINGS, expectedDefaults().worksheet);
  assert.deepEqual(DEFAULT_PROBLEM, expectedDefaults().problem);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_PROBLEM));
  const first = loadPreferences(memoryStorage()), second = normalizePreferences();
  first.worksheet.title = 'Changed';
  first.problem.space = 0;
  assert.deepEqual(second, expectedDefaults());
  assert.deepEqual(loadPreferences(memoryStorage()), expectedDefaults());
  assert.notEqual(first.worksheet, DEFAULT_SETTINGS);
  assert.notEqual(first.problem, DEFAULT_PROBLEM);
});

test('round-trips validated settings in a versioned envelope under the required key', () => {
  const storage = memoryStorage();
  const preferences = {
    worksheet: { title: 'Algebra review', paper: 'a4', margin: 54, nameLine: false, alignment: 'left', numbering: true, spacing: 'compact' },
    problem: { space: 216.5, scale: 85, fit: 'shrink', pageBreak: true },
  };
  assert.equal(savePreferences(preferences, storage), true);
  assert.deepEqual([...storage.values.keys()], [KEY]);
  assert.deepEqual(JSON.parse(storage.values.get(KEY)), { version: 1, ...preferences });
  assert.deepEqual(loadPreferences(storage), preferences);
  const loaded = loadPreferences(storage);
  loaded.worksheet.title = 'Edited later';
  loaded.problem.scale = 200;
  assert.deepEqual(loadPreferences(storage), preferences);
});

test('normalization clamps numeric bounds, limits title length, and validates enums', () => {
  const normalized = normalizePreferences({
    worksheet: { title: 'A'.repeat(120), paper: 'legal', margin: 37, nameLine: 'false', alignment: 'right' },
    problem: { space: -10, scale: 300, fit: 'crop', pageBreak: 1 },
  });
  assert.deepEqual(normalized, {
    worksheet: { ...expectedDefaults().worksheet, title: 'A'.repeat(90) },
    problem: { ...expectedDefaults().problem, space: 0, scale: 200 },
  });
  assert.deepEqual(normalizePreferences({ problem: { space: 900, scale: 0 } }).problem,
    { ...expectedDefaults().problem, space: 720, scale: 25 });
});

test('preserves valid zero, empty title, false booleans, and supported boundary choices', () => {
  const value = {
    worksheet: { title: '', paper: 'a4', margin: 72, nameLine: false, alignment: 'left', numbering: false, spacing: 'balanced' },
    problem: { space: 0, scale: 25, fit: 'flow', pageBreak: false },
  };
  assert.deepEqual(normalizePreferences(value), value);
  assert.deepEqual(normalizePreferences({ worksheet: { margin: 36 }, problem: { space: 720, scale: 200 } }), {
    worksheet: expectedDefaults().worksheet,
    problem: { ...expectedDefaults().problem, space: 720, scale: 200 },
  });
});

test('does not coerce strings, booleans, non-finite numbers, or invalid sections', () => {
  for (const invalid of [undefined, null, false, 0, 'settings', [], { worksheet: [], problem: null }]) {
    assert.deepEqual(normalizePreferences(invalid), expectedDefaults());
  }
  for (const invalidNumber of ['54', true, null, NaN, Infinity, -Infinity]) {
    assert.deepEqual(normalizePreferences({
      worksheet: { title: 123, margin: invalidNumber, nameLine: 0 },
      problem: { space: invalidNumber, scale: invalidNumber, pageBreak: 'true' },
    }), expectedDefaults());
  }
});

test('whitelists settings so source files, crops, and unknown data are never serialized', () => {
  const storage = memoryStorage();
  const privateData = { documentBytes: 'DO NOT STORE', fileName: 'private.pdf' };
  assert.equal(savePreferences({
    worksheet: { title: 'Review', files: privateData, documents: privateData },
    problem: { space: 72, regions: [privateData], text: 'DO NOT STORE', id: 'hidden-id' },
    documents: [privateData], sources: [privateData], userFiles: [privateData], extra: privateData,
  }, storage), true);
  const serialized = storage.values.get(KEY);
  assert.ok(!serialized.includes('DO NOT STORE'));
  assert.ok(!serialized.includes('private.pdf'));
  assert.deepEqual(JSON.parse(serialized), {
    version: 1,
    worksheet: { ...expectedDefaults().worksheet, title: 'Review' },
    problem: { ...expectedDefaults().problem, space: 72 },
  });
});

test('missing, corrupt, malformed, and incompatible stored envelopes fall back safely', () => {
  for (const raw of [undefined, '', '{broken', 'null', '[]', '42', '"settings"', '{}',
    JSON.stringify({ worksheet: { title: 'No version' } }),
    JSON.stringify({ version: 0, worksheet: { title: 'Old' } }),
    JSON.stringify({ version: 2, worksheet: { title: 'Future' } }),
    JSON.stringify({ version: '1', worksheet: { title: 'Wrong type' } }),
    JSON.stringify({ version: 1, worksheet: [], problem: 'invalid' })]) {
    assert.deepEqual(loadPreferences(memoryStorage(raw)), expectedDefaults(), `stored value: ${raw}`);
  }
  assert.deepEqual(normalizePreferences({ version: 2, worksheet: { title: 'Future' } }), expectedDefaults());
});

test('numbering persists strict booleans and old version-1 settings keep it disabled', () => {
  const storage = memoryStorage();
  for (const numbering of [true, false]) {
    assert.equal(savePreferences({ worksheet: { numbering } }, storage), true);
    assert.equal(JSON.parse(storage.values.get(KEY)).worksheet.numbering, numbering);
    assert.equal(loadPreferences(storage).worksheet.numbering, numbering);
  }
  for (const numbering of ['true', 'false', 1, 0, null]) {
    assert.equal(normalizePreferences({ worksheet: { numbering } }).worksheet.numbering, false);
  }
  const oldPreferences = {
    worksheet: { title: 'Saved algebra', paper: 'a4', margin: 54, nameLine: false, alignment: 'left' },
    problem: { space: 216, scale: 85, fit: 'shrink', pageBreak: true },
  };
  const oldStorage = memoryStorage(JSON.stringify({ version: 1, ...oldPreferences }));
  assert.deepEqual(loadPreferences(oldStorage), {
    ...oldPreferences,
    worksheet: { ...oldPreferences.worksheet, numbering: false, spacing: 'balanced' },
  });
});

test('page spacing persists only supported modes and reset restores balanced spacing', () => {
  const storage = memoryStorage();
  for (const spacing of ['compact', 'balanced']) {
    assert.equal(savePreferences({ worksheet: { spacing } }, storage), true);
    assert.equal(JSON.parse(storage.values.get(KEY)).worksheet.spacing, spacing);
    assert.equal(loadPreferences(storage).worksheet.spacing, spacing);
  }
  for (const spacing of ['Balanced', 'wide', '', true, 1, null, ['compact']]) {
    assert.equal(normalizePreferences({ worksheet: { spacing } }).worksheet.spacing, 'balanced');
  }
  assert.equal(savePreferences({ worksheet: { spacing: 'compact', numbering: true } }, storage), true);
  assert.equal(savePreferences({ worksheet: DEFAULT_SETTINGS, problem: DEFAULT_PROBLEM }, storage), true);
  assert.deepEqual(loadPreferences(storage), expectedDefaults());
});

test('existing version-1 preferences gain balanced spacing without losing saved settings', () => {
  const oldPreferences = {
    worksheet: { title: 'Saved practice', paper: 'a4', margin: 72, nameLine: false, alignment: 'left', numbering: true },
    problem: { space: 108, scale: 125, fit: 'shrink', pageBreak: true },
  };
  const storage = memoryStorage(JSON.stringify({ version: 1, ...oldPreferences }));
  const migrated = loadPreferences(storage);
  assert.deepEqual(migrated, {
    ...oldPreferences,
    worksheet: { ...oldPreferences.worksheet, spacing: 'balanced' },
  });
  assert.equal(savePreferences(migrated, storage), true);
  assert.deepEqual([...storage.values.keys()], [KEY]);
  assert.equal(JSON.parse(storage.values.get(KEY)).version, 1);
  assert.deepEqual(loadPreferences(storage), migrated);
});

test('denied reads and writes, quota errors, and unusable storage never escape', () => {
  const denied = {
    getItem() { throw new Error('Storage access denied'); },
    setItem() { throw new Error('Quota exceeded'); },
  };
  assert.deepEqual(loadPreferences(denied), expectedDefaults());
  assert.equal(savePreferences(expectedDefaults(), denied), false);
  for (const storage of [null, {}, { getItem: true, setItem: true }]) {
    assert.deepEqual(loadPreferences(storage), expectedDefaults());
    assert.equal(savePreferences(expectedDefaults(), storage), false);
  }
});

test('a denied global localStorage getter is handled inside the helper', () => {
  withGlobalStorage({ get() { throw new Error('Origin cannot access storage'); } }, () => {
    assert.deepEqual(loadPreferences(), expectedDefaults());
    assert.equal(savePreferences(expectedDefaults()), false);
  });
});

test('omitted storage uses the browser storage object when available', () => {
  const storage = memoryStorage();
  withGlobalStorage({ value: storage }, () => {
    assert.equal(savePreferences({ worksheet: { paper: 'a4' } }), true);
    assert.equal(loadPreferences().worksheet.paper, 'a4');
  });
});

test('inherited values and throwing getters cannot contaminate normalized preferences', () => {
  const worksheet = Object.create({ title: 'Inherited', paper: 'a4' });
  const problem = Object.create({ space: 720, pageBreak: true });
  assert.deepEqual(normalizePreferences({ worksheet, problem }), expectedDefaults());
  assert.deepEqual(normalizePreferences({ get worksheet() { throw new Error('Bad getter'); } }), expectedDefaults());
});
