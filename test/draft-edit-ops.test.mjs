// #34 测试先行：识别框可拖动可删除、草稿可新增。
// 红灯预期：POST /api/recognition-drafts 路由尚不存在 → 断言 404 失败。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir, db, server, base;
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

function row(id) {
  return db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-editops-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  const now = new Date().toISOString();
  const job = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/edit.jpg', 'done', ?)")
    .run(now);
  jobId = Number(job.lastInsertRowid);

  const app = createApp({ db, dataDir });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#34 草稿可新增：老师手写一条空白草稿，走同一条入库流程', () => {
  it('新增返回一条空白待确认草稿：不带任何 AI 痕迹', async () => {
    const res = await call('/api/recognition-drafts', { method: 'POST', body: { jobId } });
    assert.equal(res.status, 201, `实际 ${res.status}: ${res.text}`);
    const draft = row(res.data.draft.id);
    assert.ok(draft, '草稿没落库');
    assert.equal(draft.status, 'pending');
    assert.equal(draft.prompt, '', '新增的草稿不该预填题干');
    assert.equal(draft.subject, null, '新增的草稿不该预填科目');
    assert.equal(draft.bbox, null, '新增的草稿不该带框');
    assert.equal(draft.confidence, null, '新增的草稿不该带置信度');
    assert.equal(draft.uncertain, null, '新增的草稿不该带 uncertain 标记');
    assert.equal(draft.job_id, jobId);
  });

  it('新增的草稿能正常填内容，并走 commit 入库（与 AI 草稿同一条流程）', async () => {
    const created = await call('/api/recognition-drafts', { method: 'POST', body: { jobId } });
    assert.equal(created.status, 201, created.text);
    const id = created.data.draft.id;

    const filled = await call(`/api/recognition-drafts/${id}`, {
      method: 'PATCH', body: { prompt: '老师手写的题', subject: 'chinese' },
    });
    assert.equal(filled.status, 200, filled.text);
    assert.equal(row(id).prompt, '老师手写的题');

    const committed = await call(`/api/recognition-drafts/${id}/commit`, { method: 'POST' });
    assert.equal(committed.status, 201, committed.text);
    const mistake = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(committed.data.mistakeId);
    assert.ok(mistake, '没有生成错题');
    assert.equal(mistake.status, 'new');
    assert.equal(mistake.prompt, '老师手写的题');
    assert.equal(mistake.subject, 'chinese');
    assert.equal(mistake.recognition_draft_id, id);
  });

  it('缺 jobId 或 jobId 不存在时拒绝，不静默挂到别的照片下', async () => {
    const noJob = await call('/api/recognition-drafts', { method: 'POST', body: {} });
    assert.equal(noJob.status, 400, `实际 ${noJob.status}: ${noJob.text}`);
    const badJob = await call('/api/recognition-drafts', { method: 'POST', body: { jobId: 999999 } });
    assert.equal(badJob.status, 404, `实际 ${badJob.status}: ${badJob.text}`);
  });
});

describe('#34 识别框可拖动：写回 bbox 且不写坏值', () => {
  it('合法 bbox 写回成功并回读一致', async () => {
    const created = await call('/api/recognition-drafts', { method: 'POST', body: { jobId } });
    const id = created.data.draft.id;
    const res = await call(`/api/recognition-drafts/${id}`, {
      method: 'PATCH', body: { bbox: [0.2, 0.3, 0.8, 0.7] },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.data.draft.bbox, [0.2, 0.3, 0.8, 0.7]);
    assert.deepEqual(JSON.parse(row(id).bbox), [0.2, 0.3, 0.8, 0.7]);
  });

  it('非法 bbox 一律拒绝，且原值不变（拖坏了不能存进去）', async () => {
    const created = await call('/api/recognition-drafts', { method: 'POST', body: { jobId } });
    const id = created.data.draft.id;
    await call(`/api/recognition-drafts/${id}`, { method: 'PATCH', body: { bbox: [0.1, 0.1, 0.5, 0.4] } });
    const bad = [
      [1.2, 0.1, 0.5, 0.4],   // 越界
      [-0.1, 0.1, 0.5, 0.4],  // 负数
      [0.5, 0.1, 0.2, 0.4],   // x2 <= x1
      [0.1, 0.4, 0.5, 0.2],   // y2 <= y1
      [0.1, 0.1, 0.5],        // 长度不对
      [0.1, 0.1, 0.5, 'a'],   // 非数字
    ];
    for (const bbox of bad) {
      const res = await call(`/api/recognition-drafts/${id}`, { method: 'PATCH', body: { bbox } });
      assert.equal(res.status, 400, `bbox=${JSON.stringify(bbox)} 实际 ${res.status}: ${res.text}`);
      assert.deepEqual(JSON.parse(row(id).bbox), [0.1, 0.1, 0.5, 0.4], `bbox=${JSON.stringify(bbox)} 竟然被写进去了`);
    }
  });
});
