// #56 前端测试：工作台的「做对 / 做错」必须带幂等凭证，且请求在飞时按钮置灰。
//
// 后端已经加了 due_on 判重（同一次复习只记一遍）。但判据得由前端给：
// 页面加载今日复习清单时，每道题的 next_review 就是「这次复习」的身份。
// 前端不带上它，后端就无从判重——连点两下照样记成两轮。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';
import { ApiError } from '../public/js/api.js';

const dom = installDom();
const { mount } = await import('../public/js/pages/workbench.js');

// 工作台的结构照 public/index.html 造出来：
// 两个卡片区块各带 .card__head 与 .card__body，页面代码用 bodyOf(id) 找内容区，
// 并会写 head.lastChild.textContent（所以 head 里必须真的有子节点）。
function buildBlocks() {
  for (const id of ['workbench-today', 'workbench-pending']) {
    const section = dom.byId(id);
    const head = dom.document.createElement('div');
    head.className = 'card__head';
    head.append(dom.document.createElement('h2'), dom.document.createElement('span'));
    const body = dom.document.createElement('div');
    body.className = 'card__body';
    section.append(head, body);
    dom.body.append(section);
  }
  dom.body.append(dom.byId('view'));
}
buildBlocks();

const TODAY_ITEM = {
  id: 7,
  subject: 'math',
  prompt: '一道题',
  status: 'reviewing',
  review_round: 1,
  next_review: '2026-11-01',
  overdue_days: 4,
};

function fakeApi({ postGate = null, postError = null } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (path === '/api/meta') {
      return {
        stats: { total: 1, overdue: 0, awaitingTextbookRef: 0, byStatus: { reviewing: 1 } },
        evidenceKinds: [],
        pendingVariants: [],
      };
    }
    if (path === '/api/reviews/today') {
      return { date: '2026-11-05', total: 1, items: [TODAY_ITEM] };
    }
    if (path === '/api/ai/status') return { pendingDrafts: 0 };
    if (method === 'POST') {
      if (postGate) return postGate.promise;
      if (postError) throw postError;
      return { mistake_id: 7, status: 'reviewing', review_round: 2 };
    }
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  return { api, calls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 让挂起的 promise 走完：一次 microtask 不够，mount 里有多层 await。
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonsIn(node) {
  return node.descendants().filter((n) => n.localName === 'button');
}

function findButton(label) {
  return buttonsIn(dom.body).find((b) => String(b.textContent || '').includes(label));
}

function toastText() {
  return textOf(dom.byId('toast-host'));
}

test('#56 工作台提交复习结果时带上这道题这次复习的到期日', async () => {
  const root = dom.byId('view');
  const { api, calls } = fakeApi();
  await mount({ root, api, state: {} });

  const btn = findButton('做对');
  assert.ok(btn, '今日复习里应有「做对」按钮');
  btn.click();
  await flush();

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '应发出复习结果提交请求');
  assert.equal(post.body.due_on, TODAY_ITEM.next_review,
    '提交必须带上这道题这次复习的到期日，否则后端无从判重');
  assert.equal(post.body.result, 'correct');
});

test('#56 请求在飞时「做对 / 做错」按钮置灰：手快连点不该记两遍', async () => {
  const root = dom.byId('view');
  const gate = deferred();
  const { api } = fakeApi({ postGate: gate });
  await mount({ root, api, state: {} });

  const correct = findButton('做对');
  const wrong = findButton('做错');
  correct.click();
  await flush(2);

  assert.equal(correct.disabled, true, '请求在飞时「做对」应置灰');
  assert.equal(wrong.disabled, true, '请求在飞时「做错」也应置灰');

  gate.resolve({ mistake_id: 7, status: 'reviewing', review_round: 2 });
  await flush();
});

test('#56 提交失败后按钮恢复可点：不能因为一次失败就卡死这一题', async () => {
  const root = dom.byId('view');
  const gate = deferred();
  const { api } = fakeApi({ postGate: gate });
  await mount({ root, api, state: {} });

  const correct = findButton('做对');
  correct.click();
  await flush(2);
  assert.equal(correct.disabled, true);

  gate.reject(new ApiError('连不上服务', { code: 'NETWORK' }));
  await flush();

  assert.equal(correct.disabled, false, '失败后按钮应恢复可点');
});

test('#56 重复提交被 409 拒时，提示要说「已经记过了」而不是「没能记录」', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi({
    postError: new ApiError('这次复习已经记过了，别重复点。', { status: 409, code: 'INVALID_STATE' }),
  });
  await mount({ root, api, state: {} });

  findButton('做对').click();
  await flush();

  assert.match(toastText(), /已经记过/, '提示要说清是重复提交');
  assert.doesNotMatch(toastText(), /没能记录/, '重复提交不该被当成普通失败');
});
