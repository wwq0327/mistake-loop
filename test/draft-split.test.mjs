// #33 测试先行：草稿拆分（AI 把一题切成两半时，老师要能把它掰回两题）。
// 红灯预期：POST /api/recognition-drafts/:id/split 路由尚不存在 → 断言 404 失败。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

let dataDir, db, server, base;
let jobId;

const PROMPT = '1. 3+5=?\n2. 2+8=?';
// 选中第二题 '2. 2+8=?'（下标 9..17）：拆出去的是选中段，留在原草稿的是其余部分。
const START = 9;
const END = 17;

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

// 每个用例自带一条草稿，互不干扰（拆一次就没了，不能复用同一条）。
// seq 一律取库里当前最大值 +1：拆分会把后面的草稿整体后移，写死的计数器会和它撞号。
function insertDraft({ prompt = PROMPT, bbox = [0.1, 0.2, 0.9, 0.6], status = 'pending' } = {}) {
  const max = db.prepare('SELECT MAX(seq) m FROM recognition_drafts WHERE job_id = ?').get(jobId).m ?? 0;
  const info = db.prepare(`INSERT INTO recognition_drafts
    (job_id, seq, bbox, subject, prompt, status, created_at, confidence, uncertain, question_type, knowledge_hint)
    VALUES (?, ?, ?, 'math', ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobId, max + 1, bbox ? JSON.stringify(bbox) : null, prompt, status, new Date().toISOString(),
      JSON.stringify({ prompt: 0.9 }), JSON.stringify([]), '选择题', '加法');
  return Number(info.lastInsertRowid);
}

function row(id) {
  return db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
}

function pendingRows() {
  return db.prepare("SELECT * FROM recognition_drafts WHERE job_id = ? AND status = 'pending' ORDER BY seq").all(jobId);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-split-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  const job = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/split.jpg', 'done', ?)")
    .run(new Date().toISOString());
  jobId = Number(job.lastInsertRowid);

  const app = createApp({ db, dataDir });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#33 拆分草稿：按切分位置把一条掰成两条', () => {
  it('拆分后得到两条草稿，题干按切分点分前后两段', async () => {
    const id = insertDraft();
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: START, end: END },
    });
    assert.equal(res.status, 200, `实际 ${res.status}: ${res.text}`);
    assert.equal(row(id).prompt, '1. 3+5=?\n', '第一条题干不是前半段');
    const second = res.data.second;
    assert.ok(second, '没有生成第二条草稿');
    assert.notEqual(second.id, id);
    assert.equal(second.prompt, '2. 2+8=?');
    assert.equal(row(second.id).prompt, '2. 2+8=?');
  });

  it('原草稿 id 不变（历史引用不断），非题干字段全部继承', async () => {
    const id = insertDraft();
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: START, end: END },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(row(id).id, id, '原草稿 id 变了');
    const second = res.data.second;
    assert.ok(second, '拆分出的第二条没找到');
    assert.equal(second.subject, 'math');
    assert.equal(second.question_type, '选择题');
    assert.equal(second.knowledge_hint, '加法');
    assert.equal(second.status, 'pending');
    assert.equal(second.job_id, jobId, '新草稿没挂在同一个照片下');
  });

  it('seq 顺移：新草稿紧跟其后，后续草稿不与它撞号', async () => {
    const id = insertDraft();
    const tail = insertDraft({ prompt: '后续题 A' });
    insertDraft({ prompt: '后续题 B' });
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: START, end: END },
    });
    assert.equal(res.status, 200, res.text);
    const rows = pendingRows();
    const seqs = rows.map((r) => r.seq);
    assert.deepEqual(seqs, [...new Set(seqs)], 'seq 出现重复，撞了 UNIQUE(job_id, seq)');
    const second = row(res.data.second.id);
    assert.equal(second.seq, row(id).seq + 1, '拆分出的草稿没有紧跟原草稿');
    assert.ok(row(tail).seq > second.seq, '后续草稿没有后移');
  });

  it('框不乱画：原草稿保留自己的框，拆出的那条不画框', async () => {
    const id = insertDraft();
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: START, end: END },
    });
    assert.equal(res.status, 200, res.text);
    const kept = JSON.parse(row(id).bbox);
    assert.deepEqual(kept, [0.1, 0.2, 0.9, 0.6], '原草稿的框不该变');
    assert.equal(row(res.data.second.id).bbox, null, '拆出的草稿不该硬画一个框');
  });

  it('拆分只产草稿，绝不产生错题', async () => {
    const id = insertDraft();
    const before = db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: START, end: END },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, before, '拆分写进了错题表');
  });
});

describe('#33 拆分边界：不合法的切分点一律拒绝，且不改数据', () => {
  it('选区不合法（空选区、越界、倒置、非数字、缺字段）全部拒绝', async () => {
    const bad = [
      { start: 0, end: 0 }, { start: 5, end: 5 }, { start: 9, end: 9 },
      { start: -1, end: 5 }, { start: 0, end: PROMPT.length + 5 },
      { start: 10, end: 5 }, { start: 'abc', end: 'def' }, { start: 3 }, { end: 3 }, {},
    ];
    for (const body of bad) {
      const id = insertDraft();
      const res = await call(`/api/recognition-drafts/${id}/split`, { method: 'POST', body });
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 实际 ${res.status}: ${res.text}`);
      assert.ok(res.data?.error?.code, `body=${JSON.stringify(body)} 没有明确错误码`);
      assert.equal(row(id).prompt, PROMPT, `body=${JSON.stringify(body)} 竟然改了题干`);
    }
  });

  it('整段题干都被选中时拒绝：拆出去就没有剩下的题了', async () => {
    const id = insertDraft();
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { start: 0, end: PROMPT.length },
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(row(id).prompt, PROMPT, '竟然把题干清空了');
  });

  it('题干为空的草稿不能拆', async () => {
    const id = insertDraft({ prompt: '' });
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { offset: 1 },
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(row(id).status, 'pending');
  });

  it('已入库的草稿不能再拆', async () => {
    const id = insertDraft({ status: 'committed' });
    const res = await call(`/api/recognition-drafts/${id}/split`, {
      method: 'POST', body: { offset: 1 },
    });
    assert.equal(res.status, 409, `实际 ${res.status}: ${res.text}`);
  });

  it('失败的拆分不留下半截数据：草稿条数与题干均不变', async () => {
    const id = insertDraft();
    const before = pendingRows().map((r) => `${r.id}:${r.prompt}`).join('|');
    await call(`/api/recognition-drafts/${id}/split`, { method: 'POST', body: { start: 0, end: 999 } });
    const after = pendingRows().map((r) => `${r.id}:${r.prompt}`).join('|');
    assert.equal(after, before, '失败的拆分改动了数据');
  });

  it('草稿不存在时返回 404，不静默新建', async () => {
    const res = await call('/api/recognition-drafts/999999/split', { method: 'POST', body: { start: 0, end: 1 } });
    assert.equal(res.status, 404, res.text);
  });
});
