// #65 测试先行：方案 B（浅绿闭环）必须是可判定的，不能靠「看起来变了」。
// 红灯预期：tokens/base/layout/components 仍是批改账簿，六页仍是墨色侧栏。
//
// 这份测试只判「有唯一答案」的那半边：色值、令牌阶梯、导航结构、区块顺序、断点。
// 观感仍由维护者看图验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
const css = (name) => read(`public/css/${name}`);

const PAGES = ['index', 'inbox', 'detail', 'print', 'library', 'settings'];

// docs/design/closure-board-reference.html 里 .b 的七个色值，逐一对应到项目令牌。
// 参考文件是固定依据，这里把它写成可判定的映射。
const PALETTE = [
  ['--color-canvas', '#edf4ef'],
  ['--color-surface', '#f9fcf9'],
  ['--color-primary', '#175840'],
  ['--color-accent', '#175840'],
  ['--color-ink', '#19362d'],
  ['--color-muted', '#50665c'],
  ['--color-line', '#cadbd0'],
  ['--color-primary-soft', '#daeddf'],
];

// ── 一、色板 ────────────────────────────────────────────────────────────────

test('#65 令牌色值等于方案 B 参考图', () => {
  const text = css('tokens.css');
  assert.ok(text, 'tokens.css 不存在');
  for (const [name, value] of PALETTE) {
    const hit = new RegExp(`${name}:\\s*${value}\\s*;`, 'i').test(text);
    assert.ok(hit, `${name} 不是方案 B 的 ${value}`);
  }
});

test('#65 旧账簿装饰彻底退场：纸纹、账格、书脊、硬边叠纸、朱红', () => {
  const all = ['tokens.css', 'base.css', 'layout.css', 'components.css'].map(css).join('\n');
  assert.doesNotMatch(all, /--texture-paper\s*:/, '纸纹令牌还在');
  assert.doesNotMatch(all, /--texture-rule\s*:/, '账格横线令牌还在');
  assert.doesNotMatch(all, /--color-spine\s*:/, '书脊墨底令牌还在');
  assert.doesNotMatch(all, /--shadow-paper\s*:/, '硬边叠纸投影令牌还在');
  // 朱红 #b23a2e 是旧强调色；方案 B 只有一个深绿强调。
  assert.doesNotMatch(all, /#b23a2e/i, '旧朱红 #b23a2e 仍在');
  assert.doesNotMatch(all, /radial-gradient/i, '仍有纸纹颗粒');
  assert.doesNotMatch(all, /repeating-linear-gradient/i, '仍有账格横线');
  // 双横线：border: ... double 是账簿页眉的专属记号
  assert.doesNotMatch(all, /border[a-z-]*:\s*[^;]*\bdouble\b/i, '仍有双横线');
});

test('#65 圆角按参考的 8/12/16 阶梯，胶囊另立令牌', () => {
  const text = css('tokens.css');
  const values = {};
  for (const name of ['--radius-1', '--radius-2', '--radius-3', '--radius-4']) {
    const m = new RegExp(`${name}:\\s*(\\d+)px`).exec(text);
    assert.ok(m, `缺 ${name}`);
    values[name] = Number(m[1]);
  }
  assert.ok(values['--radius-1'] >= 6, `--radius-1 是 ${values['--radius-1']}px，题卡圆角过小`);
  assert.ok(values['--radius-4'] <= 20, `--radius-4 是 ${values['--radius-4']}px，面板圆角过大`);
  const seq = ['--radius-1', '--radius-2', '--radius-3', '--radius-4'].map((n) => values[n]);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] > seq[i - 1], `圆角阶梯不递增：${seq[i - 1]} → ${seq[i]}`);
  }
  assert.match(text, /--radius-pill:\s*999px/, '缺胶囊令牌（计数、圆点要用）');
});

test('#65 投影改为柔和层次，不再是硬边 offset', () => {
  const text = css('tokens.css');
  const shadows = [...text.matchAll(/--shadow-[123]:\s*([^;]+);/g)].map((m) => m[1].trim());
  // 浅色三档 + 深色三档一起判：深浅两套都必须是柔和投影。
  assert.ok(shadows.length >= 3, '阴影三档不齐');
  for (const value of shadows) {
    // 先把颜色抠掉，只留形状：`0 1px 2px` 是 [0, 1, 2]，硬边 `4px 4px 0` 是 [4, 4, 0]
    const shape = value.replace(/rgba?\([^)]*\)/g, '').trim();
    const lengths = [...shape.matchAll(/(-?\d+(?:\.\d+)?)(?:px)?/g)].map((m) => Number(m[1]));
    assert.ok(lengths.length >= 2, `投影看不懂：${value}`);
    const blur = lengths[lengths.length - 1];
    assert.ok(blur > 0, `模糊半径是 0，仍是硬边投影：${value}`);
  }
});

// ── 二、导航与页面框架 ──────────────────────────────────────────────────────

test('#65 六页共用浅色顶部导航，五个入口齐全且顺序固定', () => {
  const expected = ['/', '/inbox', '/print', '/library', '/settings'];
  for (const page of PAGES) {
    const html = read(`public/${page}.html`);
    assert.ok(html, `${page}.html 不存在`);
    assert.match(html, /<header class="topbar">/, `${page}.html 没有顶部导航`);
    const nav = /<nav[^>]*class="topbar__nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, `${page}.html 的顶部导航缺 topbar__nav`);
    const links = [...nav[1].matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
      .map((m) => ({ href: m[1], label: m[2].trim() }));
    assert.deepEqual(links.map((l) => l.href), expected, `${page}.html 导航入口不齐：${links.map((l) => l.href).join(',')}`);
    for (const link of links) assert.ok(link.label.length > 0, `${page}.html 有导航入口没有文字`);
  }
});

test('#65 旧侧栏与手机标签栏退场，导航只有一份', () => {
  const layout = css('layout.css');
  assert.doesNotMatch(layout, /\.sidebar\b/, '桌面墨色侧栏还在');
  assert.doesNotMatch(layout, /\.tabbar\b/, '手机底部标签栏还在');
  for (const page of PAGES) {
    const html = read(`public/${page}.html`);
    assert.doesNotMatch(html, /class="sidebar"/, `${page}.html 还挂着侧栏`);
    assert.doesNotMatch(html, /class="tabbar"/, `${page}.html 还挂着标签栏`);
    assert.equal((html.match(/<nav\b/g) ?? []).length, 1, `${page}.html 有多份导航`);
  }
});

test('#65 详情归属工作台，带返回看板的入口', () => {
  const html = read('public/detail.html');
  assert.ok(html, 'detail.html 不存在');
  assert.match(
    html,
    /<a href="\/" class="nav-link" aria-current="page">工作台<\/a>/,
    '详情页导航没有把工作台标成当前页',
  );
  assert.match(html, /id="detail-back"/, '详情页缺返回看板的显式入口');
  // 静态标记是一半，运行时还得落回工作台：此前 /mistake/ 被映射成 /library。
  assert.match(
    read('public/js/router.js'),
    /path\.startsWith\('\/mistake\/'\)\)\s*return '\/'/,
    '运行时把详情页标到了别的导航入口',
  );
});

test('#65 首屏主动作要用设计系统的按钮类，不能退化成一条普通链接', () => {
  const source = read('public/js/pages/detail.js');
  assert.ok(source, 'detail.js 不存在');
  assert.match(source, /'btn btn--primary'/, '首屏主动作没用 .btn 类');
  assert.doesNotMatch(source, /'button button--primary'/, '仍在使用设计系统里不存在的 .button 类');
});

test('#65 正式 UI 不出现 A/B/C 方案切换条', () => {
  for (const page of PAGES) {
    const html = read(`public/${page}.html`);
    assert.doesNotMatch(html, /设计预览|方案切换|closure-board-reference/, `${page}.html 混入了原型切换条`);
    assert.doesNotMatch(html, /href="#(today|board|focus)"/, `${page}.html 混入了原型锚点`);
  }
});

// ── 三、首页主体 ────────────────────────────────────────────────────────────

test('#65 首页主体是标题 + 学科筛选 + 五列看板，KPI 与全文查找退到后面', () => {
  const html = read('public/index.html');
  assert.ok(html, 'index.html 不存在');
  assert.match(html, /每道题走到哪了/, '首页标题不是参考文案');
  const board = html.indexOf('id="workbench-board"');
  const kpis = html.indexOf('id="workbench-kpis"');
  const finder = html.indexOf('id="page-q"');
  assert.ok(board > 0 && kpis > board, '看板不在 KPI 之前，主体被抢');
  assert.ok(finder > board, '页内查找抢在主体之前');
});

test('#65 学科筛选在看板之前，且用 aria-pressed 表达选中', () => {
  const html = read('public/index.html');
  assert.match(html, /id="board-filters"|id="workbench-board"/, '首页没有筛选容器');
  const source = read('public/js/pages/board.js');
  assert.match(source, /aria-pressed/, '筛选按钮没有表达选中状态');
  assert.match(source, /aria-label', '学科筛选'|aria-label="学科筛选"/, '筛选组缺可读标签');
});

// ── 四、看板视觉 ────────────────────────────────────────────────────────────

test('#65 复习列比其它列深一档，五列桌面并排、平板三列、手机单列', () => {
  const components = css('components.css');
  const layout = css('layout.css');
  assert.match(components, /\.board__col\[data-status="reviewing"\]/, '复习列没有单独加深');
  assert.match(components, /--color-lane-deep/, '缺列底色令牌');
  assert.match(layout, /repeat\(5,\s*minmax\(0,\s*1fr\)\)/, '桌面不是五列并排');
  assert.match(layout, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/, '平板不是三列');
  assert.match(layout, /--content-max:\s*1360px|var\(--content-max\)/, '内容区宽度未接令牌');
});

test('#65 题卡与列的圆角走令牌，不写死像素', () => {
  const components = css('components.css');
  const card = /\.board__card\s*\{([\s\S]*?)\}/.exec(components)?.[1] ?? '';
  assert.match(card, /border-radius:\s*var\(--radius-2\)/, '题卡圆角没走令牌');
  assert.doesNotMatch(card, /border-left:\s*3px/, '题卡还留着账簿的左侧墨线');
  const col = /\.board__col\s*\{([\s\S]*?)\}/.exec(components)?.[1] ?? '';
  assert.match(col, /border-radius:\s*var\(--radius-3\)/, '列圆角没走令牌');
});

test('#65 标题克制用宋体，正文无衬线，字号按参考放大', () => {
  const tokens = css('tokens.css');
  const base = css('base.css');
  assert.match(tokens, /--font-display:[^;]*Songti SC/, '标题栈缺宋体');
  assert.match(tokens, /--font-body:[^;]*sans-serif/, '正文栈缺无衬线');
  assert.doesNotMatch(tokens, /\bInter\b|\bRoboto\b|\bArial\b/, '出现通用 AI 字体');
  assert.match(base, /body\s*\{[^}]*var\(--font-body\)/s, '正文没有用无衬线栈');
  assert.match(base, /h1\s*\{[^}]*font-size:\s*clamp/, 'h1 没有用流体字号');
});

// ── 五、深色与打印 ──────────────────────────────────────────────────────────

test('#65 深色沿用同一套层次，且真比浅色深', () => {
  const text = css('tokens.css');
  const at = text.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.ok(at > 0, '缺深色覆盖块');
  const dark = text.slice(at);
  for (const name of ['--color-canvas', '--color-surface', '--color-ink', '--color-line', '--color-accent', '--color-primary-soft']) {
    assert.ok(dark.includes(`${name}:`), `深色块缺 ${name}`);
  }
  const darkCanvas = /--color-canvas:\s*(#[0-9a-f]{6})/i.exec(dark)?.[1];
  assert.ok(darkCanvas && darkCanvas !== '#edf4ef', '深色画布仍是浅色值');
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (n >> 16) + ((n >> 8) & 255) + (n & 255);
  };
  assert.ok(lum(darkCanvas) < lum('#edf4ef') / 2, `深色画布不够深：${darkCanvas}`);
});

test('#65 打印层仍强制浅色出纸，不把屏幕主题带上纸', () => {
  const print = css('print.css');
  assert.match(print, /@page\s*\{\s*size:\s*A4/, 'A4 尺寸被改');
  assert.match(print, /--color-canvas:\s*var\(--print-surface\)/, '出纸没有强制浅底');
  assert.match(print, /background-image:\s*none/, '出纸仍会印背景');
  assert.match(print, /break-inside:\s*avoid/, '不跨页断题被删');
});

// ── 六、旧契约不回流 ────────────────────────────────────────────────────────

test('#65 不为过测试而沿用旧设计：旧审美断言已按新规范修订', () => {
  const editorial = read('test/ui-editorial.test.mjs');
  assert.ok(editorial, 'ui-editorial.test.mjs 不存在');
  // 旧断言是「必须有纸纹/硬边投影/书脊」；这些必须从契约里消失，而不是反过来继续要求。
  for (const legacy of ['--texture-paper', '--shadow-paper', '--color-spine']) {
    assert.doesNotMatch(editorial, new RegExp(`['"]${legacy}['"]`), `${legacy} 仍被当作必须存在的令牌`);
  }
  assert.match(editorial, /方案 B|theme-b|#175840/, '旧断言没有改写成方案 B');
  // 业务与安全覆盖必须原样保留
  for (const keep of ['prefers-reduced-motion', 'check-issue-map', 'EXPECTED_COUNT']) {
    assert.ok(editorial.includes(keep), `修订时丢了既有覆盖：${keep}`);
  }
});
