// #45 测试先行：给 renderGeometry 补上零测试守护。
// 背景：几何图是学生版纸面上的东西，写错就是老师印错题。
//   - num() 的尺寸钳制一旦被改宽，一个坏数据就能让浏览器渲染出超大 SVG；
//   - escapeHtml 是唯一的注入防线，一旦被绕过，题目文本里的尖括号就能变成可执行内容；
//   - default 分支（未知 shape 类型跳过）是前向兼容兜底，改坏了不报错，只静默丢图形。
// 本 Issue 只补测试，不改实现；守护有没有牙齿用变异测试证明（见 Issue 评论）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGeometry } from '../src/geometry.mjs';

// ——————————————————————— 尺寸钳制 ———————————————————————

test('#45 宽高被夹在 50–2000 之间，坏数据进不来', () => {
  assert.match(renderGeometry({ width: 10, height: 10, shapes: [] }), /viewBox="0 0 50 50"/,
    '过小的宽高应被抬到下限 50');
  assert.match(renderGeometry({ width: 99999, height: 99999, shapes: [] }), /viewBox="0 0 2000 2000"/,
    '过大的宽高应被压到上限 2000');
});

test('#45 缺省与非法宽高走 fallback（宽 400、高 300）', () => {
  assert.match(renderGeometry({ shapes: [] }), /viewBox="0 0 400 300"/, '缺省宽高');
  assert.match(renderGeometry({ width: 'abc', height: undefined, shapes: [] }), /viewBox="0 0 400 300"/,
    '非数字宽高应退回 fallback');
  assert.match(renderGeometry({ width: NaN, height: undefined, shapes: [] }), /viewBox="0 0 400 300"/,
    'NaN 与 undefined 应退回 fallback');
});

test('#45 已知怪癖：null 被当成 0，宽高被压到下限而不是走 fallback', () => {
  // num() 用 Number() 转换，Number(null) 是 0（有限数），于是走不到 fallback。
  // 后果：宽高被钳到下限 50，而不是缺省的 400/300。属于待修缺陷，见 #47。
  assert.match(renderGeometry({ width: null, height: null, shapes: [] }), /viewBox="0 0 50 50"/,
    '当前实现把 null 当 0');
});

test('#45 数值字符串按数字处理，输出里不出现引号包着的数字', () => {
  const svg = renderGeometry({ width: '250', height: '150', shapes: [] });
  assert.match(svg, /viewBox="0 0 250 150"/);
  assert.doesNotMatch(svg, /viewBox="0 0 "250" "150""/);
});

// ——————————————————————— 三类图形 ———————————————————————

test('#45 线段：四个坐标与线宽都进 SVG', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'line', x1: 1, y1: 2, x2: 30, y2: 40, width: 3 }],
  });
  assert.match(svg, /<line x1="1" y1="2" x2="30" y2="40"[^>]*stroke-width="3"/);
});

test('#45 矩形：位置与宽高进 SVG，填充为 none', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'rect', x: 5, y: 6, w: 70, h: 80, width: 4 }],
  });
  assert.match(svg, /<rect x="5" y="6" width="70" height="80"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /stroke-width="4"/);
});

test('#45 文字：坐标、字号与内容进 SVG', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'text', x: 10, y: 20, size: 18, text: '8cm' }],
  });
  assert.match(svg, /<text x="10" y="20" font-size="18"[^>]*>8cm<\/text>/);
});

test('#45 缺省线宽 2、缺省字号 14', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }, { type: 'text', x: 0, y: 0, text: 'a' }],
  });
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /font-size="14"/);
});

// ——————————————————————— 注入转义 ———————————————————————

test('#45 文字里的尖括号、引号与 & 全部转义，输出里不出现裸尖括号', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'text', x: 0, y: 0, text: `<script>alert("x" & 'y')</script>` }],
  });
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;x&quot;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /&#39;/);
  // 除了 SVG 自身的标签，文本部分不许再出现裸尖括号。
  const text = /<text[^>]*>(.*?)<\/text>/s.exec(svg);
  assert.ok(text, '应能取到文字节点');
  assert.doesNotMatch(text[1], /[<>]/, '文字内容里不许有裸尖括号');
  assert.doesNotMatch(svg, /<script/i, 'SVG 里不许冒出 script 标签');
});

test('#45 缺省文字与 null 文字不炸', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'text', x: 0, y: 0 }],
  });
  assert.match(svg, /<text x="0" y="0"[^>]*><\/text>/, '缺省文字应是空字符串');
  const nullText = renderGeometry({
    width: 100, height: 100,
    shapes: [{ type: 'text', x: 0, y: 0, text: null }],
  });
  assert.match(nullText, /<text x="0" y="0"[^>]*><\/text>/, 'null 文字应是空字符串');
});

// ——————————————————————— 兜底 ———————————————————————

test('#45 spec 不是对象时返回空串，不抛异常', () => {
  for (const bad of [null, undefined, 'abc', 42, true]) {
    assert.equal(renderGeometry(bad), '', `${JSON.stringify(bad)} 应返回空串`);
  }
});

test('#45 shapes 不是数组时给出一个空 SVG，不抛异常', () => {
  const svg = renderGeometry({ width: 100, height: 100, shapes: 'nope' });
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /<line|<rect|<text/);
});

test('#45 未知 shape 类型被跳过，不影响其它图形', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [
      { type: 'polygon', points: '0,0 1,1' },
      { type: 'line', x1: 1, y1: 1, x2: 2, y2: 2 },
    ],
  });
  assert.doesNotMatch(svg, /polygon/i);
  // 整个 SVG 里只该有 svg 根与那一条线：未知类型不许产出任何元素。
  const elements = [...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  assert.deepEqual(elements, ['svg', 'line'], '未知类型不该产出任何元素');
  assert.match(svg, /<line x1="1" y1="1" x2="2" y2="2"/);
});

test('#45 SVG 自带无障碍信息与命名空间', () => {
  const svg = renderGeometry({ width: 100, height: 100, shapes: [] });
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="题目几何图"/);
});

// ——————————————————————— 数值收敛 ———————————————————————

test('#45 坐标数值收敛：输出里不出现 NaN 与 undefined 字面量', () => {
  const svg = renderGeometry({
    width: 100, height: 100,
    shapes: [
      { type: 'line', x1: 'x', y1: undefined, x2: NaN, y2: null },
      { type: 'rect', x: 'y', y: undefined, w: NaN, h: null },
      { type: 'text', x: 'z', y: undefined, size: NaN, text: 't' },
    ],
  });
  assert.doesNotMatch(svg, /NaN/);
  assert.doesNotMatch(svg, /undefined/);
  assert.doesNotMatch(svg, /"null"/);
});
