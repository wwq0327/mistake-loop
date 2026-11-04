// #4 测试先行：v2 数据层结构（两张识别表 + 溯源字段），v1 结构不得被破坏。
// 红灯预期：schema 尚未扩展，migrate 后查不到新表与新列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, closeDb } from '../src/db.mjs';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

test('迁移后必须存在 recognition_jobs 与 recognition_drafts', () => {
  const db = fresh();
  const names = tableNames(db);
  assert.ok(names.includes('recognition_jobs'), '缺少 recognition_jobs');
  assert.ok(names.includes('recognition_drafts'), '缺少 recognition_drafts');
  closeDb(db);
});

test('recognition_jobs 状态字段与审计字段齐备', () => {
  const db = fresh();
  const cols = columns(db, 'recognition_jobs');
  for (const c of ['id', 'image_path', 'status', 'provider', 'model', 'attempts', 'error_code', 'token_estimate', 'created_at', 'finished_at']) {
    assert.ok(cols.includes(c), `recognition_jobs 缺字段 ${c}`);
  }
  closeDb(db);
});

test('recognition_drafts 含切题框、置信度、草稿状态与溯源字段', () => {
  const db = fresh();
  const cols = columns(db, 'recognition_drafts');
  for (const c of ['id', 'job_id', 'seq', 'bbox', 'subject', 'prompt', 'options', 'student_answer_draft', 'correct_answer_draft', 'question_type', 'knowledge_hint', 'has_figure', 'figure_desc', 'confidence', 'uncertain', 'raw_excerpt', 'status', 'mistake_id', 'created_at', 'reviewed_at']) {
    assert.ok(cols.includes(c), `recognition_drafts 缺字段 ${c}`);
  }
  closeDb(db);
});

test('recognition_drafts 对 (job_id, seq) 有唯一约束', () => {
  const db = fresh();
  db.prepare(`INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/x.jpg','queued','2026-11-04T00:00:00Z')`).run();
  const insert = db.prepare(`INSERT INTO recognition_drafts (job_id, seq, prompt, status, created_at) VALUES (1, 1, '题一', 'pending', '2026-11-04T00:00:00Z')`);
  insert.run();
  assert.throws(() => insert.run());
  closeDb(db);
});

test('mistakes 新增 recognition_draft_id，且 v1 关键列与七张表都在', () => {
  const db = fresh();
  assert.ok(columns(db, 'mistakes').includes('recognition_draft_id'), '缺溯源字段');
  for (const c of ['id', 'prompt', 'status', 'review_round', 'next_review', 'image_path', 'student_conclusion']) {
    assert.ok(columns(db, 'mistakes').includes(c), `v1 列 ${c} 被破坏`);
  }
  for (const t of ['students', 'textbook_nodes', 'mistakes', 'variants', 'review_events', 'sessions', 'mastery_evidence']) {
    assert.ok(tableNames(db).includes(t), `v1 表 ${t} 被破坏`);
  }
  closeDb(db);
});
