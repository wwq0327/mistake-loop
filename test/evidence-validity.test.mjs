// #68 测试先行：掌握证据必须与「本轮」的真实观察对应。
//
// 复现的三个缺口：
//   1) POST /reviews/:id/result 对 result=wrong 同时带 evidence_type 仍返 200 并新增证据——
//      做错反而攒证据，后面重新走轮次时直接拿来判掌握。
//   2) 证据只按全历史 COUNT 统计：复发（做错回诊断）之后，上一周期的旧证据仍然算数，
//      于是「第 4 轮做对」凭旧证据就能判已掌握，本轮根本没观察过。
//   3) 工作台那条旧今日列表的证据下拉没有空选项（默认停在第 1 项「复述」），
//      还自动把 evidence_note 写成「老师在复习现场记录的学生证据」——
//      与看板不是一个标准，等于替老师造了一条观察记录。
//
// 本轮口径（契约）：一次「回落」把证据周期清零。
// 回落 = 最近一次 review_events.result='wrong' 的 done_at，或最近一次变式审核 fail 的 attempted_at。
// 只有回落之后录入的证据才算本轮证据；旧证据保留在库，不删、不改，只是不参与本轮判定。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { today, addDays } from '../src/lib/dates.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-evidence-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  const app = createApp({ db, dataDir, schedulerState: { running: true } });
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
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

function makeMistake({ round = 0, nextReview = addDays(today(), -1) } = {}) {
  const now = '2026-11-04T00:00:00.000Z';
  return Number(db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, next_review, created_at, updated_at)
    VALUES ('math', '一道题', 'reviewing', ?, ?, ?, ?)
  `).run(round, nextReview, now, now).lastInsertRowid);
}

function addEvidence(id, createdAt) {
  db.prepare(`
    INSERT INTO mastery_evidence (mistake_id, kind, note, created_at) VALUES (?, 'retell', '学生复述了解法', ?)
  `).run(id, createdAt);
}

// 直接写一条历史回落事件：模拟这道题在过去某一轮做错过。
function addWrongEvent(id, doneAt) {
  db.prepare(`
    INSERT INTO review_events (mistake_id, round, due_on, done_at, result, note, evidence_type)
    VALUES (?, 0, NULL, ?, 'wrong', '当时做错了', NULL)
  `).run(id, doneAt);
}

const counts = (id) => ({
  evidence: db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(id).c,
  events: db.prepare('SELECT COUNT(*) c FROM review_events WHERE mistake_id = ?').get(id).c,
  status: db.prepare('SELECT status, review_round, next_review FROM mistakes WHERE id = ?').get(id),
});

test('#68 做错时带证据：整请求被拒，证据与复习记录都不落库', async () => {
  const id = makeMistake({ round: 3 });
  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST',
    body: { result: 'wrong', evidence_type: 'retell', evidence_note: '学生复述了', due_on: addDays(today(), -1) },
  });

  assert.equal(res.status, 400, '做错同时报掌握证据应被拒，而不是默默收下');
  assert.match(res.data.error.message, /做错|证据/, '错误信息要说清哪一条不让');
  const after = counts(id);
  assert.equal(after.evidence, 0, '被拒的请求不得留下掌握证据');
  assert.equal(after.events, 0, '被拒的请求不得留下复习记录');
  assert.equal(after.status.status, 'reviewing', '被拒的请求不得改状态');
  assert.equal(after.status.review_round, 3, '被拒的请求不得动轮次');
});

test('#68 复发前的旧证据不算本轮：第 4 轮做对也不判已掌握', async () => {
  const id = makeMistake({ round: 4 });
  addEvidence(id, '2026-01-05T00:00:00.000Z');       // 上一周期的证据
  addWrongEvent(id, '2026-02-01T00:00:00.000Z');     // 之后做错，回落

  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST',
    body: { result: 'correct', due_on: addDays(today(), -1) },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'reviewing', '旧证据不能顶替本轮的观察');
  assert.equal(res.data.review_round, 4);
  assert.equal(res.data.next_review, addDays(today(), 30), '仍按 30 天再排一次，等真实延迟验证');
  assert.equal(counts(id).evidence, 1, '旧证据要保留，不删不改');
});

test('#68 回落之后录入的证据才算本轮：第 4 轮做对可判已掌握', async () => {
  const id = makeMistake({ round: 4 });
  addEvidence(id, '2026-01-05T00:00:00.000Z');       // 上一周期
  addWrongEvent(id, '2026-02-01T00:00:00.000Z');     // 回落
  addEvidence(id, '2026-02-10T00:00:00.000Z');       // 本轮观察

  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST',
    body: { result: 'correct', due_on: addDays(today(), -1) },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'mastered', '本轮有证据，第 4 轮做对应当掌握');
});

test('#68 变式审核不过也算回落：之前的证据同样不算本轮', async () => {
  const id = makeMistake({ round: 4 });
  addEvidence(id, '2026-01-05T00:00:00.000Z');
  db.prepare(`
    INSERT INTO variants (mistake_id, level, prompt, reviewed, result, attempted_at)
    VALUES (?, 'structure', '变式题干', 1, 'fail', '2026-02-05T00:00:00.000Z')
  `).run(id);

  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST',
    body: { result: 'correct', due_on: addDays(today(), -1) },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'reviewing', '变式没通过之后的回落也要清空证据周期');
});

test('#68 两个登记入口同一套约束：证据无预选、做错不带证据、不代填证据说明', () => {
  const workbench = readFileSync(new URL('../public/js/pages/workbench.js', import.meta.url), 'utf8');
  const board = readFileSync(new URL('../public/js/pages/board.js', import.meta.url), 'utf8');

  for (const [name, source] of [['工作台', workbench], ['看板', board]]) {
    assert.match(source, /result === 'correct'[^\n]*evidence/, `${name}：证据只能跟着「做对」提交`);
    assert.doesNotMatch(source, /evidence_note\s*=\s*'/, `${name}：不得自动填写证据说明`);
  }

  // 工作台那条旧列表的下拉框必须与看板一样，第一项是空占位、且初始为空。
  assert.match(workbench, /blank\.value = ''/, '工作台证据下拉要有一个空值占位项');
  assert.match(workbench, /evidenceSelect\.value = ''/, '工作台证据下拉初始不预选任何一条');
  // 第 4 轮记「做对」却没选证据时，必须在本地就拦住，不能发出去等后端拒。
  assert.match(workbench, /要记做对[^\n]*证据|先选一条[^\n]*证据/, '工作台缺「没选证据就拦下」的提示');
});
