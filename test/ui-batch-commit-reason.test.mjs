// #59 测试先行：批量确认失败要逐条说清，前端不能把机器码丢给老师。
//
// 红灯预期：前端现在只统计失败条数、丢掉 reason，
// 页面既没有逐条原因，也没有「只给可重试项」的重试按钮。
//
// 三件事要锁住：
//   1. 每条失败的中文原因都在页面上，而且能指出是哪一条题。
//   2. 机器码（SUBJECT_REQUIRED 之类）一个字都不许出现在页面上。
//   3. 重试按钮只针对可重试的失败；点了也只能把可重试的那些再发一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

function draft(id, seq) {
  return {
    id,
    seq,
    job_id: 1,
    bbox: [0.05, 0.1, 0.9, 0.3],
    subject: 'math',
    prompt: `${seq}+1=?`,
    options: [],
    student_answer_draft: null,
    correct_answer_draft: null,
    question_type: '计算题',
    knowledge_hint: '加法',
    has_figure: 0,
    figure_desc: null,
    confidence: { prompt: 0.9 },
    uncertain: [],
    status: 'pending',
    mistake_id: null,
    created_at: '2026-11-05T00:00:00.000Z',
    reviewed_at: null,
  };
}

// 后端给的失败结果长这样：reason 是机器码，message 是中文，retryable 说能不能再点一次。
function batchResponse() {
  return {
    committed: 1,
    results: [
      { id: 11, ok: true, mistakeId: 7, idempotent: false },
      {
        id: 12,
        ok: false,
        reason: 'SUBJECT_REQUIRED',
        message: '还没选科目：选好科目后再确认入库。',
        retryable: true,
      },
      {
        id: 13,
        ok: false,
        reason: 'INVALID_STATE',
        message: '这条草稿已经被处理过，不能重复入库。要入库请回照片上重新框选。',
        retryable: false,
      },
    ],
  };
}

async function setupInbox(batchResult) {
  const dom = installDom();
  for (const id of [
    'inbox-file', 'inbox-image', 'inbox-bboxes', 'inbox-drafts',
    'inbox-job-picker', 'inbox-manual', 'inbox-queue', 'toast-host',
  ]) {
    dom.body.append(dom.byId(id));
  }
  const { mount: mountInbox } = await import('../public/js/pages/inbox.js');

  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, body: opts.body });
    if (path === '/api/recognitions') {
      return {
        items: [{
          id: 1,
          image_path: 'images/a.png',
          status: 'done',
          drafts: [draft(11, 1), draft(12, 2), draft(13, 3)],
        }],
      };
    }
    if (path === '/api/ai/status') return { pendingDrafts: 0 };
    if (path === '/api/recognition-drafts/batch-commit') return batchResult ?? batchResponse();
    throw new Error(`不该调这个接口：${path}`);
  };

  const root = dom.byId('view');
  await mountInbox({ root, api, state: { aiEnabled: false } });
  return { dom, root, calls };
}

function buttonByText(node, needle) {
  return node.descendants().find(
    (n) => n.localName === 'button' && typeof n.textContent === 'string' && n.textContent.includes(needle),
  );
}

async function clickAndSettle(node) {
  const results = node.click();
  await Promise.all(results.map((r) => (r && typeof r.catch === 'function' ? r.catch(() => {}) : r)));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('#59 批量确认失败要逐条列出中文原因，并指出是哪一条', async () => {
  const { dom, root } = await setupInbox();
  const confirmAll = buttonByText(dom.byId('inbox-drafts'), '全部确认');
  assert.ok(confirmAll, '收件箱应有「全部确认」按钮');

  await clickAndSettle(confirmAll);

  const text = textOf(root);
  assert.match(text, /还没选科目/, `页面上看不到第一条的失败原因：${text}`);
  assert.match(text, /已经被处理过/, `页面上看不到第二条的失败原因：${text}`);
  assert.match(text, /第 2 题/, `失败原因没指出是哪一条题：${text}`);
  assert.match(text, /第 3 题/, `失败原因没指出是哪一条题：${text}`);
});

test('#59 机器码一个字都不许出现在页面上', async () => {
  const { dom, root } = await setupInbox();
  await clickAndSettle(buttonByText(dom.byId('inbox-drafts'), '全部确认'));

  const text = textOf(root);
  assert.doesNotMatch(text, /SUBJECT_REQUIRED/, '把机器码原样显示给老师了');
  assert.doesNotMatch(text, /INVALID_STATE/, '把机器码原样显示给老师了');
});

test('#59 重试只针对可重试的失败，不能把不可重试的也再发一遍', async () => {
  const { dom, root, calls } = await setupInbox();
  await clickAndSettle(buttonByText(dom.byId('inbox-drafts'), '全部确认'));

  const retryButtons = root.descendants().filter(
    (n) => n.localName === 'button' && typeof n.textContent === 'string' && n.textContent.includes('重试'),
  );
  assert.equal(retryButtons.length, 1, `可重试的失败只有一条，重试按钮就该只有一个，实际 ${retryButtons.length} 个`);

  await clickAndSettle(retryButtons[0]);

  const retried = calls.filter((c) => c.path === '/api/recognition-drafts/batch-commit');
  assert.equal(retried.length, 2, '应有两次批量确认调用（首次 + 重试）');
  assert.deepEqual(retried[1].body.ids, [12], '重试只该重发可重试的那条，不该带上已处理的第 3 题');
});

test('#59 后端没给中文原因时，也不能把机器码显示出来', async () => {
  const { dom, root } = await setupInbox({
    committed: 0,
    results: [{ id: 12, ok: false, reason: 'PROMPT_REQUIRED' }],
  });
  await clickAndSettle(buttonByText(dom.byId('inbox-drafts'), '全部确认'));

  const text = textOf(root);
  assert.doesNotMatch(text, /PROMPT_REQUIRED/, '后端漏给中文原因时，机器码就漏到页面上来了');
  assert.match(text, /[一-龥]/, '兜底也必须是中文');
});
