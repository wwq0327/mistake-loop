// #58 测试先行：前端的异步动作失败时必须说话，不能静默。
//
// 三条实测到的静默失败：
//   1. 题库页改筛选条件 → addEventListener('change', render)，render 是 async，
//      抛错时没人接 → 列表停在旧数据、零提示。
//   2. 工作台 api('/api/ai/status').catch(() => ({ pendingDrafts: 0 }))
//      —— 把「不知道」兜成了「0」，KPI 上真的显示「待确认草稿 0」，这是谎报。
//   3. 收件箱切换照片 → onClick 是 async，await refresh() 抛错 → 点了没反应。
//
// 另加一条：请求挂起（服务不回应）时不能永远转圈——api() 要有超时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';
import { api, describeError, ApiError } from '../public/js/api.js';

// ── api 层：超时与错误分类 ──────────────────────────────────────────────

test('#58 请求挂起时要有超时，不能永远转圈', async () => {
  const original = globalThis.fetch;
  // 假 fetch 要像真 fetch 一样理会 abort signal：
  // 真实的 fetch 收到 abort 会 reject AbortError，假的不理会就会永远挂着，
  // 测出来的是「promise 悬着」而不是「超时」。
  globalThis.fetch = (url, options = {}) => new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort);
  });
  try {
    await assert.rejects(
      // 测试侧也加一道兜底：万一超时机制没了，api 会永远挂着，
      // 那样报出来的是「测试超时」而不是「哪条断言红了」——
      // 守护测试不能因为被守护的代码坏了就把 CI 挂住。
      () => Promise.race([
        api('/api/meta', { timeoutMs: 20 }),
        new Promise((_resolve, reject) => setTimeout(
          () => reject(new Error('api 没有在预期时间内拒绝：超时机制可能没了')), 2000,
        )),
      ]),
      (error) => {
        assert.equal(error.code, 'TIMEOUT', `错误码不对：${error.code}`);
        assert.match(error.message, /太久|没有回应/, '提示要说清是超时，不是连不上');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('#58 409 / 400 / 404 要有各自不同的说法', () => {
  // 几条错误的后端原文**故意写成完全一样**，只有 status 不同。
  // 这样测的才是「按状态分类」这件事本身；
  // 若原文各不相同，哪怕分类根本没做，输出也天然不同——那是假覆盖。
  const same = '出错了';
  const conflict = describeError(new ApiError(same, { status: 409, code: 'INVALID_STATE' }));
  const bad = describeError(new ApiError(same, { status: 400, code: 'INVALID_ENUM' }));
  const missing = describeError(new ApiError(same, { status: 404, code: 'NOT_FOUND' }));
  const timeout = describeError(new ApiError(same, { code: 'TIMEOUT' }));
  const network = describeError(new ApiError(same, { code: 'NETWORK' }));

  const all = [conflict, bad, missing, timeout, network];
  assert.equal(new Set(all).size, all.length, `五种错误说了同样的话：${all.join(' / ')}`);
  assert.match(conflict, /不能这么做/, '409 要说清是状态不允许');
  assert.match(missing, /找不到/, '404 要说清是找不到');
  assert.match(bad, /没通过|不对/, '400 要说清是请求没通过');
  assert.match(timeout, /太久|没有回应/, '超时要说清是超时');
  assert.match(network, /连不上/, '连不上要说清是连不上');

  // 后端给的话要原样带出来，不能被分类文案盖掉。
  const detail = describeError(new ApiError('这次复习已经记过了，别重复点。', { status: 409, code: 'INVALID_STATE' }));
  assert.match(detail, /已经记过/, '409 要把后端给的话带出来');
});

test('#58 只给 status 不给 code 时，也不能被说成「连不上服务」', () => {
  // 上一条每条错误都**显式给了 code**，绕开了 ApiError 的默认 code。
  // 而默认 code 才是真正常见的路径：调用方只知道自己拿到了 409，
  // 并不知道后端内部把它叫什么 code。
  // 默认值曾经是 NETWORK，于是「服务端明确说了现在不行」会被说成
  // 「连不上服务，请确认本机程序仍在运行」——老师会以为程序挂了。
  // 谎报比报错更糟，这条单独锁住。
  const same = '出错了';
  const conflict = describeError(new ApiError(same, { status: 409 }));
  const bad = describeError(new ApiError(same, { status: 400 }));
  const missing = describeError(new ApiError(same, { status: 404 }));

  assert.match(conflict, /不能这么做/, `409 的说法不对：${conflict}`);
  assert.match(bad, /没通过|不对/, `400 的说法不对：${bad}`);
  assert.match(missing, /找不到/, `404 的说法不对：${missing}`);
  for (const text of [conflict, bad, missing]) {
    assert.doesNotMatch(text, /连不上/, `有 status 却说了「连不上」：${text}`);
  }
  assert.equal(new Set([conflict, bad, missing]).size, 3, '三种状态说了同样的话');
});

// ── 页面层 ─────────────────────────────────────────────────────────────

const dom = installDom();

// 题库页的骨架：library.js 按 id 取控件，缺一个就整页报错。
for (const id of [
  'library-filter-subject', 'library-filter-status', 'library-filter-node', 'library-filter-pending',
  'library-batch-node', 'library-batch-apply', 'library-select-all', 'library-batch-selected',
  'library-list-body', 'library-summary',
]) {
  const node = dom.byId(id);
  node.className = node.className || '';
  dom.body.append(node);
}
const libraryList = dom.byId('library-list');
const listHead = dom.document.createElement('div');
listHead.className = 'card__head';
listHead.append(dom.document.createElement('h2'));
libraryList.append(listHead);
dom.body.append(libraryList);
dom.body.append(dom.byId('view'));

const { mount: mountLibrary } = await import('../public/js/pages/library.js');

function libraryApi(state) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/meta') {
      return { stats: { total: 0, awaitingTextbookRef: 0 }, textbookNodes: [] };
    }
    if (path.startsWith('/api/mistakes?')) {
      if (state.fail) throw new ApiError('连不上服务，请确认本机程序仍在运行', { code: 'NETWORK' });
      return { total: 0, items: [] };
    }
    throw new Error(`不该调这个接口：${path}`);
  };
  return { api, calls };
}

test('#58 题库页筛选失败要有提示，不能静默停在旧数据', async () => {
  const root = dom.byId('view');
  const messages = [];
  const state = { fail: false };
  const { api } = libraryApi(state);
  // 先用能通的状态挂载，确认页面本身正常；
  // 再把状态切坏，模拟「老师改了筛选条件，但这下服务不响应了」。
  await mountLibrary({ root, api, toast: (message, kind) => messages.push({ message, kind }) });

  state.fail = true;
  // dispatch 返回监听器的返回值：把那个 promise 接住，
  // 这样「没有 guard」时的失败不会变成 unhandled rejection 把整个文件带崩，
  // 而是老老实实落在下面那条「必须出提示」的断言上。
  const results = dom.byId('library-filter-subject').dispatch('change');
  await Promise.all(results.map((r) => (r && typeof r.catch === 'function' ? r.catch(() => {}) : r)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(messages.length > 0, '筛选失败必须出提示，不能一声不吭');
  assert.match(messages[0].message, /连不上|没能|服务/, `提示要说人话：${messages[0].message}`);
  assert.equal(messages[0].kind, 'error', '失败提示应该是错误样式');
});

test('#58 工作台读不到 AI 状态时，KPI 要显示「未知」而不是 0', async () => {
  const workbenchDom = installDom();
  // 工作台的骨架：两个卡片区块各带 .card__head 与 .card__body，
  // 页面代码用 bodyOf(id) 找内容区，缺了会直接报 null.replaceChildren。
  for (const id of ['workbench-today', 'workbench-pending']) {
    const section = workbenchDom.byId(id);
    const head = workbenchDom.document.createElement('div');
    head.className = 'card__head';
    head.append(workbenchDom.document.createElement('h2'), workbenchDom.document.createElement('span'));
    const body = workbenchDom.document.createElement('div');
    body.className = 'card__body';
    section.append(head, body);
    workbenchDom.body.append(section);
  }
  workbenchDom.body.append(workbenchDom.byId('view'));
  const kpi = workbenchDom.byId('kpi-pendingDrafts');
  workbenchDom.body.append(kpi);

  const { mount: mountWorkbench } = await import('../public/js/pages/workbench.js');
  const api = async (path) => {
    if (path === '/api/meta') {
      return { stats: { total: 0, overdue: 0, awaitingTextbookRef: 0, byStatus: {} }, evidenceKinds: [], pendingVariants: [] };
    }
    if (path === '/api/reviews/today') return { date: '2026-11-05', total: 0, items: [] };
    if (path === '/api/ai/status') throw new ApiError('连不上服务', { code: 'NETWORK' });
    throw new Error(`不该调这个接口：${path}`);
  };

  await mountWorkbench({ root: workbenchDom.byId('view'), api, state: {} });
  assert.notEqual(String(kpi.textContent), '0', '读不到状态时不能谎报「待确认草稿 0」');
  assert.match(String(kpi.textContent), /未知|—|读不到|失败/, `KPI 应显示「未知」之类：${kpi.textContent}`);
});

test('#58 收件箱切换照片失败要有提示，不能点了没反应', async () => {
  const inboxDom = installDom();
  for (const id of [
    'inbox-file', 'inbox-image', 'inbox-bboxes', 'inbox-drafts',
    'inbox-job-picker', 'inbox-manual', 'inbox-queue', 'toast-host',
  ]) {
    inboxDom.body.append(inboxDom.byId(id));
  }
  const { mount: mountInbox } = await import('../public/js/pages/inbox.js');

  let failNext = false;
  const api = async (path) => {
    if (path === '/api/recognitions') {
      if (failNext) throw new ApiError('连不上服务', { code: 'NETWORK' });
      return { items: [{ id: 1, image_path: 'images/a.png', status: 'done', drafts: [] }] };
    }
    if (path === '/api/ai/status') return { pendingDrafts: 0 };
    throw new Error(`不该调这个接口：${path}`);
  };

  await mountInbox({ root: inboxDom.byId('view'), api, state: { aiEnabled: false } });

  const picker = inboxDom.byId('inbox-job-picker');
  const photoButton = picker.descendants().find((n) => n.localName === 'button');
  assert.ok(photoButton, '收件箱应渲染出照片切换按钮');

  failNext = true;
  const results = photoButton.click();
  await Promise.all(results.map((r) => (r && typeof r.catch === 'function' ? r.catch(() => {}) : r)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const toastText = textOf(inboxDom.byId('toast-host'));
  assert.match(toastText, /连不上|没能|服务/, `切换失败必须出提示：${toastText || '（什么都没有）'}`);
});
