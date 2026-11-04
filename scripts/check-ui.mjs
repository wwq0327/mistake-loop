// UI 静态规范检查：零依赖、只读、不联网。
// 规则来自 PRD U1-U8 与 CONTRIBUTING 第二节；由 npm run check 与 CI 共同执行。
// 用法：node scripts/check-ui.mjs [--root <dir>]，默认检查 public/。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', 'public');

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const FUNCTION_COLOR = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;
const UNSAFE_DOM = [
  [/\.innerHTML\s*=/, '出现 innerHTML 赋值（用户输入必须走 textContent）'],
  [/document\.write\s*\(/, '出现 document.write'],
  [/\beval\s*\(/, '出现 eval'],
];

export function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path));
    else if (/\.(?:html|css|js)$/i.test(entry)) out.push(path);
  }
  return out;
}

function checkHtml(path, text, violations) {
  const name = relative(process.cwd(), path) || path;
  const required = [
    [/lang="zh-CN"/, '缺 lang="zh-CN"'],
    [/name="viewport"/, '缺 viewport'],
    [/<h1[\s>]/, '缺 h1'],
    [/<nav[\s>]/, '缺 nav'],
    [/<label[\s>]/, '缺 label'],
    [/tokens\.css/, '未引用 tokens.css'],
    [/\/js\/router\.js/, '未挂载 router.js'],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(text)) violations.push(`${name}: ${message}`);
  }
  for (const label of text.matchAll(/<label\b([^>]*)>/g)) {
    if (!/\bfor="[^"]+"/.test(label[1])) violations.push(`${name}: label 缺 for 属性`);
  }
  for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const inline = match[1];
    if (inline.match(HEX_COLOR) || inline.match(FUNCTION_COLOR)) {
      violations.push(`${name}: 内联 style 含硬编码色值（色值只允许写在 tokens.css）`);
    }
  }
  if (/\.innerHTML\s*=/.test(text)) violations.push(`${name}: 页面内联脚本含 innerHTML 赋值`);
}

function checkCss(path, text, violations) {
  const name = relative(process.cwd(), path) || path;
  const hex = [...text.matchAll(HEX_COLOR)].map((m) => m[0]);
  const fn = [...text.matchAll(FUNCTION_COLOR)].map((m) => m[0]);
  if (hex.length || fn.length) {
    violations.push(`${name}: 硬编码色值 ${[...hex, ...fn].join(', ')}（只允许写在 tokens.css）`);
  }
}

function checkJs(path, text, violations) {
  const name = relative(process.cwd(), path) || path;
  for (const [pattern, message] of UNSAFE_DOM) {
    if (pattern.test(text)) violations.push(`${name}: ${message}`);
  }
}

export function checkUi(rootDir = DEFAULT_ROOT) {
  const violations = [];
  const files = collectFiles(rootDir);
  const counts = { html: 0, css: 0, js: 0 };
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (path.endsWith('.html')) {
      counts.html += 1;
      checkHtml(path, text, violations);
    } else if (path.endsWith('.css')) {
      counts.css += 1;
      if (!path.endsWith('tokens.css')) checkCss(path, text, violations);
    } else if (path.endsWith('.js')) {
      counts.js += 1;
      checkJs(path, text, violations);
    }
  }
  return { violations, counts };
}

function argRoot(argv) {
  const index = argv.indexOf('--root');
  return index >= 0 && argv[index + 1] ? resolve(argv[index + 1]) : DEFAULT_ROOT;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = argRoot(process.argv);
  const { violations, counts } = checkUi(root);
  if (violations.length) {
    for (const line of violations) console.log(`[UI-CHECK] 违规：${line}`);
    console.log(`ui-check: FAIL (${violations.length} 处，html=${counts.html} css=${counts.css} js=${counts.js})`);
    process.exitCode = 1;
  } else {
    console.log(`ui-check: PASS (html=${counts.html} css=${counts.css} js=${counts.js})`);
  }
}
