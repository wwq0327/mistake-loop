// #54 测试先行：学生版打印卡片要有字段白名单，不能只有黑名单。
// 红灯预期：现在后端 GET /api/print 靠「构造时挑字段」隐式控制，
// 没有任何断言说「卡片字段恰好是这几个」——只要新加的字段不在黑名单上，
// 就能悄悄上学生卷（实测：加 question_type，336 例全绿放行）。
// 黑名单只能拦住「已经想到的字段」；白名单才能拦住「没想到的字段」。
//
// 依据：AGENTS.md 红线「学生版打印永不返回答案与引导提示」；
// PRD F07「学生版永不出现答案与引导提示」；B7 验收项。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { STUDENT_CARD_FIELDS, STUDENT_VARIANT_FIELDS } from '../src/routes/print.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-print-wl-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const now = '2026-11-05T00:00:00.000Z';
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(now);
  const info = db.prepare(
    "INSERT INTO mistakes (subject, prompt, status, student_answer, correct_answer, error_reason, diagnosis_note, student_conclusion, unit_title, created_at, updated_at) VALUES ('math', '一道题', 'reviewing', '我的答案', '正确答案', '错因说明', '诊断记录', '学生结论', '第一单元', ?, ?)",
  ).run(now, now);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO variants (mistake_id, level, prompt, correct_answer, scaffold_hint, reviewed, result) VALUES (?, 'surface', '变式题干', '变式答案', '引导提示', 1, 'pass')",
  ).run(id);
  const app = createApp({ db, dataDir });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

function teardown() {
  server.close();
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
}

async function call(path) {
  const res = await fetch(base + path);
  return { status: res.status, data: await res.json() };
}

test('#54 学生版卡片的字段集合恰好等于白名单：多一个都不行', async () => {
  await setup();
  try {
    const out = await call('/api/print');
    assert.equal(out.status, 200);
    const card = out.data.cards[0];
    assert.ok(card, '应有一张卡片');
    assert.deepEqual(
      Object.keys(card).sort(),
      [...STUDENT_CARD_FIELDS].sort(),
      `学生版卡片的字段集合与白名单不一致：多了或少了字段`,
    );
  } finally { teardown(); }
});

test('#54 变式子对象也只保留层级与题干', async () => {
  await setup();
  try {
    const out = await call('/api/print');
    const variant = out.data.cards[0].variants[0];
    assert.ok(variant, '应有一条已审核的变式');
    assert.deepEqual(
      Object.keys(variant).sort(),
      [...STUDENT_VARIANT_FIELDS].sort(),
      '变式只应有层级与题干两个字段',
    );
  } finally { teardown(); }
});

test('#54 前后端两份白名单要对得上，不能各写各的', async () => {
  const frontend = await import('../public/js/pages/print.js');
  // 后端多出的字段前端不认 → 前端会静默丢掉，白费力气。
  const backendOnly = STUDENT_CARD_FIELDS.filter(
    (key) => !frontend.STUDENT_FIELDS.includes(key) && key !== 'variants',
  );
  assert.deepEqual(backendOnly, [], `后端多出的字段前端不认：${backendOnly.join('、')}`);
  // 前端独有的字段后端没有 → 前端拿不到值。
  // 目前只有 subject_label：它由前端自己的 SUBJECT_LABEL 映射，不来自后端。
  const frontendOnly = frontend.STUDENT_FIELDS.filter((key) => !STUDENT_CARD_FIELDS.includes(key));
  assert.deepEqual(frontendOnly, ['subject_label'], `前端独有的字段应只有 subject_label，实际：${frontendOnly.join('、')}`);
});

test('#54 白名单里不能有答案、错因、诊断与引导提示', async () => {
  for (const key of STUDENT_CARD_FIELDS) {
    assert.ok(
      !['correct_answer', 'student_answer', 'error_reason', 'error_category', 'error_subtype',
        'diagnosis_note', 'student_conclusion', 'scaffold_hint', 'mastery_evidence', 'status',
        'textbook_node_id', 'student_id', 'source_paper', 'legacy_notes', 'question_type',
      ].includes(key),
      `白名单里不该有 ${key}`,
    );
  }
});

test('#54 学生卷上不出现任何教师侧内容', async () => {
  await setup();
  try {
    const res = await fetch(base + '/api/print');
    const text = await res.text();
    for (const secret of ['我的答案', '正确答案', '错因说明', '诊断记录', '学生结论', '变式答案', '引导提示']) {
      assert.ok(!text.includes(secret), `学生卷泄漏了内容：${secret}`);
    }
  } finally { teardown(); }
});

test('#54 白名单本身是稳定的事实源：改它要同时改测试', () => {
  // 白名单导出成常量，是为了让「哪些字段能上学生卷」有一处可查的答案。
  assert.ok(Array.isArray(STUDENT_CARD_FIELDS), '白名单必须是数组');
  assert.ok(STUDENT_CARD_FIELDS.length > 0, '白名单不能为空');
  assert.equal(new Set(STUDENT_CARD_FIELDS).size, STUDENT_CARD_FIELDS.length, '白名单里有重复项');
  for (const key of ['id', 'prompt', 'variants']) {
    assert.ok(STUDENT_CARD_FIELDS.includes(key), `白名单漏了必需字段 ${key}`);
  }
});
