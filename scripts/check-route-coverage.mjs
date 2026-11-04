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
// method 也要读出来：路径对了、方法错了同样是断点（前端把 POST 写成 GET，
// 运行时是 404，但界面只显示「资源不存在」，看不出是方法写错）。
// api(path) 不带 options 时按 GET 算——这是 public/js/api.js 里 api() 的默认行为。
const DEFAULT_METHOD = 'GET';

export function frontendCalls(root = DEFAULT_ROOT) {
  const files = collectFiles(join(root, 'public', 'js'), (name) => name.endsWith('.js'));
  const calls = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (const call of extractApiCalls(text)) {
      calls.push({ raw: call.path, method: call.method, file: relative(root, path) });
    }
  }
  return calls;
}

// 从一段源码里抽出所有 api(...) 调用的路径与方法。
// 不用正则一把扫：api(path, { body: { a: 1 } }) 这种带括号的参数，
// 正则截断后会把 body 当成 options，method 就读不到了。
// 这里做括号配对，取出完整的调用文本再解析。
export function extractApiCalls(text) {
  const out = [];
  const re = /\bapi\s*\(/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const callText = text.slice(open, close);
    const pathMatch = /^\s*[`']([^`']+)[`']/.exec(callText);
    if (!pathMatch) continue;
    const methodMatch = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(callText);
    out.push({ path: pathMatch[1], method: methodMatch ? methodMatch[1].toUpperCase() : DEFAULT_METHOD });
    re.lastIndex = close;
  }
  return out;
}

// 从 open（左边括号的位置）往后找配对的右括号，跳过字符串与模板串里的括号。
function matchParen(text, open) {
  let depth = 1;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  // 键是「方法 + 归一路径」：路径对了、方法错了也是断点。
  const called = new Set(calls.map((call) => `${call.method} ${normalizePath(call.raw)}`));
  // 同一路径前端用过哪些方法：报错时要说清「路径对、方法不对」，
  // 而不是笼统一句「前端从不调用」——后者会让老师去查路径，方向就错了。
  const methodsByPath = new Map();
  for (const call of calls) {
    const key = normalizePath(call.raw);
    if (!methodsByPath.has(key)) methodsByPath.set(key, new Set());
    methodsByPath.get(key).add(call.method);
  }

  const orphans = [];
  const missingReason = [];
  const methodMismatch = [];
  for (const route of routes) {
    // 两个键各司其职：
    //   routeKey —— 人写的形式（「POST /api/mistakes/:id/retry」），用于豁免查找与报错；
    //   matchKey —— 归一后的形式（「POST /api/mistakes/{}/retry」），用于与前端调用比对。
    // 混用会两边都对不上：一边归一一边没归一，比对永远失败。
    const routeKey = `${route.method} ${route.path}`;
    const matchKey = `${route.method} ${normalizePath(route.path)}`;
    if (called.has(matchKey)) continue;
    const reason = exemptions[routeKey];
    if (reason === undefined) {
      orphans.push(routeKey);
      const seen = methodsByPath.get(normalizePath(route.path));
      if (seen && seen.size > 0) {
        methodMismatch.push({ key: routeKey, seen: [...seen].sort().join(' / ') });
      }
    } else if (!String(reason).trim()) missingReason.push(routeKey);
  }

  const errors = [];
  for (const key of orphans) errors.push(`后端有这条路由，前端从不调用：${key}`);
  for (const item of methodMismatch) {
    errors.push(`${item.key} 的路径前端调过，但用的是 ${item.seen} —— 方法对不上，运行时会是 404`);
  }
  for (const key of missingReason) errors.push(`豁免没有写理由：${key}`);

  return {
    ok: errors.length === 0,
    routes: routes.length,
    calls: calls.length,
    orphans,
    missingReason,
    methodMismatch,
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
