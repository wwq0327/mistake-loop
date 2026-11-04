// #31 测试先行：文档里写的用例数必须等于真实跑出来的用例数，
// 所以计数本身要能被证明——这里真跑一遍 node --test，和计数器对账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTests } from '../scripts/count-tests.mjs';
import { parseTestSummary } from '../scripts/parse-test-summary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'count-tests.test.mjs';

function testFiles() {
  return readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => join(ROOT, 'test', f));
}

test('#31 计数器的用例数必须等于真实跑一遍 node --test 的用例数', () => {
  // 本文件排除在外，避免嵌套自举。
  const files = testFiles().filter((f) => !f.endsWith(SELF));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `${result.stdout.slice(-600)}${result.stderr.slice(-300)}`);
  const summary = parseTestSummary(result.stdout);
  assert.ok(Number.isInteger(summary.tests) && summary.tests > 0, `没解析出真实用例数：${JSON.stringify(summary)}`);

  const counted = countTests(ROOT);
  assert.equal(counted.ok, true, counted.errors.join('；'));
  const own = counted.files[SELF] ?? 0;
  assert.equal(counted.total, summary.tests + own, `计数 ${counted.total} 与真实跑出来的 ${summary.tests} + 本文件 ${own} 不一致`);
});

test('#31 计数只数不跑：会抛错的用例体不影响计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-count-'));
  try {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'fake.test.mjs'), [
      "import test from 'node:test';",
      "test('会抛错的用例', () => { throw new Error('用例体被执行了'); });",
      "test('第二个用例', () => { throw new Error('用例体被执行了'); });",
    ].join('\n'));
    const out = countTests(dir);
    assert.equal(out.ok, true, out.errors.join('；'));
    assert.equal(out.total, 2, '用例数没数对');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
