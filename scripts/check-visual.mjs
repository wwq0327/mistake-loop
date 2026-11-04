// #32 实现：视觉一致性（B11）里能机器判的部分，机器判。
//
// 审美（字距舒不舒服、朱红多不多）仍然由使用者看；这里只判有唯一答案的那半边：
// 色板、阶梯、深色、打印层、六屏与六页的对应关系。
// 零依赖、只读、不联网：不写任何文件、不碰数据目录。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TARGET = 'docs/design/ui-preview.html';
export const TOKENS = 'public/css/tokens.css';
export const PRINT_CSS = 'public/css/print.css';
export const PAGES = ['index.html', 'inbox.html', 'detail.html', 'print.html', 'library.html', 'settings.html'];

const FONT_STEPS = 7;
const SPACE_STEPS = 7;
const RADIUS_STEPS = 4;
const SHADOW_STEPS = 4;

// ── 解析小工具 ──────────────────────────────────────────────────────────────

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function varsOf(block) {
  const vars = new Map();
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(`--${m[1]}`, m[2].trim());
  }
  return vars;
}

// 取第一个 :root { ... } 块里的变量
function rootVars(css) {
  const m = /:root\s*\{([\s\S]*?)\}/.exec(stripComments(css));
  return m ? varsOf(m[1]) : new Map();
}

// 取深色覆盖块里的变量
function darkVars(css) {
  const clean = stripComments(css);
  const at = clean.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  if (at < 0) return null;
  const m = /:root\s*\{([\s\S]*?)\}/.exec(clean.slice(at));
  return m ? varsOf(m[1]) : null;
}

function normalize(value) {
  return String(value).replace(/\s+/g, '');
}

function pxOf(value) {
  const m = /(-?\d+(?:\.\d+)?)px/.exec(String(value));
  return m ? Number(m[1]) : null;
}

// 阶梯类判定：n 级必须齐全，且相邻两级严格递增
function checkSteps(vars, prefix, steps, { unit = 'px', label } = {}) {
  const errors = [];
  const values = [];
  for (let i = 1; i <= steps; i += 1) {
    const name = `--${prefix}-${i}`;
    if (!vars.has(name)) {
      errors.push(`${TOKENS} 缺 ${name}（${label}阶梯必须 ${steps} 级齐全）`);
      values.push(null);
      continue;
    }
    const value = vars.get(name);
    const num = unit === 'px' ? pxOf(value) : null;
    if (unit === 'px' && num === null) {
      errors.push(`${name} 的值「${value}」不是 ${unit}，无法判断阶梯`);
      values.push(null);
      continue;
    }
    values.push(num);
  }
  for (let i = 1; i < steps; i += 1) {
    const a = values[i - 1];
    const b = values[i];
    if (a === null || b === null) continue;
    if (b <= a) {
      errors.push(
        `${label}阶梯不递增：--${prefix}-${i} 是 ${a}${unit}，--${prefix}-${i + 1} 是 ${b}${unit}`,
      );
    }
  }
  return { errors, total: steps + (steps - 1) };
}

// ── 页面与靶子的对应 ────────────────────────────────────────────────────────

function readPage(root, file) {
  const path = join(root, 'public', file);
  if (!existsSync(path)) return null;
  const html = readFileSync(path, 'utf8');
  const dataPage = /data-page="([^"]+)"/.exec(html)?.[1] ?? null;
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const topbar = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
  const selfName = /<span class="small muted">([^<]*)<\/span>/.exec(topbar)?.[1] ?? '';
  const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  const navLabels = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
    .map((m) => ({ href: m[1], label: m[2].trim() }));
  return { file, dataPage, names: [title.split('·')[0].trim(), selfName].filter(Boolean), navLabels };
}

function routeOf(file) {
  const base = file.replace(/\.html$/, '');
  return base === 'index' ? '/' : `/${base}`;
}

// ── 判定主流程 ──────────────────────────────────────────────────────────────

export function checkVisual(root = DEFAULT_ROOT) {
  const errors = [];
  const checks = [];
  const add = (id, name, result) => {
    checks.push({ id, name, ok: result.errors.length === 0, passed: result.total - result.errors.length, total: result.total });
    errors.push(...result.errors);
  };

  const targetPath = join(root, TARGET);
  const tokensPath = join(root, TOKENS);
  const printPath = join(root, PRINT_CSS);
  for (const [rel, path] of [[TARGET, targetPath], [TOKENS, tokensPath], [PRINT_CSS, printPath]]) {
    if (!existsSync(path)) {
      return { ok: false, checks: [], passed: 0, failed: 1, total: 1, errors: [`文件缺失：${rel}`] };
    }
  }
  const targetText = readFileSync(targetPath, 'utf8');
  const tokensText = readFileSync(tokensPath, 'utf8');
  const printText = readFileSync(printPath, 'utf8');

  // 1. 靶子色板与 tokens 同名变量逐一相等（靶子声明的每一个都要对上）。
  {
    const targetVars = rootVars(targetText);
    const tokenVars = rootVars(tokensText);
    const list = [];
    for (const [name, value] of targetVars) {
      if (!tokenVars.has(name)) {
        list.push(`${TARGET} 声明了 ${name}，但 ${TOKENS} 里没有这个变量`);
        continue;
      }
      const tokenValue = tokenVars.get(name);
      if (normalize(value) !== normalize(tokenValue)) {
        list.push(`${name} 色值不一致：靶子是 ${value}，${TOKENS} 是 ${tokenValue}`);
      }
    }
    add('palette', '靶子色板与 tokens 同名变量逐个相等', { errors: list, total: Math.max(targetVars.size, 1) });
  }

  // 2. 字号阶梯、3. 间距阶梯、4. 圆角阶梯、5. 阴影阶梯
  const tokenVars = rootVars(tokensText);
  add('font', '字号七阶 --font-1..7 齐全且严格递增', checkSteps(tokenVars, 'font', FONT_STEPS, { label: '字号' }));
  add('space', '间距七阶 --space-1..7 齐全且严格递增', checkSteps(tokenVars, 'space', SPACE_STEPS, { label: '间距' }));
  add('radius', '圆角 --radius-1..4 齐全且递增', checkSteps(tokenVars, 'radius', RADIUS_STEPS, { label: '圆角' }));

  {
    // 阴影：--shadow-0 是 none（视为 0 偏移），--shadow-1..3 的硬边偏移要递增。
    const errors = [];
    const offsets = [];
    for (let i = 0; i < SHADOW_STEPS; i += 1) {
      const name = `--shadow-${i}`;
      if (!tokenVars.has(name)) {
        errors.push(`${TOKENS} 缺 ${name}（阴影阶梯必须 ${SHADOW_STEPS} 级齐全）`);
        offsets.push(null);
        continue;
      }
      const value = tokenVars.get(name);
      const num = value === 'none' ? 0 : pxOf(value);
      if (num === null) {
        errors.push(`${name} 的值「${value}」看不懂偏移量，无法判断阶梯`);
        offsets.push(null);
        continue;
      }
      offsets.push(num);
    }
    for (let i = 1; i < SHADOW_STEPS; i += 1) {
      const a = offsets[i - 1];
      const b = offsets[i];
      if (a === null || b === null) continue;
      if (b <= a) errors.push(`阴影阶梯不递增：--shadow-${i} 偏移 ${a}px，--shadow-${i + 1} 偏移 ${b}px`);
    }
    add('shadow', '阴影 --shadow-0..3 齐全且硬边偏移递增', { errors, total: SHADOW_STEPS + (SHADOW_STEPS - 1) });
  }

  // 6. 六页：都引用 tokens.css、都带 data-page、data-page 互不相同。
  {
    const errors = [];
    const pages = [];
    for (const file of PAGES) {
      const path = join(root, 'public', file);
      if (!existsSync(path)) {
        errors.push(`六页缺 ${file}`);
        continue;
      }
      const html = readFileSync(path, 'utf8');
      if (!html.includes('css/tokens.css')) errors.push(`${file} 没有引用 ${TOKENS}`);
      const page = readPage(root, file);
      if (!page?.dataPage) errors.push(`${file} 没有 data-page 标记`);
      else pages.push(page);
    }
    const seen = new Set();
    for (const p of pages) {
      if (seen.has(p.dataPage)) errors.push(`data-page 重复：${p.dataPage}`);
      seen.add(p.dataPage);
    }
    add('pages', '六页都引用 tokens.css、都带 data-page 且互不相同', { errors, total: PAGES.length * 2 + 1 });
  }

  // 7. 靶子六屏 01..06 与实际六页一一对应。
  {
    const errors = [];
    const screens = [...targetText.matchAll(/<div class="screen-bar"><span>(\d{2})\s*\/\s*([^<]*)<\/span>/g)]
      .map((m) => ({ no: m[1], title: m[2].trim() }));
    const expected = Array.from({ length: 6 }, (_, i) => String(i + 1).padStart(2, '0'));
    for (const no of expected) {
      if (!screens.some((s) => s.no === no)) errors.push(`${TARGET} 少了第 ${no} 屏`);
    }
    for (const s of screens) {
      if (!expected.includes(s.no)) errors.push(`${TARGET} 多了第 ${s.no} 屏`);
    }

    const pages = PAGES.map((f) => readPage(root, f)).filter((p) => p && p.dataPage);
    const alias = new Map();
    for (const p of pages) {
      for (const name of p.names) if (name && !alias.has(name)) alias.set(name, p.dataPage);
      // 导航里指向本页路由的标签也是这一页的名字（如 /print 的「打印」）
      const route = routeOf(p.file);
      for (const link of p.navLabels) {
        if (link.href === route && link.label && !alias.has(link.label)) alias.set(link.label, p.dataPage);
      }
    }
    // 别的页面的导航也可能用这个名字指向本页路由
    for (const p of pages) {
      const route = routeOf(p.file);
      for (const other of pages) {
        for (const link of other.navLabels) {
          if (link.href === route && link.label && !alias.has(link.label)) alias.set(link.label, p.dataPage);
        }
      }
    }

    const mapped = [];
    for (const s of screens) {
      if (!expected.includes(s.no)) continue;
      const page = alias.get(s.title);
      if (!page) {
        errors.push(`靶子第 ${s.no} 屏的标题「${s.title}」在六页里找不到对应页面`);
        continue;
      }
      mapped.push(page);
    }
    const unique = new Set(mapped);
    if (unique.size !== mapped.length) {
      errors.push(`靶子六屏与六页不是一一对应：${mapped.join('、')} 有重复`);
    }
    const allPages = new Set(pages.map((p) => p.dataPage));
    if (unique.size === allPages.size && [...allPages].some((p) => !unique.has(p))) {
      errors.push(`靶子六屏没有覆盖实际六页：缺 ${[...allPages].filter((p) => !unique.has(p)).join('、')}`);
    }
    add('screens', '靶子六屏编号 01..06 齐全，且与六页一一对应', { errors, total: 7 });
  }

  // 8. 深色覆盖块存在，且核心变量都被覆盖。
  {
    const errors = [];
    const dark = darkVars(tokensText);
    if (!dark) {
      errors.push(`${TOKENS} 没有 prefers-color-scheme: dark 覆盖块`);
    } else {
      for (const name of ['color-canvas', 'color-surface', 'color-ink', 'color-primary', 'color-accent', 'color-muted', 'color-line']) {
        if (!dark.has(`--${name}`)) errors.push(`深色覆盖块缺 --${name}`);
      }
    }
    add('dark', 'tokens.css 有深色覆盖块，且核心变量都被覆盖', { errors, total: 8 });
  }

  // 9. 打印层：强制浅色底、关掉纸纹。
  {
    const errors = [];
    const items = [];
    if (!/@media\s+print/.test(printText)) errors.push(`${PRINT_CSS} 没有 @media print`);
    else {
      items.push('media');
      const block = /@media\s+print\s*\{([\s\S]*)\}\s*$/.exec(printText)?.[1] ?? printText;
      if (!/color-scheme:\s*light/.test(block)) errors.push(`${PRINT_CSS} 的 print 块没有强制 color-scheme: light`);
      if (!/--color-canvas:\s*var\(--print-surface\)/.test(block)) errors.push(`${PRINT_CSS} 的 print 块没有把 --color-canvas 强制成浅色纸面`);
      if (!/--color-surface:\s*var\(--print-surface\)/.test(block)) errors.push(`${PRINT_CSS} 的 print 块没有把 --color-surface 强制成浅色纸面`);
      if (!/background-image:\s*none/.test(block)) errors.push(`${PRINT_CSS} 的 print 块没有关闭纸纹背景`);
      if (!/break-inside:\s*avoid/.test(block)) errors.push(`${PRINT_CSS} 的 print 块没有保证卡片不跨页`);
      items.push('light', 'canvas', 'surface', 'texture', 'break');
    }
    if (!/--print-surface:\s*#ffffff/i.test(tokensText)) errors.push(`${TOKENS} 缺 --print-surface: #ffffff`);
    add('print', 'print.css 打印时强制浅色底、关纸纹、卡片不跨页', { errors, total: items.length + 1 });
  }

  const total = checks.reduce((sum, c) => sum + c.total, 0);
  const passed = checks.reduce((sum, c) => sum + c.passed, 0);
  const failed = total - passed;
  return { ok: errors.length === 0, checks, passed, failed, total, errors };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  // 用法：node scripts/check-visual.mjs [--root <dir>]，默认检查仓库根目录。
  const at = process.argv.indexOf('--root');
  const root = at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : DEFAULT_ROOT;
  const out = checkVisual(root);
  if (out.ok) {
    console.log(`visual-check: PASS (${out.passed}/${out.total} 项判定通过，${out.checks.length} 组)`);
  } else {
    console.error(`visual-check: FAIL (${out.passed}/${out.total} 项判定通过，${out.failed} 项失败)`);
    for (const e of out.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}
