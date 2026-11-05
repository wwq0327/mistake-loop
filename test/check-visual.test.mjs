// #32 测试先行：视觉一致性（B11）里能机器判的部分必须机器判。
// 红灯预期：scripts/check-visual.mjs 还不存在，第 1 条 import 直接失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVisual } from '../scripts/check-visual.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// #65：视觉靶子从旧账簿稿换成方案 B 参考原型，只认它的 .b 主题。
const TARGET = 'docs/design/closure-board-reference.html';

// 夹具直接复制真实仓库的相关文件：基线必须是「现在这份真的能过」，
// 每个用例只改一处，改完就该只坏那一项。
const FILES = [
  TARGET,
  'public/css/tokens.css',
  'public/css/print.css',
  'public/index.html',
  'public/inbox.html',
  'public/detail.html',
  'public/print.html',
  'public/library.html',
  'public/settings.html',
];

function withRepo(mutate, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-visual-'));
  try {
    for (const rel of FILES) {
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(ROOT, rel), to);
    }
    if (mutate) mutate(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edit(dir, rel, fn) {
  const path = join(dir, rel);
  writeFileSync(path, fn(readFileSync(path, 'utf8')));
}

test('#65 参考原型的方案 B 色值与 tokens 不一致时必须判失败，并点名变量与两个色值', () => {
  withRepo((dir) => {
    edit(dir, TARGET, (text) => text.replace('--accent:#175840', '--accent:#ff0000'));
  }, (dir) => {
    const out = checkVisual(dir);
    assert.equal(out.ok, false, '色值不一致没有被判失败');
    const hit = out.errors.find((e) => e.includes('--color-accent'));
    assert.ok(hit, `错误信息未点名 --color-accent：${out.errors.join(' | ')}`);
    assert.match(hit, /#175840/, '错误信息未包含 tokens 里的色值');
    assert.match(hit, /#ff0000/, '错误信息未包含靶子里的色值');
  });
});

test('#32 tokens 缺 --font-3 时必须判失败，并点名这个变量', () => {
  withRepo((dir) => {
    edit(dir, 'public/css/tokens.css', (text) => text.replace('--font-3: 16px;', ''));
  }, (dir) => {
    const out = checkVisual(dir);
    assert.equal(out.ok, false, '缺 --font-3 没有被判失败');
    assert.ok(
      out.errors.some((e) => e.includes('--font-3')),
      `错误信息未点名 --font-3：${out.errors.join(' | ')}`,
    );
  });
});

test('#32 字号阶梯倒挂时必须判失败，并指出哪一级不递增', () => {
  withRepo((dir) => {
    edit(dir, 'public/css/tokens.css', (text) => text.replace('--font-2: 14px;', '--font-2: 20px;'));
  }, (dir) => {
    const out = checkVisual(dir);
    assert.equal(out.ok, false, '字号阶梯倒挂没有被判失败');
    const hit = out.errors.find((e) => e.includes('--font-2') && e.includes('--font-3'));
    assert.ok(hit, `错误信息未指出倒挂的相邻两级：${out.errors.join(' | ')}`);
  });
});

test('#65 某页导航少一个入口时必须判失败，并点名那一页', () => {
  withRepo((dir) => {
    edit(dir, 'public/library.html', (text) => text.replace(
      '<a href="/settings" class="nav-link">设置</a>', ''));
  }, (dir) => {
    const out = checkVisual(dir);
    assert.equal(out.ok, false, '导航缺入口没有被判失败');
    assert.ok(
      out.errors.some((e) => e.includes('library.html')),
      `错误信息未点名缺入口的页面：${out.errors.join(' | ')}`,
    );
  });
});

test('#32 真实仓库的视觉判定必须全过，且给出可读的判定项数', () => {
  const out = checkVisual(ROOT);
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.ok(out.passed > 0, '没有给出通过的判定项数');
  assert.equal(out.failed, 0, '有失败判定项');
  assert.ok(out.checks.length >= 7, `判定组太少：${out.checks.length}`);
  for (const c of out.checks) {
    assert.equal(c.ok, true, `${c.id} 未通过`);
    assert.ok(c.name.length > 0, `${c.id} 缺中文说明`);
  }
});

test('#32 npm run check 必须带上视觉一致性判定', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /check-visual\.mjs/, 'npm run check 未覆盖视觉一致性');
});

test('#32 视觉判定不许改六页 HTML 的结构与业务 JS', () => {
  // 六页结构与业务 JS 只读：判定脚本不得写入 public/。
  withRepo(null, (dir) => {
    const before = FILES
      .filter((f) => f.startsWith('public/'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    checkVisual(dir);
    const after = FILES
      .filter((f) => f.startsWith('public/'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    assert.deepEqual(after, before, '视觉判定改动了六页文件');
  });
});
