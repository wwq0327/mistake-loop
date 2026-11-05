// #40 测试先行：录入三层变式 → 逐条审核 → 题进入「复习中」，闭环必须走通。
// 背景：原来界面上没有录入变式的入口，状态机又要求三层全过才进复习，
// 于是老师实际无法让任何一道题走到「复习中」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-variant-entry-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const app = createApp({ db, dataDir });
  server = listenLoopback(app);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

function teardown() {
  server.close();
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeMistake() {
  const out = await call('/api/mistakes', {
    method: 'POST',
    body: { subject: 'math', prompt: '一道待纠错的题' },
  });
  assert.equal(out.status, 201);
  return out.body.id;
}

test('#40 录入三层变式后仍未生效：不推进状态、不上打印纸', async () => {
  await setup();
  try {
    const id = await makeMistake();
    await call(`/api/mistakes/${id}/diagnosis`, {
      method: 'PATCH',
      body: { status: 'correcting', student_conclusion: '学生自己说：单位没换算' },
    });

    const out = await call(`/api/mistakes/${id}/variants`, {
      method: 'POST',
      body: {
        variants: [
          { level: 'surface', prompt: '换数字的变式', correct_answer: '8' },
          { level: 'structure', prompt: '换角度的变式', correct_answer: '8' },
          { level: 'context', prompt: '换场景的变式', correct_answer: '8' },
        ],
      },
    });
    assert.equal(out.status, 201, '录入变式应成功');
    assert.equal(out.body.variants.length, 3);

    const row = db.prepare('SELECT status FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.status, 'correcting', '未审核的变式不该推进状态');

    const print = await call(`/api/print?ids=${id}`);
    assert.equal(print.body.cards.length, 1);
    assert.equal(print.body.cards[0].variants.length, 0, '未审核的变式不该上纸');
  } finally { teardown(); }
});

test('#40 三层变式逐条审核通过后，题进入「复习中」', async () => {
  await setup();
  try {
    const id = await makeMistake();
    await call(`/api/mistakes/${id}/diagnosis`, {
      method: 'PATCH',
      body: { status: 'correcting', student_conclusion: '学生自己说：单位没换算' },
    });
    await call(`/api/mistakes/${id}/variants`, {
      method: 'POST',
      body: {
        variants: [
          { level: 'surface', prompt: '换数字的变式', correct_answer: '8' },
          { level: 'structure', prompt: '换角度的变式', correct_answer: '8' },
          { level: 'context', prompt: '换场景的变式', correct_answer: '8' },
        ],
      },
    });

    const variants = db.prepare('SELECT id FROM variants WHERE mistake_id = ? ORDER BY id').all(id);
    assert.equal(variants.length, 3);
    for (const v of variants) {
      const out = await call(`/api/variants/${v.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
      assert.equal(out.status, 200);
    }

    const row = db.prepare('SELECT status, review_round, next_review FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.status, 'reviewing', '三层全过应进入复习中');
    assert.equal(row.review_round, 0);
    assert.ok(row.next_review, '进入复习中后应有下次复习日期');

    // 审核过的变式才上纸。
    const print = await call(`/api/print?ids=${id}`);
    assert.equal(print.body.cards[0].variants.length, 3, '已审核的变式应上纸');
  } finally { teardown(); }
});

test('#40 同一层再次录入是覆盖而不是重复', async () => {
  await setup();
  try {
    const id = await makeMistake();
    await call(`/api/mistakes/${id}/variants`, {
      method: 'POST',
      body: { variants: [{ level: 'surface', prompt: '第一版', correct_answer: '8' }] },
    });
    const out = await call(`/api/mistakes/${id}/variants`, {
      method: 'POST',
      body: { variants: [{ level: 'surface', prompt: '改过的第二版', correct_answer: '9' }] },
    });
    assert.equal(out.status, 201);
    assert.equal(out.body.variants.length, 1, '同一层不该产生两条');
    assert.equal(out.body.variants[0].prompt, '改过的第二版');
    assert.equal(out.body.variants[0].reviewed, 0, '覆盖后仍需重新审核');
  } finally { teardown(); }
});
