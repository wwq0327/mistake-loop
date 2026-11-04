// #46 测试先行：几何图必须真的画到题卡上。
// 红灯预期：public/js/ui.js 的 questionCard() 没有任何 SVG 分支，
// 打印接口明明带着 geometry_svg，前端从头到尾没画过。
// 背景：老师录了长方形图、录了 geometry_spec、打印出来给学生做——
// 纸上只有题干和答题线，图没了。学生拿到的是一道没有图的题。
//
// 垫片放在 test/helpers/dom.mjs（与 #48 共用）：不引 jsdom（零依赖原则），
// 也不模拟浏览器渲染，只模拟「节点能不能被造出来、挂上去、走对顺序」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSource = readFileSync(join(here, '..', 'public', 'js', 'ui.js'), 'utf8');

import { installDom, SVG_NS } from './helpers/dom.mjs';

// 垫片装到 globalThis，页面代码里的 document / DOMParser 才有东西可用。
installDom();

const { questionCard } = await import('../public/js/ui.js');

const GEOMETRY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120" role="img" aria-label="题目几何图"><rect x="20" y="20" width="160" height="80" fill="none" stroke="currentColor" stroke-width="2" /><line x1="20" y1="100" x2="180" y2="100" stroke="currentColor" stroke-width="2" /><text x="90" y="60" font-size="14" fill="currentColor">8cm</text></svg>';

function findSvg(card) {
  return card.descendants().find((node) => node.localName === 'svg' && node.namespaceURI === SVG_NS);
}

test('#46 题卡里真的有内联 SVG 节点，不是文字、不是被丢掉的字段', () => {
  const card = questionCard({ id: 7, prompt: '求长方形面积', geometry_svg: GEOMETRY_SVG });
  const svg = findSvg(card);
  assert.ok(svg, '题卡里应有内联 SVG 节点');
  assert.equal(svg.getAttribute('viewBox'), '0 0 200 120', 'SVG 的 viewBox 应保留');
  assert.equal(svg.getAttribute('width'), '200');
  assert.equal(svg.getAttribute('role'), 'img', 'SVG 应保留无障碍角色');
});

test('#46 几何图里的三类图形都在（矩形、线段、文字）', () => {
  const card = questionCard({ id: 7, prompt: '求长方形面积', geometry_svg: GEOMETRY_SVG });
  const svg = findSvg(card);
  const tags = svg.descendants().map((node) => node.localName);
  for (const tag of ['rect', 'line', 'text']) {
    assert.ok(tags.includes(tag), `SVG 里应保留 ${tag}`);
  }
});

test('#46 SVG 必须内联在 DOM 里，页面代码不许用 innerHTML 拼', () => {
  assert.doesNotMatch(uiSource, /\.innerHTML\s*=/, '组件层禁止 innerHTML 赋值');
  const card = questionCard({ id: 7, prompt: 'x', geometry_svg: GEOMETRY_SVG });
  const svg = findSvg(card);
  assert.equal(svg.namespaceURI, SVG_NS, 'SVG 必须是 SVG 命名空间里的真节点');
});

test('#46 照片与几何图并存：两张都要出，顺序是照片在前', () => {
  const card = questionCard({
    id: 7,
    prompt: '看图作答',
    image_path: 'images/legacy/a.png',
    geometry_svg: GEOMETRY_SVG,
  });
  const img = card.descendants().find((node) => node.localName === 'img');
  const svg = findSvg(card);
  assert.ok(img, '照片要在');
  assert.ok(svg, '几何图也要在');
  const tags = card.children.map((node) => node.localName);
  assert.ok(tags.indexOf('img') < tags.indexOf('svg'), '照片排在几何图前面');
});

test('#46 没有几何图时不出空壳，也不报错', () => {
  const card = questionCard({ id: 7, prompt: '只有题干' });
  assert.equal(findSvg(card), undefined, '不该凭空造出 SVG');
  const withEmpty = questionCard({ id: 7, prompt: '只有题干', geometry_svg: '' });
  assert.equal(findSvg(withEmpty), undefined, '空字符串不该造出 SVG');
});

test('#46 非法 SVG 不炸、不出坏节点', () => {
  const broken = questionCard({ id: 7, prompt: 'x', geometry_svg: '这不是 SVG' });
  assert.equal(findSvg(broken), undefined, '非法内容不该被当成 SVG 节点');
  const unclosed = questionCard({ id: 7, prompt: 'x', geometry_svg: '<svg viewBox="0 0 10 10"><rect x="1"' });
  assert.equal(findSvg(unclosed), undefined, '残缺标签不该被当成 SVG 节点');
});

test('#46 几何图上的文字是文字节点，不会变成可执行元素', () => {
  const card = questionCard({
    id: 7,
    prompt: 'x',
    geometry_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="2">&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>',
  });
  const svg = findSvg(card);
  assert.ok(svg, 'SVG 应存在');
  const scripts = svg.descendants().filter((node) => node.localName === 'script');
  assert.equal(scripts.length, 0, '转义过的文字不能变成 script 元素');
});

test('#46 几何图节点带样式类，CSS 能给它尺寸约束', () => {
  const card = questionCard({ id: 7, prompt: 'x', geometry_svg: GEOMETRY_SVG });
  const svg = findSvg(card);
  const klass = svg.getAttribute('class') || svg.className || '';
  assert.match(klass, /qcard__figure/, 'SVG 应挂 .qcard__figure 以复用尺寸约束');
});
