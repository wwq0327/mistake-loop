// #42 测试先行：三科分开的错因子子类型必须由后端校验。
// 红灯预期：src/lib/validation.mjs 尚无 checkSubtype，写入路径也不成对校验。
// 背景：实测语文题可以挂数学的「计算失误」，英语题可以挂「单位混淆」，
// 「三科分开」这条 PRD 硬约束只靠老师自觉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { checkSubtype } from '../src/lib/validation.mjs';
import { subtypesFor, allSubtypesFor } from '../src/lib/subjects.mjs';

const NOW = '2026-11-04T00:00:00Z';

let dataDir;
let db;
let server;
let base;
let seq = 0;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-subject-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const app = createApp({ db, dataDir });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

function teardown() {
  server.close();
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
}

async function makeMistake(subject) {
  seq += 1;
  const res = await fetch(`${base}/api/mistakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, prompt: `${subject} 题目 ${seq}` }),
  });
  assert.equal(res.status, 201, '建题应成功');
  const body = await res.json();
  return body.id;
}

async function diagnose(id, body) {
  const res = await fetch(`${base}/api/mistakes/${id}/diagnosis`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('#42 语文题不能挂数学子类型「计算失误」', async () => {
  await setup();
  try {
    const id = await makeMistake('chinese');
    const out = await diagnose(id, { error_category: 'procedural', error_subtype: '计算失误' });
    assert.equal(out.status, 400, '越界子类型必须被拒');
    assert.match(JSON.stringify(out.body), /语文/, '报错要说清是语文');
    assert.match(JSON.stringify(out.body), /近义词混淆/, '报错要列出语文可用的子类型');
    const row = db.prepare('SELECT error_subtype FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.error_subtype, null, '被拒的写入不该落库');
  } finally { teardown(); }
});

test('#42 英语题只接受「待归类」', async () => {
  await setup();
  try {
    const id = await makeMistake('english');
    const bad = await diagnose(id, { error_category: 'conceptual', error_subtype: '单位混淆' });
    assert.equal(bad.status, 400, '英语题不能挂数学子类型');
    const good = await diagnose(id, { error_category: 'conceptual', error_subtype: '待归类' });
    assert.equal(good.status, 200, '「待归类」应当可用');
  } finally { teardown(); }
});

test('#42 编造的子类型一律拒绝', async () => {
  await setup();
  try {
    const id = await makeMistake('math');
    const out = await diagnose(id, { error_category: 'factual', error_subtype: '外星人语' });
    assert.equal(out.status, 400);
  } finally { teardown(); }
});

test('#42 合法组合照常保存', async () => {
  await setup();
  try {
    const id = await makeMistake('math');
    const out = await diagnose(id, { error_category: 'procedural', error_subtype: '计算失误' });
    assert.equal(out.status, 200, '数学的合法子类型应保存');
    const row = db.prepare('SELECT error_category, error_subtype FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.error_category, 'procedural');
    assert.equal(row.error_subtype, '计算失误');

    const cn = await makeMistake('chinese');
    const cnOut = await diagnose(cn, { error_category: 'conceptual', error_subtype: '近义词混淆' });
    assert.equal(cnOut.status, 200, '语文的合法子类型应保存');
  } finally { teardown(); }
});

test('#42 改大类导致子类不合法时整次拒绝，原数据不动', async () => {
  await setup();
  try {
    const id = await makeMistake('chinese');
    const first = await diagnose(id, { error_category: 'factual', error_subtype: '部首遗忘' });
    assert.equal(first.status, 200);

    // 「部首遗忘」属于 factual，改成 conceptual 后子类就打架了。
    const second = await diagnose(id, { error_category: 'conceptual' });
    assert.equal(second.status, 400, '大类与子类打架必须拒绝');
    const row = db.prepare('SELECT error_category, error_subtype FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.error_category, 'factual', '被拒的修改不该落库');
    assert.equal(row.error_subtype, '部首遗忘');
  } finally { teardown(); }
});

test('#42 没定大类时不能填具体子类型', async () => {
  await setup();
  try {
    const id = await makeMistake('math');
    const out = await diagnose(id, { error_subtype: '计算失误' });
    assert.equal(out.status, 400, '没有大类不该能填具体子类型');
  } finally { teardown(); }
});

test('#42 纯函数层：字典按科目分列，互不共用', () => {
  assert.ok(subtypesFor('math', 'procedural').includes('计算失误'));
  assert.ok(!subtypesFor('chinese', 'procedural').includes('计算失误'), '语文不能有数学子类型');
  assert.ok(!subtypesFor('english', 'conceptual').includes('近义词混淆'));
  assert.deepEqual(subtypesFor('english', 'factual'), ['待归类']);
  assert.ok(allSubtypesFor('chinese').includes('近义词混淆'));
  assert.ok(!allSubtypesFor('chinese').includes('计算失误'));

  assert.throws(
    () => checkSubtype('chinese', 'procedural', '计算失误'),
    (e) => e.code === 'INVALID_SUBTYPE',
  );
  assert.equal(checkSubtype('math', 'procedural', '计算失误'), '计算失误');
  assert.equal(checkSubtype('chinese', 'factual', '部首遗忘'), '部首遗忘');
});

test('#41 录进去的错因能在详情接口读回来', async () => {
  await setup();
  try {
    const id = await makeMistake('chinese');
    const out = await diagnose(id, {
      error_category: 'conceptual',
      error_subtype: '近义词混淆',
      error_reason: '两个词的意思讲不清，只记住了形近',
    });
    assert.equal(out.status, 200);
    const res = await fetch(`${base}/api/mistakes/${id}`);
    const item = await res.json();
    assert.equal(item.error_category, 'conceptual');
    assert.equal(item.error_subtype, '近义词混淆');
    assert.equal(item.error_reason, '两个词的意思讲不清，只记住了形近');
  } finally { teardown(); }
});

test('#41 错因不上学生版打印页', async () => {
  await setup();
  try {
    const id = await makeMistake('math');
    await diagnose(id, { error_category: 'factual', error_subtype: '公式遗忘', error_reason: '公式没背' });
    const res = await fetch(`${base}/api/print?ids=${id}`);
    const body = await res.json();
    assert.equal(body.cards.length, 1);
    const keys = Object.keys(body.cards[0]);
    for (const forbidden of ['error_category', 'error_subtype', 'error_reason', 'diagnosis_note', 'student_conclusion']) {
      assert.ok(!keys.includes(forbidden), `学生版打印页不该出现 ${forbidden}`);
    }
  } finally { teardown(); }
});
