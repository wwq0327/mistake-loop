// node:test 的计数桩：只记录「注册了多少用例」，不执行任何用例体。
//
// 为什么不用正则数源码：`it(...)` 可能写在 for 循环里（动态生成），
// 正则只能数到调用点，会把 6 条用例算成 1 条。
// 这里让 node:test 的注册行为真实发生一次，计数就准了。
export const state = { count: 0, byFile: new Map(), currentFile: null };

function hit() {
  state.count += 1;
  if (!state.currentFile) return;
  state.byFile.set(state.currentFile, (state.byFile.get(state.currentFile) ?? 0) + 1);
}

export function test() {
  hit();
  return undefined;
}
test.skip = () => { hit(); };
test.todo = () => { hit(); };
test.only = () => { hit(); };

export const it = test;
it.skip = test.skip;
it.todo = test.todo;
it.only = test.only;

// describe 的回调要执行：用例通常注册在 describe 里面。
// 但用例体不执行，所以只会「数」，不会「跑」。
export function describe(name, fn) {
  if (typeof fn === 'function') fn();
}
describe.skip = describe;
describe.only = describe;
describe.todo = describe;

export function before() {}
export function after() {}
export function beforeEach() {}
export function afterEach() {}

export default test;
