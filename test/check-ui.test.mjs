// #10 测试先行：UI 静态规范检查纳入 npm run check。
// 红灯预期：scripts/check-ui.mjs 不存在，违规/合规两组断言都无法正常判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(root, 'scripts', 'check-ui.mjs');

function runCheck(dir, extraArgs = []) {
  return spawnSync(process.execPath, [script, '--root', dir, ...extraArgs], { encoding: 'utf8' });
}

function goodHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/tokens.css">
</head>
<body data-page="workbench">
<nav class="sidebar"><a href="/" class="nav-link">工作台</a></nav>
<main><h1>示例</h1><label for="q">查找</label><input id="q" class="input"></main>
<script type="module" src="/js/router.js"></script>
</body></html>`;
}

test('违规页面（硬编码色值 + 缺 label）返回非零并点名原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ui-bad-'));
  try {
    writeFileSync(join(dir, 'bad.html'), `<!doctype html><html lang="zh-CN"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/tokens.css"><style>.x{color:#ff0000}</style></head>
<body><nav></nav><h1>坏页面</h1><script type="module" src="/js/router.js"></script></body></html>`);
    writeFileSync(join(dir, 'bad.css'), '.box { color: #123456; background: rgb(1,2,3); }');
    const result = runCheck(dir);
    assert.notEqual(result.status, 0, '违规页面竟然通过检查');
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /硬编码色值/, '未点名硬编码色值');
    assert.match(output, /label/, '未点名缺失 label');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合规页面返回零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ui-good-'));
  try {
    writeFileSync(join(dir, 'good.html'), goodHtml());
    writeFileSync(join(dir, 'good.css'), '.box { color: var(--color-ink); padding: var(--space-2); }');
    const result = runCheck(dir);
    assert.equal(result.status, 0, `合规页面被误判：${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('前端 JS 出现 innerHTML 赋值或 document.write 时返回非零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ui-js-'));
  try {
    writeFileSync(join(dir, 'good.html'), goodHtml());
    writeFileSync(join(dir, 'evil.js'), 'node.innerHTML = "<b>x</b>";');
    const result = runCheck(dir);
    assert.notEqual(result.status, 0, '不安全的 DOM 写入竟然通过检查');
    assert.match(`${result.stdout}${result.stderr}`, /innerHTML|document\.write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 public/ 目录自身通过该检查', () => {
  assert.ok(existsSync(script), 'scripts/check-ui.mjs 不存在');
  const result = runCheck(join(root, 'public'));
  assert.equal(result.status, 0, `真实前端未通过：${result.stdout}${result.stderr}`);
});

test('npm run check 覆盖 UI 规范，CI 随 npm run check 自动执行', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /check-ui\.mjs/, 'check 未调用 UI 规范脚本');
  assert.match(pkg.scripts.check, /public\/js/, 'check 未覆盖 public/js');
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run check/, 'CI 未执行 npm run check');
});
