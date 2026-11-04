// #25 测试先行：CI 版本矩阵、check+test 守护、违规 CSS 能让 CI 转红的本地等价验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('#25 CI 工作流跑 npm run check（含 check-ui）与 npm test', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run check/, 'CI 未跑 npm run check');
  assert.match(ci, /npm test/, 'CI 未跑 npm test');
  assert.match(ci, /npm ci/, 'CI 未用锁文件安装');
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.check, /check-ui\.mjs/, 'npm run check 未覆盖 UI 静态规范');
  assert.match(pkg.scripts.check, /check-issue-map\.mjs/, 'npm run check 未覆盖 Issue 映射');
});

test('#25 Node 22 必绿，26 作为前瞻矩阵，fail-fast=false 互不取消', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /strategy:/, '缺 strategy');
  assert.match(ci, /fail-fast:\s*false/, '一个版本失败会取消另一个，22 不一定跑完');
  assert.match(ci, /matrix:/, '缺版本矩阵');
  assert.match(ci, /node:\s*\[[^\]]*'22'[^\]]*\]/, '矩阵缺 Node 22');
  assert.match(ci, /node:\s*\[[^\]]*'26'[^\]]*\]/, '矩阵缺 Node 26 前瞻验证');
  assert.match(ci, /node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/, 'setup-node 未用矩阵版本');
});

test('#25 CI 最小权限与并发收敛', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /permissions:/, '缺最小权限声明');
  assert.match(ci, /contents:\s*read/, '权限未收紧到只读');
  assert.match(ci, /concurrency:/, '缺并发收敛');
});

test('#25 本地违规样例：check-ui 退出码 1，等价于 CI 转红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ci-violation-'));
  try {
    writeFileSync(join(dir, 'bad.css'), '.bad { color: #ff0000; }\n');
    const result = spawnSync(process.execPath, ['scripts/check-ui.mjs', '--root', dir], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, '违规 CSS 没有让检查失败');
    assert.match(result.stdout, /硬编码色值/, '未报出具体违规项');
    assert.match(result.stdout, /ui-check:\s*FAIL/, '未输出 FAIL 结论');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
