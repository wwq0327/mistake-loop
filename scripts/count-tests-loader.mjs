// 加载器钩子：把测试文件里的 `node:test` 换成计数桩。
// 只改这一个内置模块，其余导入照常走真实解析。
const STUB = new URL('./count-tests-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:test') return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
