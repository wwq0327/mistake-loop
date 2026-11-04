// #28 测试先行：批改账簿（Ledger）方向必须逐项可判定，不能只靠「看起来变了」。
// 红灯预期：新令牌、衬线字体、纸纹、书脊布局、打印纹理关闭、视觉稿与 Issue 映射都还不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_COUNT } from '../scripts/check-issue-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
const css = (name) => read(`public/css/${name}`);

const NEW_TOKENS = [
  '--color-accent',      // 朱红批注色，唯一强调
  '--color-spine',       // 书脊墨底
  '--font-display',      // 衬线活字标题与数字
  '--texture-paper',     // 纸纹
  '--texture-rule',      // 账格横线
  '--shadow-paper',      // 硬边 offset 投影
];

const PAGES = ['index', 'inbox', 'detail', 'print', 'library', 'settings'];

test('#28 新设计令牌在 tokens.css 一处定义', () => {
  const text = css('tokens.css');
  assert.ok(text, 'tokens.css 不存在');
  for (const name of NEW_TOKENS) {
    assert.ok(text.includes(`${name}:`), `缺新令牌 ${name}`);
  }
});

test('#28 令牌改为方角纸页，圆角不再是通用 SaaS 的 8/12/18px', () => {
  const text = css('tokens.css');
  const radius1 = /--radius-1:\s*(\d+)px/.exec(text);
  const radius2 = /--radius-2:\s*(\d+)px/.exec(text);
  assert.ok(radius1 && radius2, '缺圆角令牌');
  assert.ok(Number(radius1[1]) <= 4, `--radius-1 仍是大圆角 ${radius1[1]}px`);
  assert.ok(Number(radius2[1]) <= 6, `--radius-2 仍是大圆角 ${radius2[1]}px`);
});

test('#28 深色模式同步覆盖朱红与书脊，打印专用浅色仍保留', () => {
  const text = css('tokens.css');
  const dark = text.slice(text.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(dark.includes('--color-accent:'), '深色模式未重定义批注色');
  assert.ok(dark.includes('--color-spine:'), '深色模式未重定义书脊色');
  assert.ok(text.includes('--print-primary:'), '打印专用浅色令牌被删');
});

test('#28 base.css 用衬线标题与纸纹，并保留可访问性覆盖', () => {
  const text = css('base.css');
  assert.ok(text, 'base.css 不存在');
  assert.match(text, /var\(--font-display\)/, '标题未用衬线 display 字体栈');
  assert.match(text, /var\(--texture-paper\)/, '页面未铺纸纹');
  assert.match(text, /@keyframes\s+ledger-in/, '缺一次编排好的页面载入动效');
  assert.match(text, /prefers-reduced-motion/, '动效未尊重 reduced-motion');
  assert.match(text, /prefers-color-scheme/, '缺深色模式声明');
});

test('#28 不用 Inter / Roboto / Arial / 系统字体当展示字体', () => {
  const text = `${css('tokens.css')}\n${css('base.css')}`;
  assert.doesNotMatch(text, /\bInter\b|\bRoboto\b|\bArial\b/, '出现通用 AI 字体');
  assert.match(text, /Songti SC|STSong|Noto Serif CJK SC/, '中文标题缺衬线活字栈');
  assert.match(text, /Iowan Old Style|Baskerville|Georgia/, '西文/数字缺衬线活字栈');
});

test('#28 组件层改纸页：衬线数字、账格序号、硬边投影、批改章标记', () => {
  const text = css('components.css');
  assert.ok(text, 'components.css 不存在');
  assert.match(text, /\.stat\s*\{[^}]*var\(--font-display\)/s, 'KPI 数字未用衬线活字');
  assert.match(text, /counter-increment|counter\(/, '缺账格序号（CSS counter）');
  assert.match(text, /var\(--shadow-paper\)/, '缺纸页硬边投影');
  assert.match(text, /\.card__head::before/, '缺批改章/规则线标记');
  assert.match(text, /var\(--texture-rule\)/, '缺账格横线肌理');
});

test('#28 布局层做书脊与不对称版面，三档断点不丢', () => {
  const text = css('layout.css');
  assert.ok(text, 'layout.css 不存在');
  assert.match(text, /var\(--color-spine\)/, '桌面侧栏未做书脊墨底');
  assert.match(text, /\.content::before|\.page-head::after/, '缺页眉双规则线');
  assert.match(text, /1\.25fr/, 'KPI 仍是等宽平均分布');
  for (const bp of ['(min-width: 375px)', '(min-width: 768px)', '(min-width: 1440px)']) {
    assert.ok(text.includes(bp), `丢断点 ${bp}`);
  }
  assert.ok(text.includes('var(--content-max)'), '丢桌面内容区最大宽度');
});

test('#28 打印层关闭屏幕纹理，A4 浅色与不跨页断题不变', () => {
  const text = css('print.css');
  assert.ok(text, 'print.css 不存在');
  assert.match(text, /background-image:\s*none|--texture-paper:\s*none/, '出纸会印满纸纹，浪费墨');
  assert.match(text, /@page\s*\{\s*size:\s*A4/, 'A4 尺寸被改');
  assert.match(text, /break-inside:\s*avoid/, '不跨页断题被删');
  assert.match(text, /--print-primary|--print-surface/, '打印未强制浅色');
});

test('#28 视觉稿同步到新方向，README 引用不失效', () => {
  const preview = read('docs/design/ui-preview.html');
  assert.ok(preview, '视觉稿不存在');
  assert.match(preview, /ledger|Ledger|账簿/, '视觉稿未标明新方向');
  assert.match(preview, /--color-accent|#b23a2e/i, '视觉稿未用朱红批注色');
  assert.match(preview, /Songti SC|Iowan Old Style/, '视觉稿未用衬线活字');
  const readme = read('README.md');
  assert.ok(readme.includes('docs/design/ui-preview.html'), 'README 不再引用视觉稿');
});

test('#28 改版不靠改六页 HTML 结构，也不引外部字体与构建链', () => {
  for (const page of PAGES) {
    const html = read(`public/${page}.html`);
    assert.ok(html, `${page}.html 不存在`);
    assert.doesNotMatch(html, /class="[^"]*ledger-/, `${page}.html 靠新增结构类实现改版`);
    assert.doesNotMatch(html, /fonts\.googleapis|cdn\./i, `${page}.html 引了外部字体/CDN`);
    for (const layer of ['tokens.css', 'base.css', 'components.css', 'layout.css']) {
      assert.ok(html.includes(layer), `${page}.html 丢样式层 ${layer}`);
    }
  }
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['express'], '出现新增运行时依赖');
  assert.equal(pkg.scripts.build, undefined, '出现构建链');
});

test('#31 Issue 映射与守护脚本同源，不再写死编号', () => {
  assert.match(
    read('scripts/check-issue-map.mjs'),
    new RegExp(`EXPECTED_COUNT\\s*=\\s*${EXPECTED_COUNT}`),
    '守护脚本的 EXPECTED_COUNT 与事实源不一致',
  );
  assert.match(
    read('docs/github/issue-map.md'),
    new RegExp(`\\|\\s*#${EXPECTED_COUNT}\\s*\\|`),
    `映射表缺 #${EXPECTED_COUNT} 行`,
  );
  assert.match(read('test/issue-map.test.mjs'), /EXPECTED_COUNT/, '映射测试仍在写死编号');
});
