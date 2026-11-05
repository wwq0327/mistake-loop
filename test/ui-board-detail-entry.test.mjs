// #62 测试先行：从看板点进详情，首屏先给「现在该做什么」；回来时筛选还在。
//
// 背景：看板能看见一道题停在哪一列，点进去却是原来那张「一道题的一生」——
// 原图、诊断、变式、留痕平铺在一页，老师得自己判断该往下按哪个按钮。
// 五种状态要的东西完全不同：待诊断要记错因，诊断中要记学生结论，
// 纠错中要审变式，复习中要去做复习，已掌握只能回看证据。
//
// 这份测试盯三件事：
//   1) 首屏有没有「当前阶段 + 一个主入口」，且这个入口对得上状态；
//   2) 不该给的动作不许出现在主入口里（复习中/已掌握不能有诊断主按钮）；
//   3) 从详情返回看板，学科与手机阶段还在——否则每次回来都要重选一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDom, textOf } from './helpers/dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const dom = installDom({ location: { pathname: '/mistake/7', search: '' } });

// 详情页的区块：与 public/detail.html 保持一致，多一块 #detail-next 给首屏动作。
const BLOCK_IDS = [
  'detail-next',
  'detail-gate',
  'detail-basics',
  'detail-diagnosis',
  'detail-variants',
  'detail-reviews',
  'detail-evidence',
];
for (const id of BLOCK_IDS) {
  const section = dom.byId(id);
  const body = dom.document.createElement('div');
  body.className = 'card__body';
  section.append(body);
  dom.body.append(section);
}
dom.body.append(dom.byId('view'));

// 真实页面里原图长在 #detail-basics 的 card__body 内（见 public/detail.html）。
// 垫片早先的 getElementById 永远有返回值，把「节点已被清掉」这件事掩盖成了不报错，
// 所以这里必须按真实结构把 img 放进区块里，才能测出「清空时把原图一起清掉」。
const basicsBody = dom.byId('detail-basics').descendants().find((n) => n.classList.contains('card__body'));
const pageImage = dom.document.createElement('img');
pageImage.id = 'detail-image';
basicsBody.append(pageImage);

const { mount } = await import('../public/js/pages/detail.js');
const { mountBoard } = await import('../public/js/pages/board.js');

// sessionStorage 垫片：真浏览器里看板用它记住筛选，测试里也要有一份可读写的。
function installSessionStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => store.clear(),
  };
  return store;
}

function baseItem(overrides = {}) {
  return {
    id: 7,
    subject: 'math',
    prompt: '计算：208 × 34 = ?',
    status: 'new',
    student_conclusion: '',
    error_category: null,
    error_subtype: null,
    error_reason: null,
    review_round: 0,
    next_review: null,
    image_path: null,
    unit_title: '第四单元',
    unit_no: 4,
    lesson_title: '三位数乘两位数',
    page_no: '12',
    textbook_node_id: null,
    variants: [],
    review_events: [],
    sessions: [],
    mastery_evidence: [],
    ...overrides,
  };
}

function fakeApi(item, { failItem = false, failMeta = false } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (path === '/api/meta') {
      if (failMeta) throw new Error('元数据没读到');
      return { variantRules: { math: {} }, errorSubtypes: { math: {} }, diagnosableStatuses: ['new', 'diagnosing', 'correcting'] };
    }
    if (path.startsWith('/api/mistakes/')) {
      if (failItem) throw new Error('服务器没回应');
      return item;
    }
    throw new Error(`不该调这个接口：${path}`);
  };
  return { api, calls };
}

function nextBlock() {
  const section = dom.byId('detail-next');
  return section.descendants().find((n) => n.classList.contains('card__body')) ?? section;
}

function nextAction() {
  return nextBlock().querySelector('[data-next-action]');
}

async function mountDetail(item, options = {}) {
  const root = dom.byId('view');
  const { api, calls } = fakeApi(item, options);
  await mount({ root, api });
  return { api, calls, root };
}

// ── 一、五种状态的首屏主入口 ────────────────────────────────────────────────

const EXPECTED = [
  { status: 'new', action: 'diagnose', label: /诊断/, stage: '待诊断' },
  { status: 'diagnosing', action: 'conclusion', label: /结论/, stage: '诊断中' },
  { status: 'correcting', action: 'variants', label: /变式/, stage: '纠错中' },
  { status: 'reviewing', action: 'review', label: /复习/, stage: '复习中' },
  { status: 'mastered', action: 'evidence', label: /证据/, stage: '已掌握' },
];

for (const expected of EXPECTED) {
  test(`#62 ${expected.stage}的题，首屏主入口指向「${expected.action}」`, async () => {
    const item = baseItem({
      status: expected.status,
      student_conclusion: expected.status === 'new' ? '' : '学生说：单位没换算',
      review_round: expected.status === 'reviewing' ? 2 : 0,
      next_review: expected.status === 'reviewing' ? '2026-11-12' : null,
    });
    await mountDetail(item);

    const action = nextAction();
    assert.ok(action, `${expected.stage}的题应该有主入口`);
    assert.equal(action.getAttribute('data-next-action'), expected.action,
      `主入口应是 ${expected.action}，实际是 ${action.getAttribute('data-next-action')}`);
    assert.match(textOf(nextBlock()), expected.label, '主入口附近要说清这一步做什么');
  });
}

test('#62 首屏先说清「当前阶段」，再说缺口，最后才是入口', async () => {
  for (const expected of EXPECTED) {
    await mountDetail(baseItem({
      status: expected.status,
      student_conclusion: expected.status === 'new' ? '' : '学生说：单位没换算',
      review_round: expected.status === 'reviewing' ? 2 : 0,
    }));
    const text = textOf(nextBlock());
    assert.match(text, new RegExp(`当前阶段[：:]\\s*${expected.stage}`),
      `${expected.stage} 的首屏要写明当前阶段，实际：${text}`);
  }
});

test('#62 复习中与已掌握不许出现诊断主按钮', async () => {
  for (const status of ['reviewing', 'mastered']) {
    await mountDetail(baseItem({ status, student_conclusion: '学生说：单位没换算', review_round: 4 }));
    const text = textOf(nextBlock());
    assert.doesNotMatch(text, /保存并进入纠错中|记诊断|只保存错因/,
      `${status} 的首屏不许给诊断类入口——给了也只会被后端 409 拒回来`);
    const action = nextAction();
    assert.ok(action, `${status} 也要有一个可做的事（复习或回看证据）`);
  }
});

test('#62 诊断中但结论为空：主入口说清缺口，不假装能推进', async () => {
  await mountDetail(baseItem({ status: 'diagnosing', student_conclusion: '' }));
  const text = textOf(nextBlock());
  assert.match(text, /结论/, '要指出缺的是学生结论');
  assert.match(text, /还差|没填|不能/, '要说清现在还不能往下走');
});

// ── 二、主入口真的能到地方 ─────────────────────────────────────────────────

test('#62 清空原题区块不许把原图一起清掉，后面的区块还得渲染', async () => {
  // 真实页面里 img#detail-image 就长在 #detail-basics 的 card__body 内。
  // 早先这里 replaceChildren() 把它一起清掉，紧接着 getElementById 拿到 null，
  // 一个 TypeError 把整页后面（教材定位、诊断、变式、留痕、证据）全卡住不渲染；
  // 而测试垫片会为任何 id 现造一个节点，永远不返回 null，于是这条一直没被发现。
  await mountDetail(baseItem({ status: 'diagnosing', image_path: 'images/1.jpg' }));

  const img = dom.body.querySelector('#detail-image');
  assert.ok(img, '原图节点必须仍在页面上');
  // 必须是「原来那个」节点，不是被换成了一个新 img。
  // 真浏览器里被清掉的节点查回来是 null，直接 TypeError 把后面全卡住；
  // 垫片的 getElementById 会为任何 id 现造节点，所以这里只能靠身份来认。
  assert.equal(img, pageImage, '原图节点被换掉了——真实浏览器里这一步就是 null 崩溃');
  assert.equal(img.hidden, false, '有原图时不该被隐藏');
  assert.equal(img.src, '/images/1.jpg', '原图地址要指到这道题的图上');
  assert.ok(dom.body.querySelector('#detail-category'), '诊断区必须真的渲染出来，不能卡在前一步');

  const evidence = dom.byId('detail-evidence').descendants().find((n) => n.classList.contains('card__body'));
  assert.match(textOf(evidence), /还差|证据/, '掌握证据区也要渲染到位');
});
test('#62 点主入口会滚到对应区域并把焦点交给该填的控件', async () => {
  await mountDetail(baseItem({ status: 'new' }));
  const action = nextAction();
  action.click();

  const target = dom.byId('detail-diagnosis');
  assert.ok(target.scrolled || action.scrolled, '点主入口应滚到诊断区');

  const field = dom.body.querySelector('#detail-category');
  assert.ok(field, '诊断区应该有错因大类控件');
  assert.equal(field.focused, true, '焦点应落在错因大类上，键盘用户不用自己找');
});

test('#62 主入口是可聚焦控件，不是只能看的色块', async () => {
  await mountDetail(baseItem({ status: 'correcting' }));
  const action = nextAction();
  assert.ok(action.localName === 'button' || (action.localName === 'a' && action.getAttribute('href')),
    `主入口必须是 button 或带 href 的链接，实际是 ${action.localName}`);
});

// ── 三、加载与失败要分得开 ─────────────────────────────────────────────────

test('#62 读取失败要说人话并给重试，重试会重新请求', async () => {
  const root = dom.byId('view');
  const { api, calls } = fakeApi(baseItem(), { failItem: true });
  await mount({ root, api });

  // 失败提示必须在首屏，不能落在页面最底部的 #view 里（那里等于看不见）。
  const text = textOf(dom.byId('detail-next'));
  assert.match(text, /没读到|失败|服务器没回应/, `失败要说人话，实际：${text}`);
  const retry = nextBlock().descendants().find((n) => n.localName === 'button' && textOf(n).includes('重试'));
  assert.ok(retry, '失败要给重试按钮');

  const before = calls.length;
  retry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.length > before, '点重试应该真的再请求一次');
});

test('#62 读的过程中要让人看见在加载，不是一片空白', async () => {
  const root = dom.byId('view');
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const api = async (path) => {
    if (path === '/api/meta') return { variantRules: {}, errorSubtypes: {}, diagnosableStatuses: ['new'] };
    await pending;
    return baseItem();
  };
  const mounting = mount({ root, api });
  // 还没等到数据时，屏幕上得有「正在读取」。
  assert.match(textOf(dom.body), /正在读取|加载/, '请求在途时要有加载提示');
  release();
  await mounting;
});

test('#62 样式表里的 [hidden] 要真的隐藏，别被组件类的 display 压过去', () => {
  // 详情页横幅退场用的是 hidden 属性。浏览器默认的 [hidden]{display:none}
  // 属于用户代理样式，而 .alert{display:flex} 这类作者样式会把它压过去，
  // 元素标了 hidden 还照样显示——必须自己写一条带 !important 的规则。
  const base = readFileSync(join(REPO, 'public/css/base.css'), 'utf8');
  assert.match(base, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/,
    'base.css 必须让 [hidden] 强制 display:none');

  const components = readFileSync(join(REPO, 'public/css/components.css'), 'utf8');
  assert.match(components, /\.alert\s*\{[^}]*display:\s*flex/,
    '.alert 用了 display:flex，所以上面那条 !important 才算数');
});

// ── 四、从详情回到看板，筛选还在 ───────────────────────────────────────────
function boardApi() {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/meta') return { stats: { total: 2, byStatus: { new: 1, correcting: 1 } } };
    if (path === '/api/reviews/today') return { date: '2026-11-05', total: 0, items: [] };
    return { total: 2, items: [baseItem({ id: 1, status: 'new' }), baseItem({ id: 2, status: 'correcting', subject: 'chinese' })] };
  };
  return { api, calls };
}

test('#62 看板记住学科与手机阶段，从详情回来不用重选', async () => {
  installSessionStorage();
  const first = dom.document.createElement('div');
  const { api, calls } = boardApi();
  const controller = await mountBoard({ root: first, api });
  await controller.setSubject('chinese');
  await controller.setStage('correcting');

  // 重新挂载 = 老师点进详情又返回看板。
  const second = dom.document.createElement('div');
  await mountBoard({ root: second, api });

  const pressed = second.querySelectorAll('[aria-pressed="true"]').map((n) => n.getAttribute('data-subject') ?? n.getAttribute('data-stage'));
  assert.ok(pressed.includes('chinese'), `学科应恢复成语文，实际选中：${pressed.join(',')}`);
  assert.ok(pressed.includes('correcting'), `阶段应恢复成纠错中，实际选中：${pressed.join(',')}`);
  assert.ok(calls.includes('/api/mistakes?subject=chinese'), '恢复后应按学科重新取数');
});

test('#62 存储里是脏值就当没存过，不许白屏或错列', async () => {
  installSessionStorage({ 'mistake-loop:board-filters': '{"subject":"history","stage":"不存在的阶段"}' });
  const root = dom.document.createElement('div');
  const { api, calls } = boardApi();
  await mountBoard({ root, api });

  const pressed = root.querySelectorAll('[aria-pressed="true"]').map((n) => n.getAttribute('data-subject') ?? n.getAttribute('data-stage'));
  assert.ok(pressed.includes('all'), `脏值要回落到全部，实际：${pressed.join(',')}`);
  assert.ok(pressed.includes('reviewing'), `脏值要回落到复习中，实际：${pressed.join(',')}`);
  assert.ok(calls.includes('/api/mistakes'), '回落成全部时应取全量');
});

test('#62 存储里不是合法 JSON 也不许把看板弄挂', async () => {
  installSessionStorage({ 'mistake-loop:board-filters': '{这不是 json' });
  const root = dom.document.createElement('div');
  const { api } = boardApi();
  await mountBoard({ root, api });
  assert.ok(root.querySelectorAll('.board__col').length > 0, '解析失败也要照常渲染看板');
});
