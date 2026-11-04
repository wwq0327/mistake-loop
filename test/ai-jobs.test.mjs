// #13 测试先行：单并发 worker、配额、指数退避重试、优雅关闭。
// 红灯预期：src/ai/jobs.mjs 不存在，import 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createJobWorker, backoffDelay } from '../src/ai/jobs.mjs';

const NOW = '2026-11-04T02:00:00.000Z';
const VALID_RESULT = JSON.stringify({
  questions: [
    { seq: 1, bbox: [0.05, 0.1, 0.9, 0.3], subject_hint: 'math', prompt: '1+1=?', confidence: { prompt: 0.9 } },
    { seq: 2, bbox: [0.05, 0.4, 0.9, 0.6], subject_hint: 'math', prompt: '2+2=?', confidence: { prompt: 0.9 } },
    { seq: 3, bbox: [0.05, 0.7, 0.9, 0.9], subject_hint: 'math', prompt: '3+3=?', confidence: { prompt: 0.9 } },
  ],
  page_note: '共 3 题',
});

function setup(overrides = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const calls = [];
  const provider = {
    isEnabled: true,
    recognize: async () => VALID_RESULT,
    ...overrides.provider,
  };
  // 夹具统一记账：自定义 recognize 也要计入调用次数。
  const injectedRecognize = provider.recognize;
  provider.recognize = async (arg) => {
    calls.push(arg);
    return injectedRecognize(arg);
  };
  const worker = createJobWorker({
    db,
    provider,
    options: {
      dailyLimit: 30,
      maxAttempts: 2,
      pollIntervalMs: 100000,
      backoffBaseMs: 0,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }),
      sleep: async () => {},
      ...overrides.options,
    },
  });
  const addJob = (n = 1) => {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      const info = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, 'queued', ?)")
        .run(`images/photo-${i}.jpg`, NOW);
      ids.push(Number(info.lastInsertRowid));
    }
    return ids;
  };
  return {
    db, worker, calls, addJob,
    job: (id) => db.prepare('SELECT * FROM recognition_jobs WHERE id = ?').get(id),
    drafts: (id) => db.prepare('SELECT * FROM recognition_drafts WHERE job_id = ? ORDER BY seq').all(id),
    clean: async () => { await worker.stop(); closeDb(db); },
  };
}

test('启动扫 queued：成功后落三条草稿，job 转 done 并留完成时间', async () => {
  const s = setup();
  try {
    const [id] = s.addJob();
    await s.worker.drain();
    const job = s.job(id);
    assert.equal(job.status, 'done');
    assert.equal(job.attempts, 1);
    assert.ok(job.finished_at, '缺完成时间');
    assert.equal(s.drafts(id).length, 3);
    assert.equal(s.drafts(id)[0].prompt, '1+1=?');
    assert.equal(s.drafts(id)[0].status, 'pending');
    assert.equal(s.calls.length, 1);
  } finally { await s.clean(); }
});

test('单并发：三个 job 排队时同一时刻只有一次上游调用', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const s = setup({
    provider: {
      isEnabled: true,
      recognize: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return VALID_RESULT;
      },
    },
  });
  try {
    const ids = s.addJob(3);
    await Promise.all([s.worker.drain(), s.worker.drain(), s.worker.drain()]);
    assert.equal(maxInFlight, 1, '并发超过 1');
    assert.equal(ids.map((id) => s.job(id).status).join(','), 'done,done,done');
    assert.equal(s.calls.length, 3);
  } finally { await s.clean(); }
});

test('每日配额：达到 AI_DAILY_LIMIT 后新 job 直接 failed，且不重复调用', async () => {
  const s = setup({ options: { dailyLimit: 2 } });
  try {
    const ids = s.addJob(3);
    await s.worker.drain();
    assert.equal(s.calls.length, 2);
    assert.equal(s.job(ids[2]).status, 'failed');
    assert.equal(s.job(ids[2]).error_code, 'QUOTA_EXCEEDED');
    await s.worker.drain();
    assert.equal(s.calls.length, 2, '配额用尽后仍发起调用');
  } finally { await s.clean(); }
});

test('失败指数退避重试最多 2 次，之后 failed 且记错误码', async () => {
  const delays = [];
  const s = setup({
    provider: {
      isEnabled: true,
      recognize: async () => { throw Object.assign(new Error('超时'), { code: 'TIMEOUT' }); },
    },
    options: { backoffBaseMs: 10, sleep: async (ms) => delays.push(ms) },
  });
  try {
    const [id] = s.addJob();
    await s.worker.drain();
    assert.equal(s.calls.length, 2, '重试次数越界');
    assert.equal(s.job(id).attempts, 2);
    assert.equal(s.job(id).status, 'failed');
    assert.equal(s.job(id).error_code, 'TIMEOUT');
    assert.deepEqual(delays, [10, 20], '退避不是指数');
    assert.equal(backoffDelay(3, 10), 40);
  } finally { await s.clean(); }
});

test('优雅关闭：中止进行中的调用并把 job 恢复为 queued', async () => {
  let capturedSignal;
  const s = setup({
    provider: {
      isEnabled: true,
      recognize: async ({ signal }) => {
        capturedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('取消'), { name: 'AbortError' })));
        });
      },
    },
    options: { pollIntervalMs: 10 },
  });
  try {
    const [id] = s.addJob();
    s.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await s.worker.stop();
    assert.equal(capturedSignal.aborted, true, '未向 provider 传播中止信号');
    assert.equal(s.worker.state.running, false);
    assert.equal(s.job(id).status, 'queued', '关闭后 job 状态不可恢复');
    assert.equal(s.calls.length, 1);
  } finally { await s.clean(); }
});

test('AI 未启用时零调用，job 保持 queued 等手工处理', async () => {
  const s = setup({ provider: { isEnabled: false, recognize: async () => VALID_RESULT } });
  try {
    const [id] = s.addJob();
    await s.worker.drain();
    assert.equal(s.calls.length, 0);
    assert.equal(s.job(id).status, 'queued');
  } finally { await s.clean(); }
});
