// #51 测试先行：接口可达性守护。
// 红灯预期：scripts/check-route-coverage.mjs 还不存在，import 失败。
// 背景：「后端有能力、界面够不着」这类断点已犯过三次（#40 变式录入、
// #41 错因录入、#48 识别重试），三次都是靠人肉发现的。这道守护把发现方式换成机器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as routeCoverageModule from '../scripts/check-route-coverage.mjs';
const {
  checkRouteCoverage, backendRoutes, frontendCalls, normalizePath, EXEMPTIONS,
} = routeCoverageModule;

// 造一个临时仓库：后端路由 + 前端调用。
// calls 可以是字符串（默认 GET，与 api(path) 的默认行为一致），
// 也可以是 { path, method } 对象。
function fakeRepo({ routes = [], calls = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-routes-'));
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  mkdirSync(join(dir, 'public', 'js', 'pages'), { recursive: true });
  writeFileSync(join(dir, 'src', 'routes', 'x.mjs'), routes
    .map((r) => `router.${r.method}('${r.path}', (req, res) => res.json({}));`)
    .join('\n'));
  writeFileSync(join(dir, 'public', 'js', 'pages', 'y.js'), calls
    .map((c) => (typeof c === 'string'
      ? `await api('${c}');`
      : `await api('${c.path}', { method: '${c.method}' });`))
    .join('\n'));
  return {
    dir,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('#51 真实仓库：每条后端路由都有前端入口，或写明了豁免理由', () => {
  const out = checkRouteCoverage();
  assert.equal(out.ok, true, out.errors.join('；'));
  assert.ok(out.routes > 20, `应扫到二十条以上路由，实际 ${out.routes}`);
  assert.equal(out.orphans.length, 0);
});

test('#51 后端有、前端不调用的路由必须被点名', () => {
  const repo = fakeRepo({
    routes: [{ method: 'get', path: '/things' }, { method: 'post', path: '/things/:id/redo' }],
    calls: ['/api/things'],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, false, '有路由前端从不调用，必须判失败');
    assert.deepEqual(out.orphans, ['POST /api/things/:id/redo']);
    assert.match(out.errors.join(' '), /POST \/api\/things\/:id\/redo/, '要点名是哪条路由');
  } finally { repo.clean(); }
});

test('#51 豁免必须有理由：空理由不算豁免', () => {
  const repo = fakeRepo({ routes: [{ method: 'get', path: '/things' }], calls: [] });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: { 'GET /api/things': '   ' } });
    assert.equal(out.ok, false, '空理由的豁免必须判失败');
    assert.deepEqual(out.missingReason, ['GET /api/things']);
    assert.match(out.errors.join(' '), /没有写理由/);
  } finally { repo.clean(); }
});

test('#51 写明理由的豁免不再报孤儿', () => {
  const repo = fakeRepo({ routes: [{ method: 'get', path: '/things' }], calls: [] });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: { 'GET /api/things': '留给脚本用' } });
    assert.equal(out.ok, true, out.errors.join('；'));
    assert.equal(out.orphans.length, 0);
  } finally { repo.clean(); }
});

test('#51 路径归一：:id 与 ${id} 视为同一条，查询串不影响匹配', () => {
  assert.equal(normalizePath('/api/mistakes/:id'), '/api/mistakes/{}');
  assert.equal(normalizePath('/api/mistakes/${id}'), '/api/mistakes/{}');
  assert.equal(normalizePath('/api/print?ids=${ids}'), '/api/print');

  const repo = fakeRepo({
    routes: [{ method: 'get', path: '/mistakes/:id' }],
    calls: ['/api/mistakes/${id}'],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, true, out.errors.join('；'));
  } finally { repo.clean(); }
});

test('#51 扫描本身要靠谱：能数出路由与前端调用', () => {
  const routes = backendRoutes();
  const calls = frontendCalls();
  assert.ok(routes.length > 20, `后端路由应扫到二十条以上，实际 ${routes.length}`);
  assert.ok(calls.length > 20, `前端调用应扫到二十条以上，实际 ${calls.length}`);
  assert.ok(routes.every((r) => r.method && r.path.startsWith('/api/')));
});

test('#51 两类问题必须分开报：孤儿与缺理由不能混成一句', () => {
  const repo = fakeRepo({
    routes: [{ method: 'get', path: '/things' }, { method: 'post', path: '/others' }],
    calls: [],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: { 'GET /api/things': '   ' } });
    assert.equal(out.ok, false);
    assert.deepEqual(out.orphans, ['POST /api/others']);
    assert.deepEqual(out.missingReason, ['GET /api/things']);
    assert.equal(out.errors.length, 2, '两类问题各报一条');
  } finally { repo.clean(); }
});

test('#51 真实仓库的豁免清单每条都写了理由', () => {
  for (const [key, reason] of Object.entries(EXEMPTIONS)) {
    assert.ok(String(reason).trim().length > 0, `豁免 ${key} 没写理由`);
    assert.match(key, /^(GET|POST|PATCH|DELETE|PUT) \/api\//, `豁免键 ${key} 格式不对`);
  }
});

// #53 测试先行：接口可达性守护必须比对 method，不只是路径。
// 红灯预期：现在 frontendCalls 只提取路径、method 被丢弃，
// 所以前端把 POST 写成 GET，守护照样报 PASS——CI 全绿放行，运行时才 404。
test('#53 method 对不上必须报出来：路径对了、方法错了也算断点', () => {
  const repo = fakeRepo({
    routes: [{ method: 'post', path: '/things/:id/redo' }],
    calls: [{ path: '/api/things/${id}/redo', method: 'GET' }],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, false, 'method 对不上必须判失败');
    assert.deepEqual(out.orphans, ['POST /api/things/:id/redo']);
    assert.match(out.errors.join(' '), /GET/, '错误信息要点名前端实际用的方法');
    assert.match(out.errors.join(' '), /POST/, '错误信息要点名后端要的方法');
  } finally { repo.clean(); }
});

test('#53 method 对上就不算孤儿', () => {
  const repo = fakeRepo({
    routes: [{ method: 'post', path: '/things/:id/redo' }],
    calls: [{ path: '/api/things/${id}/redo', method: 'POST' }],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, true, out.errors.join('；'));
    assert.equal(out.orphans.length, 0);
  } finally { repo.clean(); }
});

test('#53 不带 method 的 api(path) 默认按 GET 算', () => {
  const repo = fakeRepo({
    routes: [{ method: 'get', path: '/things' }],
    calls: ['/api/things'],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, true, out.errors.join('；'));
  } finally { repo.clean(); }
});

test('#53 同一路径不同方法算两条路由：GET 通不代表 POST 通', () => {
  const repo = fakeRepo({
    routes: [{ method: 'get', path: '/things' }, { method: 'post', path: '/things' }],
    calls: ['/api/things'],
  });
  try {
    const out = checkRouteCoverage(repo.dir, { exemptions: {} });
    assert.equal(out.ok, false, '只调了 GET，POST 那条仍是孤儿');
    assert.deepEqual(out.orphans, ['POST /api/things']);
  } finally { repo.clean(); }
});

test('#53 真实仓库：前端调用的 method 与后端路由逐条对得上', () => {
  const routes = backendRoutes();
  const calls = frontendCalls();
  assert.ok(calls.length > 20, `前端调用应扫到二十条以上，实际 ${calls.length}`);
  assert.ok(calls.every((c) => c.method), '每条前端调用都要能读出 method');
  // 真仓库里不该有 method 错配：本次修复前实测是 0 处。
  // 有意豁免的路由不算错配——豁免清单里的两条本来就该没有前端入口。
  const mismatched = [];
  for (const route of routes) {
    if (EXEMPTIONS[`${route.method} ${route.path}`]) continue;
    const hit = calls.some((c) => c.method === route.method && normalizePath(c.raw) === normalizePath(route.path));
    if (!hit) mismatched.push(`${route.method} ${route.path}`);
  }
  assert.deepEqual(mismatched, [], `真实仓库出现 method 错配：${mismatched.join('、')}`);
});

test('#53 api() 调用的解析要扛住各种写法', () => {
  const { extractApiCalls } = routeCoverageModule;
  const cases = [
    ["await api('/api/x');", [{ path: '/api/x', method: 'GET' }]],
    ["await api('/api/x', { method: 'POST' });", [{ path: '/api/x', method: 'POST' }]],
    ["await api('/api/x', { method: 'delete' });", [{ path: '/api/x', method: 'DELETE' }]],
    ['await api(`/api/x/${id}`);', [{ path: '/api/x/${id}', method: 'GET' }]],
    // 模板串里的括号也不该算进配对：反引号里的内容整体跳过
    ['await api(`/api/x/${id}?note=(a`);', [{ path: '/api/x/${id}?note=(a', method: 'GET' }]],
    // body 里带括号与嵌套对象：括号配对不能被 body 里的括号带偏
    ["await api('/api/x', { method: 'POST', body: { prompt: 'a)b' } });", [{ path: '/api/x', method: 'POST' }]],
    // 题干里的括号常常不配平（老师随手录的「f(x)=2(x+1」）——
    // 字符串里的括号一个都不能算进配对，否则整个调用会被截断、method 读不到。
    ["await api('/api/x', { method: 'POST', body: { prompt: 'f(x)=2(x+1' } });", [{ path: '/api/x', method: 'POST' }]],
    ["await api('/api/x', { method: 'POST', body: { prompt: '解 (x+1) 的值' } });", [{ path: '/api/x', method: 'POST' }]],
    ["await api('/api/x', { method: 'PATCH', body: { a: { b: [1, 2] } } });", [{ path: '/api/x', method: 'PATCH' }]],
    // method 写在 body 之后也要读得到
    ["await api('/api/x', { body: { a: 1 }, method: 'PUT' });", [{ path: '/api/x', method: 'PUT' }]],
    // 一次调用里两个 api：不能只抓到第一个
    ["const a = api('/api/one'); const b = api('/api/two', { method: 'POST' });",
      [{ path: '/api/one', method: 'GET' }, { path: '/api/two', method: 'POST' }]],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(extractApiCalls(source), expected, `解析不对：${source}`);
  }
});
