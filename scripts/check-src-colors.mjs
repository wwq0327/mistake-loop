// #44 实现：src/ 色值守护。
// 背景：scripts/check-ui.mjs 只扫 public/，src/ 一直是色值盲区——
// src/geometry.mjs 里的 stroke="#333" / fill="#222" 就是这么活下来的。
// 规矩：色值只允许写在 public/css/tokens.css（U1）。服务端生成 SVG、
// 拼内联样式时一律用 currentColor 或 CSS 变量，让出纸层与深色模式能接管。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', 'src');

// 十六进制色值：#rgb / #rgba / #rrggbb / #rrggbbaa。
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const FUNCTION_COLOR = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;

// 注释里提到色值不算违规——守护只盯会执行的代码。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path));
    else if (entry.endsWith('.mjs')) out.push(path);
  }
  return out;
}

export function checkSrcColors(rootDir = DEFAULT_ROOT) {
  const violations = [];
  const files = collectFiles(rootDir);
  for (const path of files) {
    const name = relative(process.cwd(), path) || path;
    const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(HEX_COLOR)) {
        violations.push(`${name} 第 ${index + 1} 行：硬编码色值 ${match[0]}（色值只允许写在 public/css/tokens.css）`);
      }
      for (const match of line.matchAll(FUNCTION_COLOR)) {
        violations.push(`${name} 第 ${index + 1} 行：硬编码色值 ${match[0]}…（色值只允许写在 public/css/tokens.css）`);
      }
    });
  }
  return { ok: violations.length === 0, violations, scanned: files.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = checkSrcColors();
  if (out.ok) {
    console.log(`src-color-check: PASS (${out.scanned} 个文件)`);
  } else {
    console.error(`src-color-check: FAIL (${out.violations.length} 处)`);
    for (const line of out.violations) console.error(`  - ${line}`);
    process.exitCode = 1;
  }
}
