// #28 测试先行 → #65 修订：视觉方向必须逐项可判定，不能只靠「看起来变了」。
// 本条目原锁定「批改账簿」（衬线活字 + 纸纹 + 书脊 + 朱红）。
// #65 把方向定为方案 B「浅绿闭环」，审美专属断言随之改写；
// 业务与安全覆盖（深色、reduced-motion、打印、Issue 映射、无构建链）原样保留。
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

// 方案 B 的令牌：浅绿画布 + 近白面板 + 单一深绿强调 + 看板列深浅两档。
const THEME_TOKENS = [
  '--color-canvas',       // 浅绿画布 #edf4ef
  '--color-surface',      // 近白绿面板 #f9fcf9
  '--color-primary',      // 深绿强调 #175840
  '--color-primary-soft', // 浅绿选中 #daeddf
  '--color-lane',         // 看板普通列
  '--color-lane-deep',    // 看板复习列（深一档）
  '--font-display',       // 标题宋体
  '--radius-pill',        // 胶囊（计数、圆点）
];

const PAGES = ['index', 'inbox', 'detail', 'print', 'library', 'settings'];

test('#65 方案 B 令牌在 tokens.css 一处定义', () => {
  const text = css('tokens.css');
  assert.ok(text, 'tokens.css 不存在');
  for (const name of THEME_TOKENS) {
    assert.ok(text.includes(`${name}:`), `缺令牌 ${name}`);
  }
});

test('#65 圆角是 8/12/16 的阶梯，不再是方角纸片', () => {
  const text = css('tokens.css');
  const radius1 = /--radius-1:\s*(\d+)px/.exec(text);
  const radius4 = /--radius-4:\s*(\d+)px/.exec(text);
  assert.ok(radius1 && radius4, '缺圆角令牌');
  assert.ok(Number(radius1[1]) >= 6, `--radius-1 仍是 ${radius1[1]}px 的方角`);
  assert.ok(Number(radius4[1]) <= 20, `--radius-4 是 ${radius4[1]}px，面板圆角过大`);
});

test('#65 深色模式覆盖画布与强调，打印专用浅色仍保留', () => {
  const text = css('tokens.css');
  const dark = text.slice(text.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(dark.includes('--color-canvas:'), '深色模式未重定义画布');
  assert.ok(dark.includes('--color-accent:'), '深色模式未重定义强调色');
  assert.ok(text.includes('--print-primary:'), '打印专用浅色令牌被删');
});

test('#65 base.css 用标题宋体与正文无衬线，并保留可访问性覆盖', () => {
  const text = css('base.css');
  assert.ok(text, 'base.css 不存在');
  assert.match(text, /var\(--font-display\)/, '标题未用宋体栈');
  assert.match(text, /var\(--font-body\)/, '正文未用无衬线栈');
  assert.match(text, /@keyframes\s+rise-in/, '缺一次编排好的页面载入动效');
  assert.match(text, /prefers-reduced-motion/, '动效未尊重 reduced-motion');
  assert.match(text, /prefers-color-scheme/, '缺深色模式声明');
  assert.doesNotMatch(text, /--texture-paper/, '仍铺纸纹');
});

test('#65 不用 Inter / Roboto / Arial / 系统字体当展示字体', () => {
  const text = `${css('tokens.css')}\n${css('base.css')}`;
  assert.doesNotMatch(text, /\bInter\b|\bRoboto\b|\bArial\b/, '出现通用 AI 字体');
  assert.match(text, /Songti SC|STSong|Noto Serif CJK SC/, '中文标题缺宋体栈');
  assert.match(text, /PingFang SC|Hiragino Sans GB|Microsoft YaHei/, '中文正文缺无衬线栈');
});

test('#65 组件层按方案 B：圆角走令牌、柔和投影、无朱红批改章', () => {
  const text = css('components.css');
  assert.ok(text, 'components.css 不存在');
  assert.match(text, /\.stat\s*\{[^}]*var\(--font-display\)/s, 'KPI 数字未用衬线活字');
  assert.match(text, /var\(--shadow-3\)/, '缺投影层次');
  assert.doesNotMatch(text, /\.card__head::before/, '仍留着账簿的朱红批改章');
  assert.doesNotMatch(text, /--texture-rule/, '仍铺账格横线');
  assert.doesNotMatch(text, /counter\(kpi/, '仍用账格序号编号 KPI');
});

test('#65 布局层是一根顶部导航 + 宽幅内容区，三档断点不丢', () => {
  const text = css('layout.css');
  assert.ok(text, 'layout.css 不存在');
  assert.match(text, /\.topbar\s*\{/, '缺顶部导航');
  assert.match(text, /\.topbar__nav/, '缺导航容器');
  assert.doesNotMatch(text, /\.sidebar\b/, '桌面侧栏未退场');
  assert.doesNotMatch(text, /\.tabbar\b/, '手机标签栏未退场');
  for (const bp of ['(min-width: 375px)', '(min-width: 768px)', '(min-width: 1440px)']) {
    assert.ok(text.includes(bp), `丢断点 ${bp}`);
  }
  assert.ok(text.includes('var(--content-max)'), '丢内容区最大宽度');
});

test('#65 打印层关闭屏幕背景，A4 浅色与不跨页断题不变', () => {
  const text = css('print.css');
  assert.ok(text, 'print.css 不存在');
  assert.match(text, /background-image:\s*none|--texture-paper:\s*none/, '出纸会印满背景，浪费墨');
  assert.match(text, /@page\s*\{\s*size:\s*A4/, 'A4 尺寸被改');
  assert.match(text, /break-inside:\s*avoid/, '不跨页断题被删');
  assert.match(text, /--print-primary|--print-surface/, '打印未强制浅色');
});

test('#65 视觉依据在仓库内可取，README 引用不失效', () => {
  const reference = read('docs/design/closure-board-reference.html');
  assert.ok(reference, '方案 B 参考原型不存在');
  const shift = reference.slice(reference.indexOf('.b{'), reference.indexOf('.c{'));
  for (const color of ['#edf4ef', '#f9fcf9', '#19362d', '#50665c', '#cadbd0', '#175840', '#daeddf']) {
    assert.ok(shift.includes(color), `参考原型缺方案 B 色值 ${color}`);
  }
  const readme = read('README.md');
  assert.ok(readme.includes('docs/design/'), 'README 不再引用设计依据');
});

test('#65 改版不靠改六页 HTML 结构，也不引外部字体与构建链', () => {
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
