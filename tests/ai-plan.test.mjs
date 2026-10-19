import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PLAN_SCHEMA, AI_SYSTEM_PROMPT, validateAiPlan } from '../src/ai-plan.js';

const rect = () => ({ x: 0.1, y: 0.2, w: 0.7, h: 0.3 });
const textBlock = (text = '7. Explain the relationship.', source = 0) => ({ kind: 'text', source, rect: rect(), text });
const imageBlock = (source = 0) => ({ kind: 'image', source, rect: rect(), text: '' });
const plan = (blocks = [textBlock()], warnings = []) => ({ blocks, warnings });
const reject = (value, count = 1, message) => assert.throws(() => validateAiPlan(value, count), { name: 'TypeError' }, message);

test('accepts a mixed plan, preserves exact wording, and returns independent objects', () => {
  const input = plan([
    textBlock('7. “Use α,” then explain.\n\n(a) Keep the original label.'),
    imageBlock(), textBlock('Continue with the second source.', 1),
  ], ['Check the cut-off diagram label.']);
  const output = validateAiPlan(input, 2);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.blocks, input.blocks);
  assert.notEqual(output.blocks[0], input.blocks[0]);
  assert.notEqual(output.blocks[0].rect, input.blocks[0].rect);
  assert.notEqual(output.warnings, input.warnings);
  output.blocks[0].text = 'Changed';
  output.blocks[0].rect.x = 0;
  output.warnings.push('Added');
  assert.equal(input.blocks[0].rect.x, 0.1);
  assert.equal(input.warnings.length, 1);
  assert.ok(input.blocks[0].text.startsWith('7. “Use α,”'));
});

test('requires one to six supplied sources and valid zero-based integer references', () => {
  for (const count of [undefined, null, 0, -1, 7, 1.5, NaN, Infinity, '2', true]) assert.throws(() => validateAiPlan(plan(), count), TypeError);
  for (const source of [-1, 1, 0.5, NaN, Infinity, '0', false]) reject(plan([imageBlock(source)]));
  assert.deepEqual(validateAiPlan(plan([imageBlock(5)]), 6), plan([imageBlock(5)]));
  reject(plan([imageBlock(6)]), 6);
});

test('requires exactly the documented keys at every object level', () => {
  for (const key of ['blocks', 'warnings']) {
    const value = plan(); delete value[key]; reject(value);
  }
  for (const key of ['kind', 'source', 'rect', 'text']) {
    const value = plan(); delete value.blocks[0][key]; reject(value);
  }
  for (const key of ['x', 'y', 'w', 'h']) {
    const value = plan(); delete value.blocks[0].rect[key]; reject(value);
  }
  reject({ ...plan(), notes: 'Unexpected' });
  reject(plan([{ ...textBlock(), url: 'https://example.invalid/image.png' }]));
  reject(plan([{ ...imageBlock(), rect: { ...rect(), rotate: 90 } }]));
  reject(JSON.parse('{"blocks":[],"warnings":[],"__proto__":{"polluted":true}}'));
  reject(plan([{ ...textBlock(), kind: 'html' }]));
  for (const value of [null, false, '', [], 2]) reject(value);
  reject(plan([null]));
  reject(plan([{ ...imageBlock(), rect: [] }]));
});

test('requires ordinary JSON data and rejects getters, hidden keys, and inherited plans', () => {
  const getterPlan = { warnings: [] };
  Object.defineProperty(getterPlan, 'blocks', { enumerable: true, get() { assert.fail('getter must not execute'); } });
  reject(getterPlan);
  const hidden = plan(); Object.defineProperty(hidden, 'secret', { value: 'extra' }); reject(hidden);
  const symbol = plan(); symbol[Symbol('extra')] = true; reject(symbol);
  reject(Object.assign(Object.create({ extra: 'inherited' }), plan()));
  const withoutPrototype = Object.assign(Object.create(null), plan());
  assert.deepEqual(validateAiPlan(withoutPrototype, 1), plan());
});

test('requires nonempty dense block arrays and enforces the 24-block limit', () => {
  reject(plan([]));
  reject(plan('not an array'));
  reject(plan(new Array(2)));
  const extra = [imageBlock()]; extra.extra = 'unexpected'; reject(plan(extra));
  const getter = [imageBlock()]; Object.defineProperty(getter, '0', { get() { assert.fail('array getter must not execute'); } }); reject(plan(getter));
  assert.equal(validateAiPlan(plan(Array.from({ length: 24 }, () => imageBlock())), 1).blocks.length, 24);
  reject(plan(Array.from({ length: 25 }, () => imageBlock())));
});

test('rejects nonfinite, nonnumeric, negative, empty, and out-of-source rectangles', () => {
  for (const key of ['x', 'y', 'w', 'h']) for (const bad of [NaN, Infinity, -Infinity, '0.2', null, true]) {
    reject(plan([{ ...imageBlock(), rect: { ...rect(), [key]: bad } }]));
  }
  for (const bad of [
    { x: -0.01, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: -0.01, w: 0.5, h: 0.5 },
    { x: 0.8, y: 0, w: 0.3, h: 0.5 }, { x: 0, y: 0.8, w: 0.5, h: 0.3 },
    { x: 0, y: 0, w: 0, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: -0.1 },
    { x: 1, y: 0, w: 1e-10, h: 0.5 }, { x: 0, y: 1, w: 0.5, h: 1e-10 },
  ]) reject(plan([{ ...imageBlock(), rect: bad }]));
  assert.deepEqual(validateAiPlan(plan([{ ...imageBlock(), rect: { x: 0, y: 0, w: 1, h: 1 } }]), 1).blocks[0].rect,
    { x: 0, y: 0, w: 1, h: 1 });
});

test('clips only tiny floating boundary noise in the returned copy', () => {
  const input = plan([{ ...imageBlock(), rect: { x: -1e-10, y: -1e-10, w: 1 + 2e-10, h: 1 + 2e-10 } }]);
  const before = structuredClone(input);
  assert.deepEqual(validateAiPlan(input, 1).blocks[0].rect, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(input, before);
  reject(plan([{ ...imageBlock(), rect: { x: -1e-6, y: 0, w: 1, h: 1 } }]));
  reject(plan([{ ...imageBlock(), rect: { x: 0, y: 0, w: 1 + 1e-6, h: 1 } }]));
});

test('image text is exactly empty and prose must be a nonblank bounded string', () => {
  for (const text of [' ', 'equation', null, undefined, 0]) reject(plan([{ ...imageBlock(), text }]));
  for (const text of ['', ' \n\t ', null, undefined, 0, ['word'], 'a'.repeat(6001)]) reject(plan([{ ...textBlock(), text }]));
  assert.equal(validateAiPlan(plan([textBlock('a'.repeat(6000))]), 1).blocks[0].text.length, 6000);
  const padded = '  Original wording.\n';
  assert.equal(validateAiPlan(plan([textBlock(padded)]), 1).blocks[0].text, padded, 'validation does not trim source wording');
});

test('string bounds count Unicode code points consistently with JSON Schema', () => {
  const text = '𝑥'.repeat(6000);
  assert.equal(validateAiPlan(plan([textBlock(text)]), 1).blocks[0].text, text);
  reject(plan([textBlock(text + '𝑥')]));
  assert.equal(validateAiPlan(plan([imageBlock()], ['𝑥'.repeat(400)]), 1).warnings[0], '𝑥'.repeat(400));
  reject(plan([imageBlock()], ['𝑥'.repeat(401)]));
});

test('rejects total text over 16000 without truncating any content', () => {
  const valid = plan([textBlock('a'.repeat(6000)), textBlock('b'.repeat(6000)), textBlock('c'.repeat(4000))]);
  assert.deepEqual(validateAiPlan(valid, 1), valid);
  const invalid = structuredClone(valid); invalid.blocks[2].text += 'd';
  const before = structuredClone(invalid);
  reject(invalid);
  assert.deepEqual(invalid, before);
});

test('warnings are optional in content but required as a bounded string array', () => {
  assert.deepEqual(validateAiPlan(plan([imageBlock()], []), 1).warnings, []);
  const warnings = Array.from({ length: 12 }, () => 'w'.repeat(400));
  assert.deepEqual(validateAiPlan(plan([imageBlock()], warnings), 1).warnings, warnings);
  reject(plan([imageBlock()], [...warnings, 'one more']));
  for (const warnings of [null, 'warning', new Array(1), [''], ['   '], [2], ['w'.repeat(401)]]) reject(plan([imageBlock()], warnings));
});

test('frozen input works and a later invalid block cannot mutate earlier valid data', () => {
  const first = Object.freeze({ ...textBlock(), rect: Object.freeze(rect()) });
  const input = Object.freeze({ blocks: Object.freeze([first]), warnings: Object.freeze([]) });
  assert.deepEqual(validateAiPlan(input, 1), input);
  reject({ blocks: [first, { ...imageBlock(), source: 9 }], warnings: [] });
  assert.equal(first.text, '7. Explain the relationship.');
  assert.equal(first.rect.x, 0.1);
});

test('schema is strict JSON with every object field required and image text enforced', () => {
  const schema = JSON.parse(JSON.stringify(AI_PLAN_SCHEMA));
  assert.deepEqual(schema, AI_PLAN_SCHEMA);
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.blocks.minItems, 1);
  assert.equal(schema.properties.blocks.maxItems, 24);
  assert.equal(schema.properties.warnings.maxItems, 12);
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'object') {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
    }
    for (const child of Object.values(value)) check(child);
  }
  check(schema);
  const branches = schema.properties.blocks.items.anyOf;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches.find(branch => branch.properties.kind.enum[0] === 'image').properties.text.enum, ['']);
  assert.equal(branches.find(branch => branch.properties.kind.enum[0] === 'text').properties.text.maxLength, 6000);
  assert.ok(Object.isFrozen(AI_PLAN_SCHEMA));
  assert.ok(Object.isFrozen(AI_PLAN_SCHEMA.properties.blocks.items.anyOf));
  assert.equal(typeof AI_SYSTEM_PROMPT, 'string');
  assert.ok(AI_SYSTEM_PROMPT.length > 0);
});
