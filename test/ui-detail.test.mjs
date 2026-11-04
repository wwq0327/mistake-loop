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

// #40：变式录入入口。原来只有审核，没有录入，闭环走不到「复习中」。
test('#40 详情页有变式录入表单：三层各一个输入框与提交按钮', () => {
  assert.match(js, /\/variants/, '没有调用变式录入接口');
  assert.match(js, /POST|\.post\(|method:\s*'POST'/, '录入变式应走 POST');
  for (const level of ['surface', 'structure', 'context']) {
    assert.match(js, new RegExp(level), `缺 ${level} 层`);
  }
  assert.match(js, /input|textarea/, '缺题干输入控件');
  assert.match(js, /field__hint|出题方向/, '缺出题方向提示');
});

test('#40 录入时带上这一层的 level 与题干', () => {
  assert.match(js, /level/, '请求体应带 level');
  assert.match(js, /prompt/, '请求体应带 prompt');
  assert.match(js, /variants:\s*\[/, '请求体应是变式数组');
  assert.match(js, /correct_answer/, '请求体应带参考答案');
  assert.match(js, /variant-prompt-/, '题干输入框应有可绑定的 id');
  assert.match(js, /variantRules/, '出题方向应取自服务端字典，不在前端硬编码');
});

test('#40 变式录入的界面控件沿用既有组件类，不写死宽度', () => {
  assert.match(js, /'field'/, '应复用 .field 容器');
  assert.match(js, /'input'|'textarea'|'select'/, '应复用既有表单控件类');
  assert.doesNotMatch(js, /style\.width\s*=\s*['"]\d/, '不应写死宽度');
});


test('#41 详情页有错因录入：大类、分类与说明', () => {
  assert.match(js, /error_category/, '未读写错因大类');
  assert.match(js, /error_subtype/, '未读写错因子类型');
  assert.match(js, /error_reason/, '未读写错因说明');
});

test('#41 错因子类的选项取自服务端字典，按科目分列', () => {
  assert.match(js, /errorSubtypes/, '子类选项应取自 /api/meta 的 errorSubtypes');
  assert.match(js, /select/, '应有下拉控件');
  assert.match(js, /change/, '大类变了子类选项要跟着变');
});

test('#41 没改动的错因字段不随提交送出，避免误清空', () => {
  assert.match(js, /causePayload|error_category\s*!==|!==\s*item\.error_category/, '应只送改动过的错因字段');
});
