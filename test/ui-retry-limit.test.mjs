// #49 前端红灯测试：人工重试达到上限后，按钮要置灰并写明已重试几次。
// 红灯预期：现在失败任务一律显示可点的「重试识别」按钮，
// 不看任务已经重试过几次——老师能一直点，一直消耗 provider 调用额度。
// 依据：docs/requirements/AI-vision-spec.md 第 86 行「人工重试，最多 2 次」。
//
// 后端的上限判定在 test/retry-limit.test.mjs；本文件盯界面这一层：
// 后端会返回 409，前端不能只是弹一句错误就完了——按钮该先就置灰。
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
    manual_retries: 0,
    manual_retry_limit: 2,
    error_code: 'UPSTREAM_TIMEOUT',
    token_estimate: null,
    created_at: '2026-11-05T00:00:00Z',
    finished_at: '2026-11-05T00:01:00Z',
    drafts: [],
    ...overrides,
  };
}

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

function findButton(node, label) {
  return node.descendants()
    .filter((n) => n.localName === 'button')
    .find((b) => String(b.textContent || '').includes(label));
}

test('#49 已重试用满上限时，重试按钮置灰并写明重试次数', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob({ manual_retries: 2, manual_retry_limit: 2 }));
  await mount({ root, api, state: { aiEnabled: true } });

  const retry = findButton(root, '重试');
  assert.ok(retry, '失败任务的提示区仍应有重试按钮（置灰而不是消失）');
  assert.equal(retry.disabled, true, '用满上限后重试按钮必须置灰，不能再点');
  assert.match(textOf(root), /已重试\s*2\s*次/, '要写明已经重试了几次');
});

test('#49 达到上限时给出替代路径：手工录入仍然可用', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob({ manual_retries: 2, manual_retry_limit: 2 }));
  await mount({ root, api, state: { aiEnabled: true } });

  const text = textOf(root);
  assert.match(text, /手工录入/, '不能把老师逼到没有路走：手工录入的路必须留着');
});

test('#49 还没用满上限时，按钮可点，文案不说「已重试 2 次」', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(failedJob({ manual_retries: 1, manual_retry_limit: 2 }));
  await mount({ root, api, state: { aiEnabled: true } });

  const retry = findButton(root, '重试');
  assert.ok(retry, '应仍有重试按钮');
  assert.equal(retry.disabled, false, '还有一次机会时按钮不该置灰');
  assert.match(textOf(root), /已重试\s*1\s*次/, '要告诉老师已经用掉一次');
});

test('#49 旧数据没有 manual_retries 字段时，按钮仍可点（不误伤）', async () => {
  const root = dom.byId('view');
  const job = failedJob();
  delete job.manual_retries;
  delete job.manual_retry_limit;
  const { api } = fakeApi(job);
  await mount({ root, api, state: { aiEnabled: true } });

  const retry = findButton(root, '重试');
  assert.ok(retry, '应仍有重试按钮');
  assert.equal(retry.disabled, false, '后端没回这个字段时不能把按钮误置灰');
});
