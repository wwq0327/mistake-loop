// #52 测试先行：变式审核路径必须过教学法闸门。
// 红灯预期：现在 PATCH /api/variants/:id/retry… 变式审核完全不校验所属错题的状态，
// 于是两道题都能穿过闸门：
//   一道 new 题（学生从没说���关键结论）三层全过 → 直接进 reviewing；
//   一道 mastered 题一次 fail → 被打回 diagnosing，掌握证据被清空。
// 依据：AGENTS.md「教学法硬约束」与 PRD F02 / F03 / F06——
//   F02「结论为空时系统不允许把状态推到『纠错中』」
//   F03「三层全过才进复习队列」
//   F06「掌握判定：不以一次做对判定」
// 闸门只挂在 PATCH /api/mistakes/:id/diagnosis 上（src/routes/mistakes.mjs:176、:199-203），
// 变式审核是第二条能改 mistakes.status 的路径，它绕过了闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { applyVariantResults } from '../src/state-machine.mjs';

let dataDir;
let db;
let server;
let base;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-variant-gate-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-05T00:00:00.000Z')").run();
  const app = createApp({ db, dataDir });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
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
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

// 直接造一道指定状态的题，并配好三条变式。
function makeMistakeWithVariants(status, { reviewed = false } = {}) {
  const now = '2026-11-05T00:00:00.000Z';
  const info = db.prepare(
    "INSERT INTO mistakes (subject, prompt, status, student_conclusion, review_round, created_at, updated_at) VALUES ('math', '闸门测试题', ?, ?, 0, ?, ?)",
  ).run(status, status === 'new' ? null : '学生自己说：单位没换算', now, now);
  const id = Number(info.lastInsertRowid);
  for (const level of ['surface', 'structure', 'context']) {
    db.prepare(
      'INSERT INTO variants (mistake_id, level, prompt, correct_answer, reviewed, result) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run(id, level, `${level} 变式`, '8', reviewed ? 1 : 0);
  }
  return id;
}

function variantsOf(id) {
  return db.prepare('SELECT id, level FROM variants WHERE mistake_id = ? ORDER BY id').all(id);
}

function statusOf(id) {
  return db.prepare('SELECT status FROM mistakes WHERE id = ?').get(id).status;
}

test('#52 new 状态不能审核变式：不能跳过诊断直接进复习中', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('new');
    const [first] = variantsOf(id);

    const out = await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
    assert.equal(out.status, 409, `new 状态审核变式必须被拦，实际 ${out.status}: ${out.text}`);
    assert.equal(statusOf(id), 'new', '被拦的审核不该改状态');
    assert.match(out.text, /纠错中|状态/, '错误信息要说清当前状态不能审核');
  } finally { teardown(); }
});

test('#52 mastered 状态不能审核变式：不能被打回并清空掌握成果', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('mastered');
    db.prepare("UPDATE mistakes SET mastered_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(id);
    db.prepare(
      'INSERT INTO mastery_evidence (mistake_id, kind, note, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, 'retell', '学生复述了单位换算', '2026-11-01T00:00:00.000Z');
    const [first] = variantsOf(id);

    const out = await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'fail' } });
    assert.equal(out.status, 409, `mastered 状态审核变式必须被拦，实际 ${out.status}: ${out.text}`);

    const row = db.prepare('SELECT status, review_round, mastered_at FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.status, 'mastered', '已掌握的题不该被打回');
    assert.equal(row.review_round, 0, '复习轮次不该被清零');
    assert.ok(row.mastered_at, '掌握时间不该被清空');
    const evidence = db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(id).c;
    assert.equal(evidence, 1, '掌握证据不该被删');
  } finally { teardown(); }
});

test('#52 被拦的审核不写 sessions 留痕', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('new');
    const [first] = variantsOf(id);
    await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
    const sessions = db.prepare('SELECT COUNT(*) c FROM sessions WHERE mistake_id = ?').get(id).c;
    assert.equal(sessions, 0, '被拦的审核不该留下任何痕迹');
    const variant = db.prepare('SELECT reviewed FROM variants WHERE id = ?').get(first.id);
    assert.equal(variant.reviewed, 0, '被拦的审核不该把变式标成已审核');
  } finally { teardown(); }
});

test('#52 correcting 状态三层全过仍进复习中：正路不能被堵', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('correcting');
    for (const v of variantsOf(id)) {
      const out = await call(`/api/variants/${v.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
      assert.equal(out.status, 200, `correcting 状态审核应成功，实际 ${out.status}: ${out.text}`);
    }
    const row = db.prepare('SELECT status, review_round, next_review FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.status, 'reviewing', '三层全过应进复习中');
    assert.equal(row.review_round, 0);
    assert.ok(row.next_review, '进复习中后应排下次复习日期');
  } finally { teardown(); }
});

test('#52 correcting 状态任一层 fail 仍回诊断：打回路径不能被堵', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('correcting');
    const [first] = variantsOf(id);
    const out = await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'fail' } });
    assert.equal(out.status, 200, `correcting 状态审核 fail 应成功，实际 ${out.status}: ${out.text}`);
    assert.equal(statusOf(id), 'diagnosing', '变式做错应打回诊断');
  } finally { teardown(); }
});

test('#52 diagnosing 状态可以审核变式：v1 的接口流程走的就是这条路', async () => {
  // v1 的冒烟测试流程是「录入 → diagnosing → 审核三层 → reviewing」，
  // 不经过 correcting。「已有测试一个不改」是硬红线，所以 diagnosing 必须放行。
  await setup();
  try {
    const id = makeMistakeWithVariants('diagnosing');
    for (const v of variantsOf(id)) {
      const out = await call(`/api/variants/${v.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
      assert.equal(out.status, 200, `diagnosing 状态审核应成功，实际 ${out.status}: ${out.text}`);
    }
    assert.equal(statusOf(id), 'reviewing', '三层全过应进复习中');
  } finally { teardown(); }
});

test('#52 reviewing 状态不能审核变式：不能把复习轮次归零', async () => {
  await setup();
  try {
    const id = makeMistakeWithVariants('reviewing');
    db.prepare('UPDATE mistakes SET review_round = 2, next_review = ? WHERE id = ?')
      .run('2026-11-08', id);
    const [first] = variantsOf(id);
    const out = await call(`/api/variants/${first.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
    assert.equal(out.status, 409, `reviewing 状态审核变式必须被拦，实际 ${out.status}: ${out.text}`);
    const row = db.prepare('SELECT status, review_round FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.review_round, 2, '复习轮次不该被归零');
  } finally { teardown(); }
});

test('#52 状态机自己也要守闸门：不能只靠路由层', async () => {
  // 路由层是唯一生产调用方，但状态机是规则的归属地：
  // 换个调用方（比如以后加个批量审核接口）如果绕过路由层，闸门就漏了。
  const DAY = '2026-11-05';
  const allPass = [
    { level: 'surface', result: 'pass' },
    { level: 'structure', result: 'pass' },
    { level: 'context', result: 'pass' },
  ];
  assert.throws(
    () => applyVariantResults({ mistake: { status: 'new' }, results: allPass, today: DAY }),
    /状态|纠错/,
    '状态机自己必须拒绝在 new 状态推进',
  );
  assert.throws(
    () => applyVariantResults({ mistake: { status: 'mastered' }, results: allPass, today: DAY }),
    /状态|纠错/,
    '状态机自己必须拒绝在 mastered 状态推进',
  );
  assert.throws(
    () => applyVariantResults({ mistake: { status: 'reviewing' }, results: allPass, today: DAY }),
    /状态|纠错/,
    '状态机自己必须拒绝在 reviewing 状态推进',
  );
  // 允许的状态照常工作。
  assert.equal(applyVariantResults({ mistake: { status: 'correcting' }, results: allPass, today: DAY }).status, 'reviewing');
  assert.equal(applyVariantResults({ mistake: { status: 'diagnosing' }, results: allPass, today: DAY }).status, 'reviewing');
});
