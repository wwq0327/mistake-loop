// #56 测试先行：同一次复习不能被记两遍。
//
// 背景：工作台「做对 / 做错」按钮在请求在飞时不禁用，老师手快连点两下，
// 后端两次都返 200，一次复习被记成两轮（review_round 1→3、排期被推两次）。
//
// 这里最要紧的一点：**后端从数据上分不清「连点两下」与「连做 4 轮」**——
// v1 的既有测试 P7 明确要求连发 4 次每次都 200，两种场景的 due_on 序列
// （昨天、+1、+4、+7）一模一样。所以判据必须由前端提供：
// 「这次复习」的身份是它针对的到期日 due_on。
//
// 传了 due_on 就查重；不传则行为完全不变（v1 的 28 个测试一个都不受影响）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { today, addDays } from '../src/lib/dates.mjs';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-idem-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  const app = createApp({ db, dataDir, schedulerState: { running: true } });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

// 造一道在复习中的题：nextReview 决定「这次复习针对哪一天」。
// review_round 初始为 0 —— 这是一道刚经变式审核进入复习中的题的真实状态，
// 也是 v1 的 P7 用的初始值（从 1 起算会让第 3 次提交就判为已掌握）。
function makeMistake(nextReview) {
  const now = '2026-11-04T00:00:00.000Z';
  return Number(db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, next_review, created_at, updated_at)
    VALUES ('math', '一道题', 'reviewing', 0, ?, ?, ?)
  `).run(nextReview, now, now).lastInsertRowid);
}

function snapshot(id) {
  const mistake = db.prepare('SELECT status, review_round, next_review, mastered_at FROM mistakes WHERE id = ?').get(id);
  return {
    mistake,
    events: db.prepare('SELECT COUNT(*) c FROM review_events WHERE mistake_id = ?').get(id).c,
    evidence: db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(id).c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions WHERE mistake_id = ?').get(id).c,
  };
}

test('#56 同一个 due_on 提交两次：第二次 409，数据一条不多', async () => {
  const id = makeMistake('2026-11-01');
  const dueOn = '2026-11-01';

  const first = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: dueOn } });
  assert.equal(first.status, 200, '第一次提交应当成功');
  const afterFirst = snapshot(id);
  assert.equal(afterFirst.mistake.review_round, 1, '第一次提交应把轮次推到 1');

  const second = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: dueOn } });
  assert.equal(second.status, 409, '同一次复习不该被记第二遍');
  // 必须点名是哪一条防线拦住的：查重（已提交过）与「到期日对不上」是两道独立的检查，
  // 删掉任何一道，这条断言都会把它逼出来——只断言 409 的话，
  // 两道防线会互相掩盖，删掉一道另外一道照样拦得住，测试却照样绿。
  assert.match(second.data.error.message, /已经记过/, '提示要说清是重复提交');

  const afterSecond = snapshot(id);
  assert.deepEqual(afterSecond, afterFirst, '被拒的重复提交不得改动任何数据');
});

test('#56 被拒的重复提交不得留下 review_events / mastery_evidence / sessions', async () => {
  const id = makeMistake('2026-11-01');
  await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: '2026-11-01' } });
  await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: '2026-11-01' } });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM review_events WHERE mistake_id = ?').get(id).c, 1,
    'review_events 只应有一条');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(id).c, 0,
    '重复提交不应留下掌握证据');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE mistake_id = ?').get(id).c, 1,
    'sessions 不应因重复提交多出一行');
});

test('#56 连做多轮仍然可用：换了 due_on 就该放行', async () => {
  const id = makeMistake('2026-11-01');
  const first = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: '2026-11-01' } });
  assert.equal(first.status, 200);
  const nextDue = db.prepare('SELECT next_review FROM mistakes WHERE id = ?').get(id).next_review;

  // 下一轮的到期日变了，就不是同一次复习——必须放行。
  const second = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct', due_on: nextDue } });
  assert.equal(second.status, 200, '换了到期日就不是重复提交，应放行');
  assert.equal(db.prepare('SELECT review_round FROM mistakes WHERE id = ?').get(id).review_round, 2);
});

test('#56 不传 due_on 时行为不变：连发 4 次都 200，轮次走到 4', async () => {
  // v1 的 P7 明确要求连发 4 次每次都 200（模拟「这题过了 4 轮关」）。
  // 这条既有语义不能被幂等判据破坏，所以判据必须是可选的。
  const id = makeMistake(addDays(today(), -1));
  const first = await call(`/api/reviews/${id}/result`, {
    method: 'POST', body: { result: 'correct', evidence_type: 'retell' },
  });
  assert.equal(first.status, 200);
  for (let i = 0; i < 3; i += 1) {
    const step = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct' } });
    assert.equal(step.status, 200, `第 ${i + 2} 次提交应当放行`);
  }
  const row = db.prepare('SELECT status, review_round FROM mistakes WHERE id = ?').get(id);
  assert.equal(row.review_round, 4);
  assert.equal(row.status, 'mastered', '第 4 轮带证据应判为已掌握');
});

test('#56 due_on 与当前到期日对不上时拒绝，并说清是哪种不对', async () => {
  const id = makeMistake('2026-11-01');
  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST', body: { result: 'correct', due_on: '2026-11-02' },
  });
  assert.equal(res.status, 409, '到期日对不上应被拒');
  assert.match(res.data.error.message, /到期日/, '错误信息要点明是到期日对不上');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM review_events WHERE mistake_id = ?').get(id).c, 0,
    '被拒的提交不得留下 review_events');
});

test('#56 due_on 格式非法时返回 400', async () => {
  const id = makeMistake('2026-11-01');
  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST', body: { result: 'correct', due_on: '11月1日' },
  });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM review_events WHERE mistake_id = ?').get(id).c, 0);
});
