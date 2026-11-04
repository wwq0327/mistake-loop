// #51 测试先行：接口可达性守护。
// 红灯预期：scripts/check-route-coverage.mjs 还不存在，import 失败。
// 背景：「后端有能力、界面够不着」这类断点已犯过三次（#40 变式录入、
// #41 错因录入、#48 识别重试），三次都是靠人肉发现的。这道守护把发现方式换成机器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRouteCoverage, backendRoutes, frontendCalls, normalizePath, EXEMPTIONS,
} from '../scripts/check-route-coverage.mjs';

// 造一个临时仓库：后端路由 + 前端调用。
function fakeRepo({ routes = [], calls = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-routes-'));
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  mkdirSync(join(dir, 'public', 'js', 'pages'), { recursive: true });
  writeFileSync(join(dir, 'src', 'routes', 'x.mjs'), routes
    .map((r) => `router.${r.method}('${r.path}', (req, res) => res.json({}));`)
    .join('\n'));
  writeFileSync(join(dir, 'public', 'js', 'pages', 'y.js'), calls
    .map((c) => `await api('${c}');`)
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
