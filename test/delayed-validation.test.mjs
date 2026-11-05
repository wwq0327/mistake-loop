// #69 测试先行：1-3-7-30 的「30」必须是真实发生的长间隔任务（方案 A，已确认）。
//
// 红灯复现（审阅报告的推演）：1 月 1 日纠错完成，按期做对得到
// 1/2 → 1/3 → 1/6 → 1/13 四轮，第 4 轮带证据当場判已掌握——
// 30 天间隔从未发生，却已经「掌握」。
//
// 方案 A 契约：
//   1-3-7-30 是相邻两次复习的间隔；第一次到第 4 轮只排 +30 天；
//   那次 30 天间隔的任务真实完成（到期日已到或已过）且本轮有证据，才判已掌握；
//   迟到完成不算违约（迟到不重置），提前完成不算完成等待；
//   旧排期保留来源，不批量重排、不补历史。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { addDays } from '../src/lib/dates.mjs';
import { applyReview, canMaster } from '../src/state-machine.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-delayed-'));
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
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

function makeMistake({ round, nextReview }) {
  const now = '2026-11-04T00:00:00.000Z';
  return Number(db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, next_review, created_at, updated_at)
    VALUES ('math', '一道题', 'reviewing', ?, ?, ?, ?)
  `).run(round, nextReview, now, now).lastInsertRowid);
}

function addCycleEvidence(id, createdAt) {
  db.prepare(`
    INSERT INTO mastery_evidence (mistake_id, kind, note, created_at) VALUES (?, 'retell', '学生复述了解法', ?)
  `).run(id, createdAt);
}

test('#69 状态机红灯复现：1/2→1/3→1/6→1/13 四轮做对不判已掌握，第 4 轮排 +30', () => {
  // 初学日 1 月 1 日纠错完成，轮次从 0 开始，逐轮按期做对。
  let current = { status: 'reviewing', review_round: 0, next_review: '2026-01-02', mastered_at: null };
  const days = ['2026-01-02', '2026-01-03', '2026-01-06', '2026-01-13'];
  for (const day of days) {
    current = applyReview({ mistake: current, result: 'correct', today: day, evidenceCount: 1 });
  }
  assert.equal(current.review_round, 4);
  assert.equal(current.status, 'reviewing', '第 4 轮做对不当场掌握：30 天间隔还没发生');
  assert.equal(current.next_review, '2026-02-12', '第 4 轮之后排 +30 天的长间隔任务');
  assert.equal(current.mastered_at, null);
});

test('#69 30 天任务真实完成后有本轮证据才掌握', () => {
  // 第 4 轮已完成、+30 任务到期日 2 月 12 日。
  const base = { status: 'reviewing', review_round: 4, next_review: '2026-02-12', mastered_at: null };

  const onTime = applyReview({ mistake: base, result: 'correct', today: '2026-02-12', evidenceCount: 1 });
  assert.equal(onTime.status, 'mastered', '到期当天完成 + 本轮证据 → 掌握');
  assert.equal(onTime.mastered_at, '2026-02-12');

  const late = applyReview({ mistake: base, result: 'correct', today: '2026-02-20', evidenceCount: 1 });
  assert.equal(late.status, 'mastered', '迟到不重置：迟到完成同样算完成长间隔任务');

  const early = applyReview({ mistake: base, result: 'correct', today: '2026-02-05', evidenceCount: 1 });
  assert.equal(early.status, 'reviewing', '提前完成不算完成等待');
  assert.equal(early.next_review, '2026-03-07', '提前登记后重新排 +30');

  const noEvidence = applyReview({ mistake: base, result: 'correct', today: '2026-02-12', evidenceCount: 0 });
  assert.equal(noEvidence.status, 'reviewing', '没有本轮证据不掌握');
  assert.equal(noEvidence.next_review, '2026-03-14');
});

test('#69 canMaster：第 4 轮任务真实完成（前一轮已是 4）加证据两个条件缺一不可', () => {
  assert.equal(canMaster(3, 1), false, '第 3 轮做对到第 4 轮，不是长间隔任务');
  assert.equal(canMaster(4, 0), false, '长间隔任务完成但没有本轮证据');
  assert.equal(canMaster(4, 1), true);
});

test('#69 真实接口：第一次到第 4 轮不掌握，等待过后完成才掌握', async () => {
  // 第一步：第 3 轮做对 → 到第 4 轮，排 +30，不掌握。
  const id = makeMistake({ round: 3, nextReview: addDays('2026-11-01', 0) });
  addCycleEvidence(id, '2026-11-01T00:00:00.000Z');
  const first = await call(`/api/reviews/${id}/result`, {
    method: 'POST', body: { result: 'correct', due_on: '2026-11-01' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.status, 'reviewing', '第一次到第 4 轮不当场掌握');
  assert.equal(first.data.next_review, addDays('2026-11-05', 30), '排 +30 天');

  // 第二步：把到期日改到昨天，模拟 30 天真的过去了（不造历史，只快进待办）。
  db.prepare('UPDATE mistakes SET next_review = ? WHERE id = ?').run(addDays('2026-11-05', -1), id);
  const second = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct' } });
  assert.equal(second.status, 200);
  assert.equal(second.data.status, 'mastered', '长间隔任务真实完成后，有本轮证据即掌握');
});

test('#69 存量排期兼容：旧库里的第 4 轮到期任务完成后照常判定，不批量重排', async () => {
  // 旧行为生成的存量：round 已是 4、next_review 是当年排下的 +30。
  const id = makeMistake({ round: 4, nextReview: '2026-10-01' });
  addCycleEvidence(id, '2026-09-01T00:00:00.000Z');
  const res = await call(`/api/reviews/${id}/result`, {
    method: 'POST', body: { result: 'correct', due_on: '2026-10-01' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'mastered', '存量第 4 轮任务完成即按新闸门判定，无需迁移重排');
});
