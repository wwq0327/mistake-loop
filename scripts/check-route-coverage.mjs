// #51 实现：接口可达性守护。
// 背景：「后端有能力、界面够不着」这类断点已经犯过三次（#40 变式录入、
// #41 错因录入、#48 识别重试），三次都是靠人肉发现的。
// 这道守护把发现方式换成机器：后端路由清单与前端调用清单对不上就判失败。
//
// 豁免清单是刻意留的：有些路由本来就不该有界面入口。硬性全连会让守护变噪音，
// 团队就会开始改守护来消音。每条豁免必须带一句理由——没理由的豁免不算数。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..');

// 豁免：方法 + 路径 → 理由。理由不能为空。
export const EXEMPTIONS = {
  'POST /api/mistakes': '手工新建错题走「收件箱草稿确认」那条路，这个接口留给脚本与批量导入',
  'GET /api/textbook-nodes': '冗余接口，/api/meta 已经带 textbookNodes，前端不需要单独取',
};

function collectFiles(dir, accept) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path, accept));
    else if (accept(entry)) out.push(path);
  }
  return out;
}

// 后端路由：src/routes/*.mjs 里的 router.get/post/patch/delete/put('path'…)
export function backendRoutes(root = DEFAULT_ROOT) {
  const files = collectFiles(join(root, 'src', 'routes'), (name) => name.endsWith('.mjs'));
  const routes = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/router\.(get|post|patch|delete|put)\(\s*'([^']+)'/g)) {
      routes.push({ method: match[1].toUpperCase(), path: `/api${match[2]}`, file: relative(root, path) });
    }
  }
  return routes;
}

// 前端调用：public/js/**/*.js 里的 api('…') / api(`…`)
export function frontendCalls(root = DEFAULT_ROOT) {
  const files = collectFiles(join(root, 'public', 'js'), (name) => name.endsWith('.js'));
  const calls = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\bapi\(\s*[`']([^`'"]+)/g)) {
      calls.push({ raw: match[1], file: relative(root, path) });
    }
  }
  return calls;
}

// 路径归一：:id 与 ${id} 都变成 {}，查询串去掉。
export function normalizePath(path) {
  return String(path)
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/:[A-Za-z_]\w*/g, '{}')
    .split('?')[0];
}

export function checkRouteCoverage(root = DEFAULT_ROOT, { exemptions = EXEMPTIONS } = {}) {
  const routes = backendRoutes(root);
  const calls = frontendCalls(root);
  const called = new Set(calls.map((call) => normalizePath(call.raw)));

  const orphans = [];
  const missingReason = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (called.has(normalizePath(route.path))) continue;
    const reason = exemptions[key];
    if (reason === undefined) orphans.push(key);
    else if (!String(reason).trim()) missingReason.push(key);
  }

  const errors = [];
  for (const key of orphans) errors.push(`后端有这条路由，前端从不调用：${key}`);
  for (const key of missingReason) errors.push(`豁免没有写理由：${key}`);

  return {
    ok: errors.length === 0,
    routes: routes.length,
    calls: calls.length,
    orphans,
    missingReason,
    errors,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = checkRouteCoverage();
  if (out.ok) {
    console.log(`route-coverage: PASS (${out.routes} 条路由全部有前端入口或已写明豁免)`);
  } else {
    // 两类问题分开报：孤儿是「后端有、前端够不着」，缺理由是「豁免写得不算数」。
    // 混成一句会让第二种问题在摘要里消失（0 条孤儿 + 1 条缺理由曾显示成「0 条孤儿」）。
    const summary = [
      out.orphans.length ? `${out.orphans.length} 条路由前端从不调用` : null,
      out.missingReason.length ? `${out.missingReason.length} 条豁免没写理由` : null,
    ].filter(Boolean).join('，');
    console.error(`route-coverage: FAIL (${summary})`);
    for (const line of out.errors) console.error(`  - ${line}`);
    process.exitCode = 1;
  }
}
