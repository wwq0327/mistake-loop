// #44 测试先行：几何图不该写死色值，src/ 也不该有。
// 红灯预期：
//   1) renderGeometry() 输出里带 stroke="#333" / fill="#222" —— 绕开了设计令牌；
//   2) scripts/check-src-colors.mjs 还不存在，import 失败 —— src/ 是色值盲区。
// 背景：print.css 在 @media print 里把 --color-ink 重映射到 --print-ink，
// 几何图的字面色值不跟随，同一张纸上正文墨色跟着打印层走、图形墨色停在屏幕值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGeometry } from '../src/geometry.mjs';
import { checkSrcColors } from '../scripts/check-src-colors.mjs';

const SPEC = {
  width: 200,
  height: 120,
  shapes: [
    { type: 'rect', x: 20, y: 20, w: 160, h: 80 },
    { type: 'line', x1: 20, y1: 100, x2: 180, y2: 100 },
    { type: 'text', x: 90, y: 60, text: '8cm' },
  ],
};

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const FUNCTION_COLOR = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;

test('#44 几何图 SVG 里不出现十六进制色值', () => {
  const svg = renderGeometry(SPEC);
  const hex = svg.match(HEX_COLOR);
  assert.equal(hex, null, `几何图仍在写死色值：${hex ? hex.join(', ') : ''}`);
  assert.equal(FUNCTION_COLOR.test(svg), false, '几何图不应出现 rgb()/hsl()');
});

test('#44 几何图用 currentColor，跟随 --color-ink 与打印层重映射', () => {
  const svg = renderGeometry(SPEC);
  assert.match(svg, /stroke="currentColor"/, '线段与矩形应用 currentColor');
  assert.match(svg, /fill="currentColor"/, '文字应用 currentColor');
  // SVG 必须内联在 DOM 里才能拿到 currentColor：不能被包成 data URI 或外链。
  assert.doesNotMatch(svg, /data:image\/svg/, 'SVG 不该被转成 data URI');
});

test('#44 src/ 全量扫描：没有色值违规', () => {
  const out = checkSrcColors();
  assert.equal(out.ok, true, `src/ 出现硬编码色值：\n${out.violations.join('\n')}`);
  assert.ok(out.scanned > 0, '应当真的扫到文件');
});

test('#44 色值守护能抓出 src/ 里的十六进制色值，并点名文件与行号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-srccolor-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'ok.mjs'), "export const a = '没有色值';\n");
    writeFileSync(join(dir, 'bad.mjs'), "const color = '#333';\nexport default color;\n");
    writeFileSync(join(dir, 'lib', 'worse.mjs'), 'const c = "rgb(1, 2, 3)";\nexport default c;\n');

    const out = checkSrcColors(dir);
    assert.equal(out.ok, false, '有违规文件时必须判失败');
    assert.equal(out.violations.length, 2, `应报出 2 处违规，实际 ${JSON.stringify(out.violations)}`);
    assert.match(out.violations.join('\n'), /bad\.mjs/, '应点名文件');
    assert.match(out.violations.join('\n'), /worse\.mjs/, '应点名文件');
    assert.match(out.violations.join('\n'), /第 1 行/, '应点名行号');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#44 注释里提到色值不算违规——守护只盯代码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-srccolor-c-'));
  try {
    writeFileSync(join(dir, 'note.mjs'), "// 以前这里写死过 #333\n/* 曾经用过 rgb(0,0,0) */\nexport const a = 1;\n");
    const out = checkSrcColors(dir);
    assert.equal(out.ok, true, `注释不该被判违规：${out.violations.join('；')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#44 字符串里不是色值的 # 片段不算违规', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-srccolor-h-'));
  try {
    writeFileSync(join(dir, 'anchor.mjs'), "export const href = 'https://example.com/page#section';\n");
    const out = checkSrcColors(dir);
    assert.equal(out.ok, true, `URL 锚点不该被判违规：${out.violations.join('；')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
