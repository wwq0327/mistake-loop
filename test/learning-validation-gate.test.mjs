// #67 测试先行：变式质量审核与学生验证分离。
//
// 复现的缺口：教师点三次「审核通过」，后端直接写 reviewed=1、result=pass、
// attempted_at=now，三层 pass 即推进复习——题目质量被当成了学生完成验证，
// 学生没做过也能进复习，attempted_at 还是伪造的「作答时间」。
//
// 分离后的契约（设计提案已确认）：
//   PATCH /variants/:id/review  只做质量审核（题目本身成立与否），不写作答时间；
//   PATCH /variants/:id/attempt 登记学生本轮真实作答（independent/hinted/unmet/unjudged）；
//   推进复习需同时满足：三层质量 pass + 三层本轮 independent + 学生关键结论非空；
//   unmet 作为 #68 的回落标记参与证据周期清零；存量 reviewed/result 不补造作答。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { today, addDays } from '../src/lib/dates.mjs';
import { countCycleEvidence } from '../src/routes/reviews.mjs';
import { applyVariantResults } from '../src/state-machine.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-valgate-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-05T00:00:00.000Z')").run();
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

// 造一道纠错中的题（可带/不带学生关键结论）与三条变式，返回错题 id。
function makeCase({ conclusion = '学生自己说：十位的 2 是 2 个十' } = {}) {
  const now = '2026-11-05T00:00:00.000Z';
  const info = db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, student_conclusion, created_at, updated_at)
    VALUES ('math', '一道题', 'correcting', ?, ?, ?)
  `).run(conclusion, now, now);
  const id = Number(info.lastInsertRowid);
  for (const level of ['surface', 'structure', 'context']) {
    db.prepare('INSERT INTO variants (mistake_id, level, prompt, correct_answer) VALUES (?, ?, ?, ?)')
      .run(id, level, `${level} 变式`, '8');
  }
  return id;
}

const variantsOf = (id) => db.prepare('SELECT * FROM variants WHERE mistake_id = ? ORDER BY id').all(id);
const mistakeOf = (id) => db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);

async function reviewAll(id, result = 'pass') {
  for (const v of variantsOf(id)) {
    const out = await call(`/api/variants/${v.id}/review`, { method: 'PATCH', body: { result } });
    assert.equal(out.status, 200, `质量审核应成功：${out.text}`);
  }
}

async function attemptAll(id, result = 'independent') {
  for (const v of variantsOf(id)) {
    const out = await call(`/api/variants/${v.id}/attempt`, { method: 'PATCH', body: { result, note: '学生原话记录' } });
    assert.equal(out.status, 200, `登记作答应成功：${out.text}`);
  }
}

test('#67 只审核三层不产生学生通过：状态不动、作答字段全空', async () => {
  const id = makeCase();
  await reviewAll(id);

  const mistake = mistakeOf(id);
  assert.equal(mistake.status, 'correcting', '审核不等于作答，三层审核不得推进状态');
  for (const v of variantsOf(id)) {
    assert.equal(v.reviewed, 1, '质量审核要落库');
    assert.equal(v.result, 'pass', '质量结论要落库');
    assert.equal(v.student_result, null, '审核不得替学生写通过结果');
    assert.equal(v.student_verified_at, null, '审核不得伪造作答时间');
    assert.equal(v.attempted_at, null, '审核不得伪造作答时间（attempted_at）');
  }
});

test('#67 三层质量 pass + 三轮独立作答 + 有关键结论才进复习', async () => {
  const id = makeCase();
  await reviewAll(id);
  await attemptAll(id);

  const mistake = mistakeOf(id);
  assert.equal(mistake.status, 'reviewing');
  assert.equal(mistake.next_review, addDays(today(), 1));
});

test('#67 学生关键结论为空是总闸门：全部通过也不推进', async () => {
  const id = makeCase({ conclusion: null });
  await reviewAll(id);
  const last = await call(`/api/variants/${variantsOf(id)[2].id}/attempt`, {
    method: 'PATCH', body: { result: 'independent' },
  });

  assert.equal(last.status, 200);
  assert.equal(mistakeOf(id).status, 'correcting', '没有学生自己的关键结论，不得进复习');
  assert.ok(/关键结论|结论/.test(JSON.stringify(last.data)), '响应要说清卡在哪里');
});

test('#67 提示后完成与未完成都不推进', async () => {
  for (const result of ['hinted', 'unmet', 'unjudged']) {
    const id = makeCase();
    await reviewAll(id);
    await attemptAll(id, result);
    assert.equal(mistakeOf(id).status, 'correcting', `${result} 不应推进状态`);
  }
});

test('#67 unmet 是回落标记：旧证据不再算本轮', async () => {
  const id = makeCase();
  db.prepare(`
    INSERT INTO mastery_evidence (mistake_id, kind, note, created_at)
    VALUES (?, 'retell', '上一周期的复述', '2026-01-05T00:00:00.000Z')
  `).run(id);
  await reviewAll(id);
  await attemptAll(id, 'unmet');

  const v = variantsOf(id)[0];
  assert.ok(v.student_verified_at, 'unmet 要留下登记时间');
  assert.equal(countCycleEvidence(db, id), 0, 'unmet 之后，回落前的证据不得再算本轮');
});

test('#67 存量 reviewed/result 不算学生验证：不操作就永远不推进', async () => {
  // 模拟旧库迁移来的行：质量审核已过、作答字段全空。
  const id = makeCase();
  db.prepare('UPDATE variants SET reviewed = 1, result = ? WHERE mistake_id = ?').run('pass', id);
  assert.equal(mistakeOf(id).status, 'correcting', '存量审核不得被当作已验证');
});

test('#67 作答登记的前置与校验', async () => {
  const id = makeCase();
  const [first] = variantsOf(id);

  // 没过质量审核不能登记作答。
  const early = await call(`/api/variants/${first.id}/attempt`, { method: 'PATCH', body: { result: 'independent' } });
  assert.equal(early.status, 409, `未审核的变式不得登记作答，实际 ${early.status}`);

  // 非法档位拒绝且不落库。
  await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
  const bad = await call(`/api/variants/${first.id}/attempt`, { method: 'PATCH', body: { result: 'pass' } });
  assert.equal(bad.status, 400, '质量审核的取值不得混进作答档位');
  const row = db.prepare('SELECT student_result FROM variants WHERE id = ?').get(first.id);
  assert.equal(row.student_result, null, '被拒的登记不得落库');
});

test('#67 状态机：推进需要 independent，质量 fail 仍回诊断', () => {
  const levels = ['surface', 'structure', 'context'];
  const build = (student) => levels.map((level) => ({ level, quality: 'pass', student }));

  const advance = applyVariant(build('independent'));
  assert.equal(advance.status, 'reviewing');
  assert.equal(applyVariant(build('hinted')), null, '提示后完成不推进');
  assert.equal(applyVariant(build('unmet')), null, '未完成不推进');
  assert.equal(applyVariant(build(null)), null, '只审核未登记作答不推进');

  const fail = levels.map((level, i) => ({ level, quality: i === 1 ? 'fail' : 'pass', student: 'independent' }));
  assert.deepEqual(applyVariant(fail), {
    status: 'diagnosing', review_round: 0, next_review: null, mastered_at: null,
  }, '质量 fail 仍打回诊断');

  function applyVariant(results) {
    return applyVariantResults({ mistake: { status: 'correcting' }, results, today: '2026-11-05' });
  }
});
