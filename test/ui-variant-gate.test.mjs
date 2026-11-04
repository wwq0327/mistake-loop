// #52 前端红灯测试：变式审核按钮只在「纠错中」出现。
// 背景：后端加了闸门（PATCH /api/variants/:id/review 在非 correcting 状态返回 409），
// 但前端的「审核通过」按钮原来只看「这条变式审没审过」，不看题的状态——
// 于是老师在新录入的题上点审核，只会收到一句「当前状态是「新录入」，不能审核变式」。
// 界面要自己就把话说清楚，而不是让老师去撞后端的 409。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

const dom = installDom({ location: { pathname: '/mistake/7', search: '' } });
const { mount } = await import('../public/js/pages/detail.js');

// detail 页的六个区块：先照 detail.html 的结构造出「区块 + .card__body」，
// 页面代码用 bodyOf(id) 找内容区，结构不对它会渲染到找不到的地方。
// 区块要挂到 body 上：后代选择器是从 document.body 往下找的，
// 只在 registry 里而不在树上，querySelector('#detail-variants .card__body') 就找不到。
const BLOCK_IDS = ['detail-gate', 'detail-basics', 'detail-diagnosis', 'detail-variants', 'detail-reviews', 'detail-evidence'];
for (const id of BLOCK_IDS) {
  const section = dom.byId(id);
  const body = dom.document.createElement('div');
  body.className = 'card__body';
  section.append(body);
  dom.body.append(section);
}
dom.body.append(dom.byId('view'));

function baseItem(overrides = {}) {
  return {
    id: 7,
    subject: 'math',
    prompt: '一道题',
    status: 'correcting',
    student_conclusion: '学生自己说：单位没换算',
    error_category: 'conceptual',
    error_subtype: '单位混淆',
    error_reason: '看错单位',
    review_round: 0,
    next_review: null,
    image_path: null,
    unit_title: null,
    unit_no: null,
    lesson_title: null,
    page_no: null,
    textbook_node_id: null,
    variants: [
      { id: 71, level: 'surface', prompt: '换数字', correct_answer: '8', reviewed: 0, result: null },
    ],
    review_events: [],
    sessions: [],
    mastery_evidence: [],
    ...overrides,
  };
}

function fakeApi(item) {
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method });
    if (path === '/api/meta') return { variantRules: { math: {} }, errorSubtypes: { math: {} } };
    if (path.startsWith('/api/mistakes/')) return item;
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  return { api, calls };
}

function buttonsIn(node) {
  return node.descendants().filter((n) => n.localName === 'button');
}

// 在整页里找：变式区渲染进 detail-variants 区块，不在 view 里。
function findButton(label) {
  return buttonsIn(dom.body).find((b) => String(b.textContent || '').includes(label));
}

// 只看变式区块的文案：整页里别处也有「纠错中」三个字（五态进度条），
// 拿整页断言等于没断言——变异验证里这条就是这么漏掉的。
function variantsBlockText() {
  const section = dom.byId('detail-variants');
  const body = section.descendants().find((n) => n.classList.contains('card__body'));
  return textOf(body);
}

test('#52 纠错中的题给「审核通过」按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'correcting' }));
  await mount({ root, api });

  const review = findButton('审核通过');
  assert.ok(review, '纠错中的题应有「审核通过」按钮');
  assert.equal(review.disabled, false, '纠错中的题审核按钮不该置灰');
});

test('#52 新录入的题不给审核按钮，并说清要先推进到能审核的状态', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'new', student_conclusion: null }));
  await mount({ root, api });

  assert.equal(findButton('审核通过'), undefined, '新录入的题不该给审核按钮');
  assert.match(variantsBlockText(), /诊断中/, '变式区要告诉老师要先推进到诊断中');
  assert.match(variantsBlockText(), /变式审核/, '变式区要说明现在不能审核');
});

test('#52 诊断中的题给审核按钮：v1 的接口流程走的就是这条路', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'diagnosing' }));
  await mount({ root, api });

  const review = findButton('审核通过');
  assert.ok(review, '诊断中的题应有「审核通过」按钮');
  assert.equal(review.disabled, false, '诊断中的题审核按钮不该置灰');
});

test('#52 复习中的题不给审核按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'reviewing', review_round: 2 }));
  await mount({ root, api });

  assert.equal(findButton('审核通过'), undefined, '复习中的题不该给审核按钮');
});

test('#52 已掌握的题不给审核按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'mastered' }));
  await mount({ root, api });

  assert.equal(findButton('审核通过'), undefined, '已掌握的题不该给审核按钮');
});
