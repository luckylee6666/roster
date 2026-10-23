import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { installWebkitCompatibility } from '../src/webkit-compat.js';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

function legacyContext() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, navigator: { userAgent: '', platform: '' } });
  vm.runInContext('delete String.prototype.at; delete Array.prototype.at;', context);
  const root = vm.runInContext('globalThis', context);
  return { context, root };
}

test('旧 WebKit 的 at 兼容保留 UTF-16、负数与类型转换语义', () => {
  const { context, root } = legacyContext();
  installWebkitCompatibility(root);
  const fixtures = [
    ['"abc".at(-1)', 'c'], ['"abc".at()', 'a'], ['"abc".at(NaN)', 'a'],
    ['"abc".at(-1.8)', 'c'], ['"abc".at(Infinity)', undefined],
    ['"abc".at(-Infinity)', undefined], ['"abc".at(-4)', undefined],
    ['"😀".at(0)', '\ud83d'], ['String.prototype.at.call(123, -1)', '3'],
    ['[1, 2, 3].at(-1)', 3], ['Array.prototype.at.call({0:"a", length:1}, 0)', 'a'],
    ['Array.prototype.at.call({length:-2}, 0)', undefined],
    ['Object.keys(String.prototype).includes("at")', false],
  ];
  for (const [expression, expected] of fixtures) {
    assert.equal(vm.runInContext(expression, context), expected, expression);
  }
  for (const expression of [
    '"abc".at(1n)', '"abc".at(Symbol())', 'String.prototype.at.call(null, 0)',
    'String.prototype.at.call(Symbol(), 0)', 'Array.prototype.at.call(null, 0)',
    'Array.prototype.at.call({length:1n}, 0)',
  ]) assert.throws(() => vm.runInContext(expression, context), TypeError, expression);
});

test('旧 WebKit 的 structuredClone 保留 xterm 模式的 undefined 和独立副本', () => {
  const { root } = legacyContext();
  installWebkitCompatibility(root);
  const original = Object.freeze({ insertMode: false, cursorBlink: undefined, nested: { wraparound: true } });
  const copy = root.structuredClone(original);
  assert.deepEqual(copy, original);
  assert.equal(Object.hasOwn(copy, 'cursorBlink'), true);
  copy.nested.wraparound = false;
  assert.equal(original.nested.wraparound, true);
  const cyclic = { map: new Map([['x', new Set([1, 2])]]), bytes: new Uint8Array([3, 4]) };
  cyclic.self = cyclic;
  const result = root.structuredClone(cyclic);
  assert.equal(result.self, result);
  assert.deepEqual(result.map.get('x'), new Set([1, 2]));
  assert.deepEqual(result.bytes, new Uint8Array([3, 4]));
  assert.throws(() => root.structuredClone({ callback() {} }), TypeError);
  const protoKey = root.structuredClone(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(protoKey), Object.prototype);
  assert.equal(Object.hasOwn(protoKey, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});

test('现代 WebKit 的原生实现不被覆盖，兼容层重复安装幂等', () => {
  const context = vm.createContext({ structuredClone, queueMicrotask, setTimeout });
  const root = vm.runInContext('globalThis', context);
  const originals = [root.String.prototype.at, root.Array.prototype.at, root.structuredClone, root.queueMicrotask];
  installWebkitCompatibility(root);
  installWebkitCompatibility(root);
  assert.deepEqual([root.String.prototype.at, root.Array.prototype.at, root.structuredClone, root.queueMicrotask], originals);
});

test('queueMicrotask 兼容保持异步执行并把错误报告为异常', async () => {
  const { root } = legacyContext();
  const timers = [];
  root.setTimeout = callback => timers.push(callback);
  installWebkitCompatibility(root);
  const order = [];
  root.queueMicrotask(() => order.push('microtask'));
  order.push('sync');
  await Promise.resolve();
  assert.deepEqual(order, ['sync', 'microtask']);
  const error = new Error('queue failure');
  root.queueMicrotask(() => { throw error; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.length, 1);
  assert.throws(timers[0], value => value === error);
  assert.throws(() => root.queueMicrotask(null), TypeError);
});

test('真实 Marked 与 xterm 在缺失新 API 的环境能解析回复和创建终端', async () => {
  const { context, root } = legacyContext();
  const marked = await source('../src/vendor/marked.umd.js');
  const xterm = await source('../src/vendor/xterm.js');
  vm.runInContext(marked, context);
  vm.runInContext(xterm, context);
  assert.throws(() => vm.runInContext('marked.parse("Hello! What would you like to work on?")', context), /at is not a function/);
  assert.throws(() => vm.runInContext('new Terminal()', context), /structuredClone/);
  installWebkitCompatibility(root);
  assert.equal(vm.runInContext('marked.parse("Hello! What would you like to work on?")', context), '<p>Hello! What would you like to work on?</p>\n');
  assert.equal(vm.runInContext('new Terminal({cols:80, rows:24}).cols', context), 80);
});

test('兼容层在应用模块之前加载，内置第三方文件与锁定依赖一致', async () => {
  const main = await source('../src/main.js');
  assert.ok(main.startsWith("import './webkit-compat.js';"));
  for (const file of ['serialize.js', 'deserialize.js', 'types.js', 'LICENSE']) {
    const packagePath = file === 'LICENSE' ? file : `esm/${file}`;
    assert.equal(await source(`../src/vendor/structured-clone/${file}`), await source(`../node_modules/@ungap/structured-clone/${packagePath}`), file);
  }
  const dependency = JSON.parse(await source('../package.json'));
  assert.equal(dependency.dependencies['@ungap/structured-clone'], '1.4.0');
});
