// #63 测试先行：到期题在看板上直接记做对/做错，写完再读回，按服务端结果归列。
//
// 背景：看板只呈现状态，复习登记还留在工作台那张「今日复习」列表里，
// 老师看完板发现「这题今天到期」，还得滚下去另找一遍。
//
// 这份测试盯的是「写与读的一致性」，也是这类界面最容易骗人的地方：
//   - 写成功了就当自己知道了，不去读回，凭猜把卡片挪列
//   - 写失败或读回失败时也把卡片挪了、把计数改了
//   - 第 4 轮做对预选一个证据，替老师把话说死
//   - 请求在飞时还能连点，一次复习记成两轮
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

const dom = installDom();

// toast 在真页面里挂在 body 上的 #toast-host；这里照做，否则读不到提示。
const toastHost = dom.byId('toast-host');
dom.body.append(toastHost);

const { mountBoard } = await import('../public/js/pages/board.js');
const { ApiError } = await import('../public/js/api.js');

const TODAY = '2026-11-05';

function item(overrides = {}) {
  return {
    id: 7,
    subject: 'math',
    prompt: '计算：672 ÷ 28 = ?',
    status: 'reviewing',
    review_round: 1,
    next_review: TODAY,
    unit_title: '第六单元',
    lesson_title: '除数是两位数的除法',
    page_no: '12',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = (ticks = 3) => new Promise((resolve) => {
  let n = ticks;
  const step = () => (n-- <= 0 ? resolve() : setImmediate(step));
  setImmediate(step);
});

/**
 * 看板的三个读接口 + 一个写接口。
 * onPost 决定写入返回什么；peek 可以改下一次 /api/mistakes 的返回（模拟服务端已变）。
 */
function makeApi({ mistakes = [], reviews = null, onPost = null } = {}) {
  const calls = [];
  let currentItems = mistakes;
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (path === '/api/meta') {
      return { stats: { total: currentItems.length, byStatus: {} }, evidenceKinds: ['retell', 'transfer'] };
    }
    if (path === '/api/reviews/today') {
      return reviews ?? { date: TODAY, total: 0, items: [] };
    }
    if (path.startsWith('/api/reviews/') && method === 'POST') {
      if (!onPost) throw new Error(`不该提交：${path}`);
      return onPost({ path, body: options.body, setItems: (next) => { currentItems = next; } });
    }
    if (path.startsWith('/api/mistakes')) {
      return { total: currentItems.length, items: currentItems };
    }
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  return { api, calls };
}

function cardOf(id) {
  return dom.document.querySelector(`[data-mistake-id="${id}"]`);
}

function buttonIn(node, label) {
  return node?.descendants().find((n) => n.localName === 'button' && textOf(n).includes(label));
}

// 每个用例换一块干净屏幕：把根节点挂进 body（页面代码只往传进来的 root 里画，
// 不挂进文档的话 querySelector 什么也找不到），同时保留 #toast-host。
function resetScreen() {
  dom.body.replaceChildren();
  dom.body.append(dom.byId('toast-host'));
  const root = dom.document.createElement('div');
  dom.body.append(root);
  return root;
}

async function mountWith(config) {
  const root = resetScreen();
  const { api, calls } = makeApi(config);
  const controller = await mountBoard({ root, api });
  return { root, api, calls, controller };
}

// ── 一、哪张卡上有登记入口 ──────────────────────────────────────────────────

test('#63 到期的题在卡片上直接给做对/做错', async () => {
  const due = item();
  const { root } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 3 }] },
  });

  const card = cardOf(7);
  assert.ok(card, '卡片要在');
  assert.ok(buttonIn(card, '做对'), '到期题要有「做对」');
  assert.ok(buttonIn(card, '做错'), '到期题要有「做错」');
});

test('#63 没到期的题不给登记入口，只显示下次复习日', async () => {
  const later = item({ next_review: '2026-11-12' });
  const { root } = await mountWith({
    mistakes: [later],
    reviews: { date: TODAY, total: 0, items: [] },
  });

  const card = cardOf(7);
  assert.equal(buttonIn(card, '做对'), undefined, '没到期不该给「做对」');
  assert.equal(buttonIn(card, '做错'), undefined, '没到期不该给「做错」');
  assert.match(textOf(card), /下次复习 2026-11-12/, '没到期要说清下次是哪天');
});

// ── 二、第 4 轮的证据必须老师自己选 ────────────────────────────────────────

test('#63 第 4 轮做对必须先选证据，下拉不许预选', async () => {
  const last = item({ review_round: 3 });
  const { root, calls } = await mountWith({
    mistakes: [last],
    reviews: { date: TODAY, total: 1, items: [{ ...last, overdue_days: 1 }] },
  });

  const card = cardOf(7);
  const select = card.querySelector('select');
  assert.ok(select, '末轮做对要有一个证据下拉');
  assert.equal(select.value, '', `证据下拉不许预选，实际是「${select.value}」`);
  const selected = select.descendants().filter((n) => n.selected);
  assert.equal(selected.length, 0, '不许有任何一项默认选中');

  buttonIn(card, '做对').click();
  await flush();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '没选证据不该发请求');
  assert.match(textOf(toastHost), /证据/, '要提示先选证据');
});

test('#63 选了证据就把 evidence_type 一起提交', async () => {
  const last = item({ review_round: 3 });
  const posted = [];
  const { root } = await mountWith({
    mistakes: [last],
    reviews: { date: TODAY, total: 1, items: [{ ...last, overdue_days: 1 }] },
    onPost: ({ body }) => { posted.push(body); return { mistake_id: 7, status: 'mastered' }; },
  });

  const card = cardOf(7);
  const select = card.querySelector('select');
  const option = select.descendants().find((n) => n.localName === 'option' && n.value === 'retell');
  assert.ok(option, '下拉里要有服务端下发的证据类型');
  select.value = 'retell';
  select.dispatch('change');

  buttonIn(card, '做对').click();
  await flush();

  assert.equal(posted.length, 1, '应提交一次');
  assert.equal(posted[0].evidence_type, 'retell', '证据类型要带上');
});

// ── 三、幂等：带上这次复习的到期日，且在途不许连点 ─────────────────────────

test('#63 提交复习结果带上 due_on，在途时按钮置灰、连点不会记成两轮', async () => {
  const due = item();
  const gate = deferred();
  const posts = [];
  const { root } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 0 }] },
    onPost: async ({ body }) => {
      posts.push(body);
      await gate.promise;
      return { mistake_id: 7, status: 'reviewing', review_round: 1 };
    },
  });

  const card = cardOf(7);
  const correct = buttonIn(card, '做对');
  const wrong = buttonIn(card, '做错');
  correct.click();
  await flush(1);

  assert.equal(correct.disabled, true, '在飞时「做对」要置灰');
  assert.equal(wrong.disabled, true, '在飞时「做错」也要置灰');
  correct.click();
  wrong.click();
  await flush(1);
  assert.equal(posts.length, 1, '连点不该发出第二次');
  assert.equal(posts[0].due_on, TODAY, 'due_on 必须是这道题这次的到期日');

  gate.resolve({ mistake_id: 7, status: 'reviewing' });
  await flush();
});

// ── 四、写完要读回，按服务端结果归列 ───────────────────────────────────────

test('#63 做错之后重新读取，卡片回到「诊断中」而不是留在复习列', async () => {
  const due = item();
  const { root, calls } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 2 }] },
    onPost: ({ setItems }) => {
      // 服务端真的把它挪到了诊断中，下次读取就该看到。
      setItems([{ ...due, status: 'diagnosing', next_review: null }]);
      return { mistake_id: 7, status: 'diagnosing', review_round: 1 };
    },
  });

  const readsBefore = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/mistakes')).length;
  buttonIn(cardOf(7), '做错').click();
  await flush(6);

  const readsAfter = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/mistakes')).length;
  assert.ok(readsAfter > readsBefore, '写成功后必须重新读取，不能自己猜结果');
  const reviewing = dom.document.querySelector('.board__col[data-status="reviewing"]');
  assert.equal(reviewing.querySelector('[data-mistake-id="7"]'), null, '这题不该还留在复习列');
  const diagnosing = dom.document.querySelector('.board__col[data-status="diagnosing"]');
  assert.ok(diagnosing, '要有诊断中这一列');
  assert.ok(diagnosing.querySelector('[data-mistake-id="7"]'), '按服务端结果应归到诊断中');
});

test('#63 写入成功但读回失败：说清「已记上」，不许假装卡片已挪走', async () => {
  const due = item();
  let readCount = 0;
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/api/meta') return { stats: { total: 1, byStatus: {} }, evidenceKinds: ['retell'] };
    if (path === '/api/reviews/today') return { date: TODAY, total: 1, items: [{ ...due, overdue_days: 1 }] };
    if (path.startsWith('/api/reviews/') && method === 'POST') return { mistake_id: 7, status: 'diagnosing' };
    if (path.startsWith('/api/mistakes')) {
      readCount += 1;
      if (readCount > 1) throw new ApiError('读不到题库了', { code: 'NETWORK' });
      return { total: 1, items: [due] };
    }
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  const root = resetScreen();
  await mountBoard({ root, api });

  buttonIn(cardOf(7), '做错').click();
  await flush(6);

  const text = textOf(toastHost);
  assert.match(text, /已记|记上/, `写入是成功的，要说清已记上，实际：${text}`);
  assert.match(text, /读|刷新/, '读回失败要单独说，别让人以为没记上又去点一次');
  assert.ok(cardOf(7), '读不回来就别动卡片——不能凭猜把它挪走');
});

test('#63 写入失败：按钮恢复可点，卡片不动，计数不变', async () => {
  const due = item();
  const { root } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 1 }] },
    onPost: () => { throw new ApiError('连不上服务', { code: 'NETWORK' }); },
  });

  const card = cardOf(7);
  const correct = buttonIn(card, '做对');
  correct.click();
  await flush(6);

  assert.equal(correct.disabled, false, '失败后按钮要恢复可点');
  assert.ok(cardOf(7), '失败时卡片不能动');
  const col = dom.document.querySelector('.board__col[data-status="reviewing"] .board__count');
  assert.equal(textOf(col), '1', '失败时计数不能变');
});

test('#63 重复提交被 409 拒：提示说「已经记过」，不当成失败', async () => {
  const due = item();
  const { root } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 1 }] },
    onPost: () => { throw new ApiError('这次复习已经记过了，别重复点。', { status: 409, code: 'INVALID_STATE' }); },
  });

  buttonIn(cardOf(7), '做对').click();
  await flush(6);

  assert.match(textOf(toastHost), /已经记过/, '要说清是重复提交');
  assert.doesNotMatch(textOf(toastHost), /没能记|失败/, '重复提交不该被当成普通失败');
});

test('#63 写入成功的提示要带上题目与结果', async () => {
  const due = item();
  const { root } = await mountWith({
    mistakes: [due],
    reviews: { date: TODAY, total: 1, items: [{ ...due, overdue_days: 1 }] },
    onPost: () => ({ mistake_id: 7, status: 'reviewing', review_round: 2 }),
  });

  buttonIn(cardOf(7), '做对').click();
  await flush(6);

  const text = textOf(toastHost);
  assert.match(text, /7/, '提示里要有题号');
  assert.match(text, /做对/, '提示里要说清记的是哪个结果');
});
