// 计数子进程：装上加载器钩子后逐个 import 测试文件，
// 让每个文件真实「注册」一遍用例（但不执行用例体），最后报出总数。
import { register } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

register('./count-tests-loader.mjs', import.meta.url);
const { state } = await import('./count-tests-stub.mjs');

const root = process.argv[2];
const dir = join(root, 'test');
const errors = [];
const files = [];

if (existsSync(dir)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
    state.currentFile = file;
    try {
      await import(pathToFileURL(join(dir, file)).href);
    } catch (e) {
      errors.push(`${file}：${e?.message ?? e}`);
    }
    state.currentFile = null;
  }
}

const byFile = {};
for (const [file, count] of state.byFile) byFile[file] = count;

process.stdout.write(`__ML_COUNT__${JSON.stringify({ total: state.count, files: byFile, errors })}`);
// 有些模块可能留了句柄（定时器、监听），强制退出避免挂住。
process.exit(errors.length ? 1 : 0);
