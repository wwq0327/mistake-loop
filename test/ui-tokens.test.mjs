// #7 测试先行：设计系统必须有命名令牌，且新 CSS 目录内不得散落硬编码色值。
// 红灯预期：public/css/tokens.css 与 base.css 尚不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssDir = join(here, '..', 'public', 'css');
const read = (name) => (existsSync(join(cssDir, name)) ? readFileSync(join(cssDir, name), 'utf8') : null);

const REQUIRED = [
  '--color-primary', '--color-teal', '--color-amber', '--color-danger',
  '--color-canvas', '--color-surface', '--color-ink', '--color-muted', '--color-line',
  '--font-1', '--font-2', '--font-3', '--font-4', '--font-5', '--font-6', '--font-7',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7',
  '--radius-1', '--radius-2', '--radius-3', '--radius-4',
  '--shadow-0', '--shadow-1', '--shadow-2', '--shadow-3',
  '--motion-fast', '--motion-normal',
];

test('tokens.css 存在且六组令牌命名齐备', () => {
  const text = read('tokens.css');
  assert.ok(text, 'tokens.css 不存在');
  for (const name of REQUIRED) {
    assert.ok(text.includes(`${name}:`), `缺令牌 ${name}`);
  }
});

test('base.css 存在且声明了浅色主题与 reduced-motion', () => {
  const text = read('base.css');
  assert.ok(text, 'base.css 不存在');
  assert.match(text, /prefers-color-scheme/);
  assert.match(text, /prefers-reduced-motion/);
  assert.match(text, /font-family/);
});

test('public/css 内除 tokens.css 外不得出现硬编码十六进制色值', () => {
  const files = existsSync(cssDir) ? readdirSync(cssDir).filter((f) => f.endsWith('.css') && f !== 'tokens.css') : [];
  assert.ok(files.length > 0, '除令牌文件外还没有任何 CSS');
  for (const file of files) {
    const text = readFileSync(join(cssDir, file), 'utf8');
    const hits = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${file} 含硬编码色值：${hits.join(', ')}`);
  }
});
