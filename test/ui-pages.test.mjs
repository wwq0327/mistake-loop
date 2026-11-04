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

// #22 测试先行：打印页默认带今日复习、可增删、预览与出纸同源、学生版字段白名单。
// 红灯预期：print.html 缺选题池/预览区，print.js 未导出学生版字段投影函数。
test('#22 打印页含选题池、已选计数、出纸动作区与 A4 预览区骨架', () => {
  const page = read('public/print.html');
  assert.ok(page, 'print.html 不存在');
  for (const id of ['print-candidates', 'print-preview', 'print-selected-count', 'print-actions']) {
    assert.ok(page.includes(`id="${id}"`), `print.html 缺 #${id}`);
  }
  assert.ok(page.includes('print.css'), 'print.html 未引用 A4 出纸样式');
  assert.match(page, /<label\s+for="print-q"/, '选题池缺带 for 的检索 label');
});

test('#22 默认选题来自今日复习接口，增删都改同一份选中集合', () => {
  const source = read('public/js/pages/print.js');
  assert.ok(source, 'print.js 不存在');
  assert.match(source, /\/api\/reviews\/today/, '默认选题未取今日复习');
  assert.match(source, /\/api\/mistakes/, '缺可增删的候选题池');
  assert.match(source, /\/api\/print/, '未取学生版题卡');
  assert.match(source, /\bselected\b/, '缺统一选中集合');
  assert.match(source, /\.add\(|\.delete\(/, '缺增删动作');
  assert.match(source, /window\.print\s*\(/, '缺出纸动作');
});

test('#22 预览与出纸共用一次题卡请求，出纸不再二次取数', () => {
  const source = read('public/js/pages/print.js');
  assert.match(source, /\brenderPreview\b/, '缺单一渲染入口');
  assert.match(source, /\bsheetData\b/, '缺题卡数据快照');
  const body = source.match(/function printSheet\([^)]*\)\s*\{[^}]*\}/);
  assert.ok(body, '缺打印动作函数');
  assert.doesNotMatch(body[0], /await api\(|fetch\(/, '出纸时重新取数，预览与出纸可能不一致');
});

test('#22 学生版字段白名单：答案、学生作答、诊断与引导提示一律不进卡片', async () => {
  const mod = await import('../public/js/pages/print.js');
  assert.equal(typeof mod.pickStudentFields, 'function', '缺学生版字段投影函数');
  const dirty = {
    id: 7, subject: 'math', subject_label: '数学', unit_title: '第一单元',
    prompt: '计算 12×3', image_path: 'images/a.png', geometry_svg: '<svg></svg>',
    variants: [{ level: 'surface', prompt: '变式题干', correct_answer: '秘密答案' }],
    correct_answer: '36', student_answer: '35', diagnosis_note: '进位错了',
    error_reason: '粗心', scaffold_hint: '先算 10×3', student_conclusion: '要先拆',
    mastery_evidence: '会了', status: 'reviewing',
  };
  const clean = mod.pickStudentFields(dirty);
  const flat = JSON.stringify(clean);
  for (const key of [
    'correct_answer', 'student_answer', 'diagnosis_note', 'error_reason',
    'scaffold_hint', 'student_conclusion', 'mastery_evidence', 'status',
  ]) {
    assert.ok(!(key in clean), `学生版仍含字段 ${key}`);
  }
  for (const secret of ['36', '35', '进位错了', '粗心', '先算 10×3', '要先拆', '会了', '秘密答案']) {
    assert.ok(!flat.includes(secret), `学生版泄漏内容：${secret}`);
  }
  assert.equal(clean.prompt, '计算 12×3');
  assert.equal(clean.variants.length, 1);
  assert.deepEqual(Object.keys(clean.variants[0]), ['level', 'prompt'], '变式只保留层级与题干');
});

test('#22 A4 卡片不跨页断题', () => {
  const css = read('public/css/print.css');
  assert.ok(css, 'print.css 不存在');
  assert.match(css, /@page\s*\{\s*size:\s*A4/, '缺 A4 页面尺寸');
  assert.match(css, /break-inside:\s*avoid/, '缺不跨页断题规则');
  assert.match(css, /page-break-inside:\s*avoid/, '缺旧浏览器兼容规则');
});

// #23 测试先行：题库三档筛选与批量补教材定位。
// 红灯预期：library.html 缺筛选/批量骨架，library.js 未调 meta 与批量接口。
test('#23 题库页含三档筛选、批量入口与实时结果区骨架', () => {
  const page = read('public/library.html');
  assert.ok(page, 'library.html 不存在');
  for (const id of [
    'library-filter-subject', 'library-filter-status', 'library-filter-node',
    'library-filter-pending', 'library-batch-node', 'library-batch-apply',
    'library-batch-selected', 'library-list', 'library-summary',
  ]) {
    assert.ok(page.includes(`id="${id}"`), `library.html 缺 #${id}`);
  }
  for (const target of [
    'library-filter-subject', 'library-filter-status', 'library-filter-node',
    'library-filter-pending', 'library-batch-node',
  ]) {
    assert.match(page, new RegExp(`<label\\s+for="${target}"`), `缺 label[for=${target}]`);
  }
});

test('#23 题库筛选与批量动作都走现有 meta/mistakes 实时接口', () => {
  const source = read('public/js/pages/library.js');
  assert.ok(source, 'library.js 不存在');
  assert.match(source, /\/api\/meta/, '未取教材节点与实时统计');
  assert.match(source, /\/api\/mistakes/, '未取筛选结果');
  assert.match(source, /textbook_node_id/, '缺教材单元筛选参数');
  assert.match(source, /needs_textbook_ref/, '缺待补定位筛选');
  assert.match(source, /batch-textbook-ref/, '缺批量补定位接口');
  assert.match(source, /SUBJECT_MISMATCH|挂错科目|科目不一致/, '挂错科目未被拦截/提示');
});

// #24 测试先行：设置页 AI 状态、显式开关、后果说明、备份与健康入口。
// 红灯预期：settings.html 缺骨架，settings.js 未接状态/开关/备份接口。
test('#24 设置页含 AI 状态区、后果说明、显式开关、备份与健康入口', () => {
  const page = read('public/settings.html');
  assert.ok(page, 'settings.html 不存在');
  for (const id of [
    'settings-ai-status', 'settings-ai-toggle', 'settings-ai-warning',
    'settings-ai-usage', 'settings-ai-error', 'settings-ai-configured',
    'settings-backup', 'settings-backup-action', 'settings-backup-result',
    'settings-health', 'settings-health-action', 'settings-health-result',
  ]) {
    assert.ok(page.includes(`id="${id}"`), `settings.html 缺 #${id}`);
  }
  assert.match(page, /照片将发往你配置的 AI 服务商/, '开关旁缺外发后果说明');
  assert.match(page, /<label\s+for="settings-ai-toggle"/, '开关缺带 for 的 label');
  assert.match(page, /备份/, '缺备份入口文案');
  assert.match(page, /健康/, '缺健康入口文案');
});

test('#24 设置页只读非敏感状态，密钥不进页面源码', () => {
  const source = read('public/js/pages/settings.js');
  assert.ok(source, 'settings.js 不存在');
  for (const path of ['/api/ai/status', '/api/ai/toggle', '/api/backup', '/health', '/api/meta']) {
    assert.ok(source.includes(path), `未接接口 ${path}`);
  }
  for (const field of ['todayUsed', 'dailyLimit', 'lastError', 'pendingDrafts', 'configured']) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `未展示/读取 ${field}`);
  }
  assert.doesNotMatch(source, /AI_API_KEY|apiKey|AI_BASE_URL|baseUrl/, '页面出现密钥或端点字段');
});
