// #20 测试先行：题目详情页五态进度与一题一生。
// 红灯预期：detail.html 缺五态节点 / 闸门区 / 四个关联区块，detail.js 未渲染四个列表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'public', 'detail.html'), 'utf8');
const js = readFileSync(join(root, 'public', 'js', 'pages', 'detail.js'), 'utf8');

test('详情页骨架含五个状态节点，且顺序与状态机一致', () => {
  const steps = [...html.matchAll(/data-step="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered']);
  assert.match(html, /class="progress__step"/);
});

test('闸门提示区明确写「还差什么才能往下走」', () => {
  assert.match(html, /id="detail-gate"/);
  assert.match(html, /还差|才能/);
  assert.match(js, /nextRequirement|还差/, 'JS 未计算缺口');
});

test('一页看全原图、题干、教材定位、诊断、变式审核、复习事件、掌握证据', () => {
  for (const id of ['detail-basics', 'detail-diagnosis', 'detail-variants', 'detail-reviews', 'detail-evidence']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺区块 ${id}`);
  }
  assert.match(html, /<img\b/, '缺原图元素');
  assert.match(js, /教材定位|unit_title/, '未渲染教材定位');
  assert.match(js, /student_conclusion/, '未渲染学生结论');
});

test('GET /api/mistakes/:id 的四个关联列表都被消费', () => {
  assert.match(js, /\/api\/mistakes\//);
  for (const key of ['variants', 'review_events', 'sessions', 'mastery_evidence']) {
    assert.match(js, new RegExp(`\\b${key}\\b`), `未渲染 ${key}`);
  }
});

test('学生结论为空时界面禁止推进到纠错中', () => {
  assert.match(js, /student_conclusion/, '未读取学生结论');
  assert.match(js, /disabled\s*=\s*true|\.disabled\s*=/, '未禁用推进按钮');
  assert.match(js, /纠错中/, '缺状态文案');
  assert.match(js, /is-current/, '当前态未高亮');
});
