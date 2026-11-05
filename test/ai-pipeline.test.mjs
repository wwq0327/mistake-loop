// #71 测试先行：后台 AI 多阶段任务编排。
//
// 要守的四条（见 Issue 验收标准）：
//   1. 识别后串接分析、备题与校验；未确认内容永远是草稿；改 OCR 后旧下游失效。
//   2. 幂等身份 = 题目 + 输入版本 + 阶段；重启能恢复待办；配额/失败/重试分阶段可见。
//   3. AI 关闭、额度不足或失败仍保留原图与手工路径，且绝不写学生结论/证据/学习结果。
//   4. schema 方案已确认（docs/plans/2026-11-05-p18-p19-schema-proposal.md）。
//
// 红灯预期：src/ai/tasks.mjs 与 /api/ai/tasks 路由尚不存在。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createTask, runTaskOnce, recoverStaleTasks, STAGE_KINDS } from '../src/ai/tasks.mjs';
import { listenLoopback } from './helpers/server.mjs';

const NOW = '2026-11-05T02:00:00.000Z';

let dataDir;
let db;
let server;
let base;
let provider;
let calls;

function fakeProvider(overrides = {}) {
  return {
    isEnabled: true,
    runStage: async ({ kind }) => {
      calls.push(kind);
      if (overrides.failOn === kind) {
        const err = new Error('上游超时');
        err.code = 'UPSTREAM_TIMEOUT';
        throw err;
      }
      return { stage: kind, draft: `${kind} 草稿`, source: 'fake' };
    },
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-aipipe-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(NOW);
  calls = [];
  provider = fakeProvider();
  const app = createApp({
    db,
    dataDir,
    schedulerState: { running: true },
    aiStatus: () => ({ enabled: true, configured: true }),
    aiControl: { configured: true, enabled: true },
    aiPipeline: { provider, quota: 30, now: () => NOW },
  });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

let seq = 0;
async function makeMistake(prompt = '3/4 与 5/6 哪个大？') {
  seq += 1;
  const out = await call('/api/mistakes', {
    method: 'POST',
    body: { subject: 'math', prompt: `${prompt}#${seq}`, student_answer: '3/4', correct_answer: '5/6' },
  });
  assert.equal(out.status, 201, out.status);
  return out.data.id;
}


// worker 是「取最老的 queued 来跑」，所以测试里统一排空队列，
// 不要假设下一条恰好是本用例刚建的那条。
async function drain(p = provider, limit = 20) {
  for (let i = 0; i < limit; i += 1) {
    const out = await runTaskOnce({ db, provider: p, now: () => NOW });
    if (!out.ran) return;
  }
}

const taskOf = (id) => db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(id);
const tasksOf = (mistakeId) => db.prepare('SELECT * FROM ai_tasks WHERE target_type = ? AND target_id = ? ORDER BY id').all('mistake', mistakeId);
const counts = () => ({
  mistakes: db.prepare('SELECT COUNT(*) c FROM mistakes').get().c,
  variants: db.prepare('SELECT COUNT(*) c FROM variants').get().c,
  evidence: db.prepare('SELECT COUNT(*) c FROM mastery_evidence').get().c,
  events: db.prepare('SELECT COUNT(*) c FROM review_events').get().c,
});

test('#71 任务先落库为草稿：confirmed_at 为空，result 不碰任何学习记录', async () => {
  const id = await makeMistake();
  const before = counts();
  const out = await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });
  assert.equal(out.status, 201, JSON.stringify(out.data));

  const created = taskOf(out.data.task.id);
  assert.equal(created.status, 'queued');
  assert.equal(created.confirmed_at, null, '未确认内容必须是草稿');
  assert.equal(created.result_json, null);

  await drain();
  const done = taskOf(out.data.task.id);
  assert.equal(done.status, 'done');
  assert.ok(done.result_json, '草稿正文要落库');
  assert.equal(done.confirmed_at, null, '跑完也还是草稿，确认是教师的事');

  assert.deepEqual(counts(), before, 'AI 不得写 mistakes / variants / 证据 / 复习事件');
});

test('#71 幂等：同题同版本同阶段只建一条，重复请求不重复消耗', async () => {
  const id = await makeMistake();
  const first = await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });
  const second = await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });

  assert.equal(second.status, 200, '复用既有任务返回 200，不新建');
  assert.equal(second.data.task.id, first.data.task.id);
  assert.equal(second.data.reused, true);
  assert.equal(tasksOf(id).filter((t) => t.kind === 'analysis').length, 1);

  const key = taskOf(first.data.task.id).idem_key;
  assert.match(key, new RegExp(`^analysis:mistake:${id}:[0-9a-f]{8,}$`), '幂等键要能一眼看出阶段与版本');
});

test('#71 改 OCR 后旧下游失效：新版本另建，旧任务标 superseded 且不可确认', async () => {
  const id = await makeMistake('1/2 与 1/3 哪个大？');
  const out = await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });
  await drain();
  const oldTask = taskOf(out.data.task.id);
  assert.equal(oldTask.status, 'done');

  // 老师改了题干（OCR 核对），输入版本必须变化。
  db.prepare('UPDATE mistakes SET prompt = ?, updated_at = ? WHERE id = ?').run('改过的题干', NOW, id);

  const again = await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });
  assert.equal(again.status, 201, '输入变了要新建任务');
  assert.notEqual(again.data.task.id, oldTask.id);

  const stale = taskOf(oldTask.id);
  assert.equal(stale.status, 'superseded');
  assert.ok(stale.superseded_at, '要留下作废时间，行不删');
  assert.notEqual(stale.idem_key, taskOf(again.data.task.id).idem_key, '幂等键含输入版本');
});

test('#71 串接分析 → 备题 → 校验：全部草稿，且不碰学习记录', async () => {
  const id = await makeMistake('串接用题');
  const before = counts();
  await call('/api/ai/tasks', {
    method: 'POST', body: { kind: 'analysis', target_type: 'mistake', target_id: id },
  });

  // 一个任务跑完自动排下一阶段；排到没有 queued 为止。
  await drain();

  const kinds = tasksOf(id).map((t) => `${t.kind}:${t.status}`);
  assert.ok(kinds.includes('analysis:done'), kinds.join(','));
  assert.ok(kinds.includes('practice:done'), `analysis 跑完要自动排备题，实际 ${kinds.join(',')}`);
  assert.ok(kinds.includes('validation:done'), `备题跑完要自动排校验，实际 ${kinds.join(',')}`);

  for (const t of tasksOf(id)) {
    assert.equal(t.confirmed_at, null, `${t.kind} 不得自动确认`);
  }
  assert.deepEqual(counts(), before, 'AI 不得写学习记录');
});

test('#71 重启恢复：卡在 running 的待办能回队，超次数直接失败', () => {
  const id = db.prepare("INSERT INTO mistakes (subject, prompt, status, created_at, updated_at) VALUES ('math','恢复用题','new',?,?)")
    .run(NOW, NOW).lastInsertRowid;

  const stale = createTask(db, { kind: 'analysis', targetType: 'mistake', targetId: Number(id), now: NOW });
  db.prepare("UPDATE ai_tasks SET status='running', attempts=1, started_at=? WHERE id=?").run('2026-11-05T00:00:00.000Z', stale.task.id);
  const exhausted = createTask(db, { kind: 'practice', targetType: 'mistake', targetId: Number(id), now: NOW });
  db.prepare("UPDATE ai_tasks SET status='running', attempts=3, started_at=? WHERE id=?").run('2026-11-05T00:00:00.000Z', exhausted.task.id);

  const result = recoverStaleTasks(db, { now: () => NOW, staleMs: 30 * 60 * 1000, maxAttempts: 3 });

  assert.equal(taskOf(stale.task.id).status, 'queued', '没超次数的回队重跑');
  assert.equal(taskOf(exhausted.task.id).status, 'failed', '超次数的不再空转');
  assert.equal(taskOf(exhausted.task.id).error_code, 'MAX_ATTEMPTS');
  assert.deepEqual(result, { requeued: 1, failed: 1 });
});

test('#71 额度不足：任务进 blocked 并说明原因，不抛错也不吞照片', async () => {
  const id = await makeMistake('额度用尽');
  const denied = createTask(db, {
    kind: 'analysis', targetType: 'mistake', targetId: id, now: NOW, quota: 0,
  });
  assert.equal(denied.task.status, 'blocked');
  assert.equal(denied.task.error_code, 'QUOTA_EXCEEDED');
  assert.equal(denied.task.result_json, null);

  // 手工路径不受影响：错题本身、原图字段都还在。
  const mistake = db.prepare('SELECT id, prompt, image_path, status FROM mistakes WHERE id = ?').get(id);
  assert.ok(mistake);
  assert.equal(mistake.status, 'new');
});

test('#71 上游失败留痕可重试：error_code 落库，重试回队', async () => {
  const id = await makeMistake('失败重试用');
  calls = [];
  provider = fakeProvider({ failOn: 'analysis' });
  const created = createTask(db, { kind: 'analysis', targetType: 'mistake', targetId: id, now: NOW });

  await drain(provider);
  const failed = taskOf(created.task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'UPSTREAM_TIMEOUT');
  assert.equal(failed.result_json, null);

  const retry = await call(`/api/ai/tasks/${failed.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(taskOf(failed.id).status, 'queued');
  assert.equal(taskOf(failed.id).attempts, failed.attempts, '重试次数在跑的时候才加');
  provider = fakeProvider();
});

test('#71 AI 关闭：接口明确拒绝，手工路径照常可用', async () => {
  const closed = createApp({
    db,
    dataDir,
    schedulerState: { running: false },
    aiStatus: () => ({ enabled: false, configured: false }),
    aiControl: { configured: false, enabled: false },
    aiPipeline: { provider: fakeProvider(), quota: 30, now: () => NOW },
  });
  const off = listenLoopback(closed);
  await new Promise((resolve) => off.once('listening', resolve));
  const offBase = `http://127.0.0.1:${off.address().port}`;

  try {
    const id = await makeMistake('AI 关闭时');
    const res = await fetch(`${offBase}/api/ai/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'analysis', target_type: 'mistake', target_id: id }),
    });
    assert.equal(res.status, 409, 'AI 关闭时不得假装能分析');
    const body = await res.json();
    assert.equal(body.error.code, 'AI_DISABLED');

    // 手工路径：原图与手填都还能用。
    const manual = await fetch(`${offBase}/api/mistakes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'math', prompt: '手工录的题' }),
    });
    assert.equal(manual.status, 201, 'AI 关闭不影响手工录入');
  } finally {
    await new Promise((resolve) => off.close(resolve));
  }
});
