// #16 测试先行：AI 未启用的等价退路、状态接口与六类失败降级。
// 红灯预期：/api/ai/status 404，且未启用上传后没有可手填的空白草稿。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createJobWorker } from '../src/ai/jobs.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const NOW = '2026-11-04T02:00:00.000Z';
const VALID = JSON.stringify({ questions: [{ seq: 1, subject_hint: 'math', prompt: '1+1=?', confidence: { prompt: 0.9 } }] });

let dataDir, db, server, base, worker, originalFetch, externalCalls;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, data, text };
}

before(async () => {
  originalFetch = globalThis.fetch;
  externalCalls = 0;
  globalThis.fetch = (url, options) => {
    const target = typeof url === 'string' ? url : String(url?.url ?? url);
    if (!target.startsWith('http://127.0.0.1')) externalCalls += 1;
    return originalFetch(url, options);
  };
  dataDir = mkdtempSync(join(tmpdir(), 'ml-disabled-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(NOW);
  worker = createJobWorker({
    db,
    provider: { isEnabled: false, providerName: 'disabled', model: null, recognize: async () => VALID },
    dataDir,
    options: { pollIntervalMs: 100000, readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }) },
  });
  const app = createApp({ db, dataDir, recognitionWorker: worker });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await worker.stop();
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe('AI 未启用：拍照 → 手填 → 入库链路完全等价', () => {
  it('清空环境变量时外部调用次数为 0，上传仍产生可手填空白草稿', async () => {
    const res = await call('/api/recognitions', { method: 'POST', body: { image: PNG } });
    assert.equal(res.status, 202, res.text);
    const detail = await call(`/api/recognitions/${res.data.jobId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.job.status, 'queued');
    assert.equal(detail.data.drafts.length, 1, '未启用时没有空白草稿可手填');
    assert.equal(detail.data.drafts[0].prompt, '');
    assert.equal(detail.data.drafts[0].status, 'pending');
    assert.equal(externalCalls, 0, 'AI 关闭时仍发起外部请求');
    assert.ok(existsSync(join(dataDir, detail.data.job.image_path)), '原图丢失');
  });

  it('老师手填空白草稿后确认，照常生成 status=new 的错题', async () => {
    const list = await call('/api/recognitions');
    const draftId = list.data.items[0].drafts[0].id;
    const patch = await call(`/api/recognition-drafts/${draftId}`, {
      method: 'PATCH', body: { prompt: '手填的题目：13×5=?', subject: 'math' },
    });
    assert.equal(patch.status, 200);
    const commit = await call(`/api/recognition-drafts/${draftId}/commit`, { method: 'POST' });
    assert.equal(commit.status, 201, commit.text);
    const row = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(commit.data.mistakeId);
    assert.equal(row.status, 'new');
    assert.equal(row.prompt, '手填的题目：13×5=?');
    assert.equal(row.student_conclusion, null);
    assert.equal(row.correct_answer, null);
    assert.equal(externalCalls, 0);
  });

  it('GET /api/ai/status 只回状态、用量、上限、最近失败与待确认数', async () => {
    const res = await call('/api/ai/status');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.enabled, false);
    assert.equal(typeof res.data.todayUsed, 'number');
    assert.equal(res.data.todayUsed, 0);
    assert.ok(res.data.dailyLimit > 0);
    assert.ok(Object.hasOwn(res.data, 'lastError'));
    assert.ok(Object.hasOwn(res.data, 'pendingDrafts'));
    for (const secret of ['apiKey', 'baseUrl', 'AI_API_KEY', 'sk-', 'Bearer']) {
      assert.ok(!res.text.includes(secret), `状态接口泄漏了 ${secret}`);
    }
  });
});

// 六类失败：每种都必须保留原图、退回可手填的空白草稿。
describe('失败降级矩阵：原图不丢、草稿可手填', () => {
  const cases = [
    ['未配置', { isEnabled: false }, {}],
    ['超时', { recognize: async () => { throw Object.assign(new Error('超时'), { code: 'TIMEOUT' }); } }, {}],
    ['429', { recognize: async () => { throw Object.assign(new Error('限流'), { code: 'RATE_LIMITED' }); } }, {}],
    ['脏 JSON', { recognize: async () => '这不是 JSON' }, {}],
    ['空题集', { recognize: async () => JSON.stringify({ questions: [] }) }, {}],
    ['配额用尽', { recognize: async () => VALID }, { dailyLimit: 0 }],
  ];

  for (const [name, providerOverride, optionOverride] of cases) {
    it(`${name}：job 不产生错题，原图仍在，生成空白草稿`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ml-fail-'));
      mkdirSync(join(dir, 'images'), { recursive: true });
      writeFileSync(join(dir, 'images', 'photo.jpg'), 'fake-original');
      const localDb = openDb(join(dir, 'mistakes.db'));
      migrate(localDb);
      const localWorker = createJobWorker({
        db: localDb,
        provider: {
          isEnabled: true,
          providerName: 'fake-local',
          model: 'fake',
          recognize: async () => VALID,
          ...providerOverride,
        },
        dataDir: dir,
        options: {
          pollIntervalMs: 100000, backoffBaseMs: 0, dailyLimit: 30,
          now: () => NOW, nowMs: () => Date.parse(NOW),
          sleep: async () => {},
          readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }),
          ...optionOverride,
        },
      });
      try {
        const info = localDb.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/photo.jpg', 'queued', ?)").run(NOW);
        const id = Number(info.lastInsertRowid);
        await localWorker.drain();
        assert.equal(localDb.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 0, `${name} 生成了错题`);
        assert.ok(existsSync(join(dir, 'images', 'photo.jpg')), `${name} 丢了原图`);
        const drafts = localDb.prepare('SELECT * FROM recognition_drafts WHERE job_id = ?').all(id);
        assert.ok(drafts.length >= 1, `${name} 没有退回手工的空白草稿`);
        assert.equal(drafts[0].status, 'pending');
      } finally {
        await localWorker.stop();
        closeDb(localDb);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
