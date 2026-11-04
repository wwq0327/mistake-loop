// #9 测试先行：前端模块拆分与六页骨架。
// 红灯预期：六页 HTML、public/js 模块、archive/v1 归档均尚不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const PAGES = [
  ['public/index.html', 'workbench'],
  ['public/inbox.html', 'inbox'],
  ['public/detail.html', 'detail'],
  ['public/print.html', 'print'],
  ['public/library.html', 'library'],
  ['public/settings.html', 'settings'],
];

const SHARED_MODULES = ['api.js', 'ui.js', 'store.js', 'router.js'];
const PAGE_MODULES = ['workbench', 'inbox', 'detail', 'print', 'library', 'settings'];
const ROUTES = ['/', '/inbox', '/mistake/:id', '/print', '/library', '/settings'];

test('六页 HTML 均含 h1、nav、label 且引用四层设计系统 CSS', () => {
  for (const [file, page] of PAGES) {
    const text = read(file);
    assert.ok(text, `${file} 不存在`);
    assert.match(text, /<h1[\s>]/, `${file} 缺 h1`);
    assert.match(text, /<nav[\s>]/, `${file} 缺 nav`);
    assert.match(text, /<label[\s>]/, `${file} 缺 label`);
    assert.ok(text.includes(`data-page="${page}"`), `${file} 缺 data-page=${page}`);
    for (const css of ['tokens.css', 'base.css', 'components.css', 'layout.css']) {
      assert.ok(text.includes(css), `${file} 未引用 ${css}`);
    }
    assert.ok(text.includes('/js/router.js'), `${file} 未挂载 router`);
  }
});

test('六页共用同一套导航链接', () => {
  const navs = PAGES.map(([file]) => {
    const text = read(file);
    assert.ok(text, `${file} 不存在`);
    const links = [...text.matchAll(/<a\s+href="([^"]+)"[^>]*class="nav-link[^"]*"/g)].map((m) => m[1]);
    return { file, links };
  });
  const expected = ['/', '/inbox', '/print', '/library', '/settings'];
  for (const { file, links } of navs) {
    assert.deepEqual(links, expected, `${file} 导航链接与六页骨架不一致：${links.join(',')}`);
  }
});

test('public/js 下四个共享模块与六个页面模块齐备', () => {
  for (const name of SHARED_MODULES) {
    assert.ok(read(`public/js/${name}`), `缺共享模块 public/js/${name}`);
  }
  for (const name of PAGE_MODULES) {
    const text = read(`public/js/pages/${name}.js`);
    assert.ok(text, `缺页面模块 public/js/pages/${name}.js`);
    assert.match(text, /export\s+(async\s+)?function\s+mount/, `${name}.js 未导出 mount`);
  }
});

test('服务端显式映射六个页面路径', () => {
  const text = read('src/server.mjs');
  assert.ok(text, 'server.mjs 不存在');
  for (const route of ROUTES) {
    assert.ok(text.includes(`'${route}'`), `server.mjs 缺路由 ${route}`);
  }
});

test('v1 前端文件迁入 archive/v1 留档，不删除', () => {
  for (const name of ['capture.html', 'app.js', 'style.css', 'print.css']) {
    assert.ok(read(`archive/v1/${name}`), `archive/v1/${name} 未留档`);
  }
  for (const name of ['capture.html', 'app.js']) {
    assert.equal(read(`public/${name}`), null, `public/${name} 应已迁出`);
  }
  const check = JSON.parse(read('package.json')).scripts.check;
  assert.ok(!check.includes('public/app.js'), 'check 仍引用已归档的 public/app.js');
  assert.ok(check.includes('public/js'), 'check 未覆盖 public/js');
});

test('仍无框架、无构建链、无新增运行时依赖', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['express']);
  assert.equal(pkg.scripts.build, undefined);
  assert.equal(read('vite.config.js'), null);
  assert.equal(read('webpack.config.js'), null);
});

// #21：工作台四个实时数字与复习动作。
test('工作台含四个 KPI 容器，每个都能点到对应动作', () => {
  const page = read('public/index.html');
  assert.ok(page, 'index.html 不存在');
  const kpis = [...page.matchAll(/data-kpi="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kpis, ['pendingDrafts', 'today', 'overdue', 'awaitingTextbookRef']);
  for (const href of ['/inbox', '/print', '/library']) {
    assert.ok(page.includes(`data-kpi-href="${href}"`), `缺跳转 ${href}`);
  }
  assert.match(page, /id="workbench-today"/, '缺今日复习列表容器');
});

test('工作台数字全部来自实时接口，复习动作含做对/做错与掌握证据入口', () => {
  const source = read('public/js/pages/workbench.js');
  assert.ok(source, 'workbench.js 不存在');
  assert.match(source, /\/api\/meta/, '未读实时统计');
  assert.match(source, /\/api\/reviews\/today/, '未读今日复习');
  assert.match(source, /\/api\/ai\/status|\/api\/recognitions/, '未读待确认草稿');
  assert.match(source, /\/api\/reviews\//, '缺复习结果接口');
  assert.match(source, /correct/, '缺做对动作');
  assert.match(source, /wrong/, '缺做错动作');
  assert.match(source, /evidence_type/, '缺掌握证据入口');
  assert.match(source, /next_review|overdue_days/, '未按到期日排序展示');
});
