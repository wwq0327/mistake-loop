// #48 测试先行：识别失败必须给「重试」入口。
// 红灯预期：收件箱页面在任务失败时只显示一句话，没有任何重试按钮，
// POST /api/recognitions/:id/retry 这个接口前端从来不调。
// 依据：docs/requirements/AI-vision-spec.md 第 86 行——
//   「状态机（job）：queued → running → done | partial | failed；
//     failed → queued（人工重试，最多 2 次）」
// 以及第 122 行失败降级矩阵——「识别超时，可重试或手工录入」。
//
// 本文件用 test/helpers/dom.mjs 的最小 DOM 垫片**真跑**收件箱页面的 mount()，
// 点真的按钮、看真的接口调用，而不是读源码猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

const dom = installDom();
const { mount } = await import('../public/js/pages/inbox.js');

function failedJob(overrides = {}) {
  return {
    id: 7,
    image_path: 'images/aaaa.png',
    status: 'failed',
    provider: 'openai-compatible',
    model: 'demo',
    attempts: 2,
    error_code: 'UPSTREAM_TIMEOUT',
    token_estimate: null,
    created_at: '2026-11-05T00:00:00Z',
    finished_at: '2026-11-05T00:01:00Z',
    drafts: [],
    ...overrides,
  };
}

// 假接口：记录调用，任务状态可切换，模拟「点了重试之后重新排队」。
function fakeApi(initialJob) {
  const calls = [];
  let job = initialJob;
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (path === '/api/recognitions' && method === 'GET') return { total: 1, items: [job] };
    if (path === `/api/recognitions/${job.id}/retry` && method === 'POST') {
      job = { ...job, status: 'queued', error_code: null, attempts: 0 };
      return { id: job.id, status: 'queued', attempts: 0 };
    }
    if (path === `/api/recognitions/${job.id}` && method === 'GET') return { ...job, drafts: job.drafts || [] };
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  return { api, calls, currentJob: () => job };
}

function buttonsIn(node) {
  return node.descendants().filter((n) => n.localName === 'button');
}

function findButton(node, label) {
  return buttonsIn(node).find((b) => String(b.textContent || '').includes(label));
}

test('#48 任务失败时给出「重试识别」按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob());
  await mount({ root, api, state: { aiEnabled: true } });

  const retry = findButton(root, '重试');
  assert.ok(retry, '失败任务的提示区应有「重试」按钮');
  assert.match(textOf(root), /重试|再试/, '提示文案要说得出「重试」');
});

test('#48 点重试真的调 POST /api/recognitions/:id/retry，并把任务排回队列', async () => {
  const root = dom.byId('view');
  const fake = fakeApi(failedJob());
  await mount({ root, api: fake.api, state: { aiEnabled: true } });

  const retry = findButton(root, '重试');
  assert.ok(retry, '应有重试按钮');
  await Promise.all(retry.click());

  const retryCall = fake.calls.find((c) => c.path.endsWith('/retry'));
  assert.ok(retryCall, '点了重试必须调重试接口');
  assert.equal(retryCall.method, 'POST', '重试必须是 POST');
  assert.equal(retryCall.path, '/api/recognitions/7/retry');
  assert.equal(fake.currentJob().status, 'queued', '重试后任务应回到 queued');
});

test('#48 不是失败状态的任务不给重试按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob({ status: 'done', error_code: null }));
  await mount({ root, api, state: { aiEnabled: true } });
  assert.equal(findButton(root, '重试'), undefined, '已成功的任务不该有重试按钮');
});

test('#48 失败提示里仍要保留「改为手工录入」这条路', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob());
  await mount({ root, api, state: { aiEnabled: true } });
  // 重试与手工是两条并行的路，不是替代关系。
  assert.match(textOf(root), /手工/, '失败提示仍应提到手工录入');
});

test('#48 重试接口报错时要把原因说出来，不能静默', async () => {
  const root = dom.byId('view');
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (path === '/api/recognitions') return { total: 1, items: [failedJob()] };
    throw new Error('今天识别次数已用完');
  };
  await mount({ root, api, state: { aiEnabled: true } });
  const retry = findButton(root, '重试');
  assert.ok(retry, '应有重试按钮');
  await Promise.all(retry.click());
  assert.match(textOf(root), /用完|失败|没能/, '重试失败要说明原因');
});
