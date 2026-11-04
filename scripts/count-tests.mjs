// #31 实现：精确统计仓库里声明的测试用例数。
//
// 用例数是文档里最容易漂的数字，所以它必须来自机器而不是人手抄：
// 这里用「node:test 注册即计数」的方式取真实用例数（动态生成的用例也算准），
// 不跑任何用例体、不碰任何数据目录。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const CHILD = fileURLToPath(new URL('./count-tests-child.mjs', import.meta.url));
const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARK = '__ML_COUNT__';

const cache = new Map();

export function countTests(root = DEFAULT_ROOT) {
  const key = String(root);
  if (cache.has(key)) return cache.get(key);

  const env = { ...process.env };
  // 计数子进程不是测试运行器，清掉测试上下文标记。
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [CHILD, key], {
    encoding: 'utf8',
    timeout: 120000,
    env,
  });

  const stdout = String(result.stdout ?? '');
  const at = stdout.lastIndexOf(MARK);
  let out = { ok: false, total: 0, files: {}, errors: ['计数子进程没有回读结果'] };

  if (at >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(at + MARK.length));
      out = {
        ok: parsed.errors.length === 0,
        total: parsed.total,
        files: parsed.files,
        errors: parsed.errors,
      };
    } catch (e) {
      out = { ok: false, total: 0, files: {}, errors: [`计数结果不是合法 JSON：${e.message}`] };
    }
  } else {
    out.errors.push(`计数子进程异常退出：${result.status} ${String(result.stderr ?? '').slice(-200)}`);
  }

  cache.set(key, out);
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const out = countTests(process.argv[2] ?? DEFAULT_ROOT);
  if (out.ok) console.log(`test-count: PASS (${out.total} 个用例)`);
  else {
    console.error(`test-count: FAIL (${out.total} 个用例)`);
    for (const e of out.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}
