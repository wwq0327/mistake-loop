// #14 / #15 测试先行：识别收件箱接口与逐题确认闸门。
// #14 红灯预期：路由尚未挂载，POST /api/recognitions 返回 404。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createJobWorker } from '../src/ai/jobs.mjs';
import { listenLoopback } from './helpers/server.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const RECOGNIZED = JSON.stringify({
  questions: [
    { seq: 1, bbox: [0.05, 0.1, 0.9, 0.3], subject_hint: 'math', prompt: '1+1=?', confidence: { prompt: 0.92 } },
    { seq: 2, bbox: [0.05, 0.4, 0.9, 0.6], subject_hint: 'math', prompt: '2+2=?', confidence: { prompt: 0.91 } },
    { seq: 3, bbox: [0.05, 0.7, 0.9, 0.9], subject_hint: 'math', prompt: '3+3=?', confidence: { prompt: 0.9 } },
  ],
  page_note: '共 3 题',
});

let dataDir, db, server, base, worker;
let jobId;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON 按空对象 */ }
  return { status: response.status, data, text };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-rec-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  worker = createJobWorker({
    db,
    provider: {
      isEnabled: true,
      providerName: 'fake-local',
      model: 'fake-model',
      recognize: async () => RECOGNIZED,
    },
    dataDir,
    options: { pollIntervalMs: 100000, backoffBaseMs: 0, readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }) },
  });
  const app = createApp({ db, dataDir, recognitionWorker: worker });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await worker.stop();
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('识别收件箱：上传 → 草稿 → 核对', () => {
  it('POST 返回 202 + jobId，原图落盘，响应不回密钥/图片 base64', async () => {
    const res = await call('/api/recognitions', { method: 'POST', body: { image: PNG, derived: PNG } });
    assert.equal(res.status, 202, `实际 ${res.status}: ${res.text}`);
    assert.ok(res.data.jobId > 0);
    assert.equal(res.data.status, 'queued');
    jobId = res.data.jobId;
    const row = db.prepare('SELECT * FROM recognition_jobs WHERE id = ?').get(jobId);
    assert.ok(row, 'job 未落库');
    assert.ok(existsSync(join(dataDir, row.image_path)), '原图未落盘');
    assert.ok(!res.text.includes('iVBORw0KGgo'), '响应回传了图片 base64');
    assert.ok(!res.text.includes('sk-'), '响应回传了密钥');
  });

  it('worker 识别后详情返回三条 pending 草稿，且列表与详情一致', async () => {
    await worker.drain();
    const detail = await call(`/api/recognitions/${jobId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.job.status, 'done');
    assert.equal(detail.data.drafts.length, 3);
    assert.equal(detail.data.drafts[0].prompt, '1+1=?');
    assert.equal(detail.data.drafts[0].status, 'pending');
    assert.deepEqual(detail.data.drafts[0].bbox, [0.05, 0.1, 0.9, 0.3]);
    assert.equal(detail.data.drafts[0].raw_excerpt, undefined, '详情回传了上游原文');

    const list = await call('/api/recognitions');
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].id, jobId);
    assert.equal(list.data.items[0].drafts.length, 3);
    assert.deepEqual(list.data.items[0].drafts.map((d) => d.id), detail.data.drafts.map((d) => d.id));
  });

  it('PATCH 只改白名单字段，越权字段与超长文本被拒', async () => {
    const detail = await call(`/api/recognitions/${jobId}`);
    const draftId = detail.data.drafts[0].id;
    const ok = await call(`/api/recognition-drafts/${draftId}`, {
      method: 'PATCH',
      body: { prompt: '老师改过的题干', subject: 'chinese', status: 'committed', mistake_id: 999 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.draft.prompt, '老师改过的题干');
    assert.equal(ok.data.draft.subject, 'chinese');
    assert.equal(ok.data.draft.status, 'pending', '越权字段被写入');
    assert.equal(ok.data.draft.mistake_id, null);

    const tooLong = await call(`/api/recognition-drafts/${draftId}`, {
      method: 'PATCH', body: { prompt: '长'.repeat(3000) },
    });
    assert.equal(tooLong.status, 400);
    assert.equal(db.prepare('SELECT prompt FROM recognition_drafts WHERE id = ?').get(draftId).prompt, '老师改过的题干');
  });

  it('DELETE 软标记 discarded，不删记录，原图仍在', async () => {
    const detail = await call(`/api/recognitions/${jobId}`);
    const draftId = detail.data.drafts[1].id;
    const res = await call(`/api/recognition-drafts/${draftId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(draftId);
    assert.equal(row.status, 'discarded');
    assert.ok(row.reviewed_at);
    const afterDelete = await call(`/api/recognitions/${jobId}`);
    assert.equal(afterDelete.data.drafts.length, 3, '软删后草稿不该消失');
    assert.ok(existsSync(join(dataDir, db.prepare('SELECT image_path FROM recognition_jobs WHERE id = ?').get(jobId).image_path)));
  });

  it('retry 只接受 failed 任务，重置为 queued', async () => {
    db.prepare("UPDATE recognition_jobs SET status = 'failed', error_code = 'TIMEOUT' WHERE id = ?").run(jobId);
    const res = await call(`/api/recognitions/${jobId}/retry`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'queued');
    assert.equal(res.data.attempts, 0);
    const again = await call(`/api/recognitions/${jobId}/retry`, { method: 'POST' });
    assert.equal(again.status, 409, '非 failed 状态不该允许重试');
  });
});

// #15：逐题确认闸门。红灯预期 commit 接口尚不存在（404）。
describe('逐题确认闸门：草稿不自动入库，确认幂等', () => {
  let commitJobId;
  let draftIds;
  let emptyDraftId;

  before(() => {
    const now = new Date().toISOString();
    const info = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/commit-fixture.jpg', 'done', ?)").run(now);
    commitJobId = Number(info.lastInsertRowid);
    draftIds = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = db.prepare("INSERT INTO recognition_drafts (job_id, seq, subject, prompt, status, created_at) VALUES (?, ?, 'math', ?, 'pending', ?)")
        .run(commitJobId, i, `闸门题 ${i}`, now);
      draftIds.push(Number(r.lastInsertRowid));
    }
    const empty = db.prepare("INSERT INTO recognition_drafts (job_id, seq, subject, prompt, status, created_at) VALUES (?, 4, 'math', '', 'pending', ?)")
      .run(commitJobId, now);
    emptyDraftId = Number(empty.lastInsertRowid);
  });

  it('未确认草稿不出现在题库 / 今日复习 / 打印 / 统计', async () => {
    const mistakes = await call('/api/mistakes');
    const today = await call('/api/reviews/today');
    const print = await call('/api/print');
    const meta = await call('/api/meta');
    assert.equal(mistakes.data.total, 0);
    assert.equal(today.data.total, 0);
    assert.equal(print.data.total, 0);
    assert.equal(meta.data.stats.total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM recognition_drafts WHERE job_id = ? AND status = ?').get(commitJobId, 'pending').c, 4);
  });

  it('确认两条只新增两道错题，status=new，答案与学生结论均不来自 AI', async () => {
    const first = await call(`/api/recognition-drafts/${draftIds[0]}/commit`, { method: 'POST' });
    const second = await call(`/api/recognition-drafts/${draftIds[1]}/commit`, { method: 'POST' });
    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 201, second.text);
    assert.ok(first.data.mistakeId > 0);

    const rows = db.prepare('SELECT * FROM mistakes ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.status), ['new', 'new']);
    assert.equal(rows[0].review_round, 0);
    assert.equal(rows[0].correct_answer, null, 'AI 答案混入了 correct_answer');
    assert.equal(rows[0].student_conclusion, null, 'AI 替学生写了关键结论');
    assert.equal(rows[0].recognition_draft_id, draftIds[0]);
    assert.equal(rows[0].image_path, 'images/commit-fixture.jpg');
    assert.equal(rows[0].needs_textbook_ref, 1);
    assert.equal(db.prepare('SELECT status, mistake_id FROM recognition_drafts WHERE id = ?').get(draftIds[0]).status, 'committed');
    assert.ok(db.prepare('SELECT mistake_id FROM recognition_drafts WHERE id = ?').get(draftIds[0]).mistake_id > 0);
  });

  it('二次 commit 返回幂等结果，不重复入库', async () => {
    const again = await call(`/api/recognition-drafts/${draftIds[0]}/commit`, { method: 'POST' });
    assert.equal(again.status, 200);
    assert.equal(again.data.idempotent, true);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 2);
  });

  it('低置信度留空的题干不许确认入库', async () => {
    const res = await call(`/api/recognition-drafts/${emptyDraftId}/commit`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 2);
    assert.equal(db.prepare('SELECT status FROM recognition_drafts WHERE id = ?').get(emptyDraftId).status, 'pending');
  });

  it('批量确认逐条事务：可确认的入库，其余给原因且互不影响', async () => {
    db.prepare("UPDATE recognition_drafts SET status = 'discarded' WHERE id = ?").run(draftIds[2]);
    const res = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST',
      body: { ids: [draftIds[0], draftIds[2], emptyDraftId, ...draftIds.slice(0, 1)] },
    });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 2, '批量里重复/无效项不该新增错题');
    assert.ok(res.data.results.length === 4);
    assert.ok(res.data.results.some((r) => r.reason));
  });
});
