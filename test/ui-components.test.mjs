// #8 测试先行：组件层与三档响应式布局。
// 红灯预期：public/css/components.css 与 layout.css 尚不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssDir = join(here, '..', 'public', 'css');
const read = (name) => (existsSync(join(cssDir, name)) ? readFileSync(join(cssDir, name), 'utf8') : null);

const COMPONENT_CLASSES = [
  '.btn', '.btn--primary', '.btn--secondary', '.btn--danger', '.btn--ghost', '.btn--icon',
  '.card', '.card__head', '.card__body',
  '.tag', '.tag--new', '.tag--diagnosing', '.tag--correcting', '.tag--reviewing', '.tag--mastered',
  '.progress', '.progress__bar', '.progress__step',
  '.field', '.input', '.select', '.textarea', '.field__hint', '.field__error',
  '.empty', '.skeleton', '.alert', '.alert--error', '.alert--warn', '.alert--info',
  '.toast', '.bbox', '.bbox__label', '.confidence', '.qcard',
];

const BREAKPOINTS = ['(min-width: 375px)', '(min-width: 768px)', '(min-width: 1440px)'];

test('components.css 存在且组件类清单齐全', () => {
  const text = read('components.css');
  assert.ok(text, 'components.css 不存在');
  const missing = COMPONENT_CLASSES.filter((name) => !text.includes(name));
  assert.deepEqual(missing, [], `缺组件类：${missing.join(', ')}`);
});

test('layout.css 存在且 375 / 768 / 1440 三档断点明确', () => {
  const text = read('layout.css');
  assert.ok(text, 'layout.css 不存在');
  for (const bp of BREAKPOINTS) {
    assert.ok(text.includes(bp), `缺断点 ${bp}`);
  }
  assert.ok(text.includes('.shell'), '缺应用外壳 .shell');
  // #65：全站只有一根浅色顶部导航，侧栏与底部标签栏退场。
  assert.ok(text.includes('.topbar'), '缺顶部导航 .topbar');
  assert.ok(text.includes('.topbar__inner'), '缺顶部导航内容区 .topbar__inner');
  assert.match(text, /\.topbar__nav/, '缺顶部导航入口 .topbar__nav');
  assert.ok(text.includes('var(--content-max)'), '桌面内容区未引用最大宽度令牌');
});

test('交互控件触控目标不低于 44px', () => {
  const text = read('components.css');
  assert.ok(text, 'components.css 不存在');
  assert.match(text, /min-height:\s*var\(--touch-min\)/, '按钮/输入未声明 44px 下限');
  const tokens = read('tokens.css');
  assert.match(tokens, /--touch-min:\s*44px/, '令牌 --touch-min 不是 44px');
});

test('状态标签颜色加文字双重标识，且无排名积分元素', () => {
  const text = read('components.css');
  assert.ok(text, 'components.css 不存在');
  assert.match(text, /attr\(data-label\)/, '状态标签没有由 HTML 提供的文字标签');
  for (const state of ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered']) {
    assert.ok(text.includes(`.tag--${state}`), `缺状态 ${state} 的独立样式`);
  }
  assert.doesNotMatch(text, /\.(rank|leaderboard|points|score|streak)\b/i, '出现打卡/排名/积分元素');
});

test('新增 CSS 不得出现硬编码十六进制色值', () => {
  for (const name of ['components.css', 'layout.css']) {
    const text = read(name);
    assert.ok(text, `${name} 不存在`);
    const hits = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${name} 含硬编码色值：${hits.join(', ')}`);
  }
});
