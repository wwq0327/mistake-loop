import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, withTransaction, closeDb } from '../src/db.mjs';

function makeDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO students (name, created_at) VALUES (?, ?)').run('默认学生', '2026-11-04T00:00:00.000Z');
  return db;
}

const COLUMNS = [
  'source_ref', 'student_id', 'textbook_node_id', 'subject', 'edition', 'grade', 'semester',
  'unit_no', 'unit_title', 'lesson_title', 'page_no', 'question_type', 'difficulty', 'prompt',
  'student_answer', 'correct_answer', 'image_path', 'source_paper', 'knowledge_tags',
  'error_category', 'error_subtype', 'error_reason', 'diagnosis_note', 'student_conclusion',
  'legacy_notes', 'geometry_spec', 'status', 'review_round', 'next_review', 'mastered_at',
  'needs_textbook_ref', 'created_at', 'updated_at',
];

function insertMistake(db, overrides = {}) {
  const row = {
    source_ref: null, subject: 'math', prompt: '题目', status: 'new', review_round: 0,
    needs_textbook_ref: 0,
    created_at: '2026-11-04T00:00:00.000Z', updated_at: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
  const values = Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null]));
  const sql = `INSERT INTO mistakes (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`;
  return db.prepare(sql).run(values);
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;

describe('数据库约束与事务', () => {
  it('D1 事务中途失败整体回滚，不留半条数据', () => {
    const db = makeDb();
    assert.throws(() => withTransaction(db, () => {
      insertMistake(db, { source_ref: 'DUP' });
      insertMistake(db, { source_ref: 'DUP' });
    }));
    assert.equal(count(db, 'mistakes'), 0);
    closeDb(db);
  });

  it('D2 非法 status / error_category / level 被 CHECK 拒绝', () => {
    const db = makeDb();
    assert.throws(() => insertMistake(db, { status: 'done' }));
    assert.throws(() => insertMistake(db, { error_category: 'lazy' }));
    const id = Number(insertMistake(db).lastInsertRowid);
    assert.throws(() => db.prepare(`
      INSERT INTO variants (mistake_id, level, prompt) VALUES (?, ?, ?)
    `).run(id, 'unknown', '变式'));
    closeDb(db);
  });

  it('D3 重复 source_ref 被 UNIQUE 拒绝', () => {
    const db = makeDb();
    insertMistake(db, { source_ref: 'M-1' });
    assert.throws(() => insertMistake(db, { source_ref: 'M-1' }));
    assert.equal(count(db, 'mistakes'), 1);
    closeDb(db);
  });

  it('D4 review_round 越界被 CHECK 拒绝', () => {
    const db = makeDb();
    assert.throws(() => insertMistake(db, { review_round: 5 }));
    assert.throws(() => insertMistake(db, { review_round: -1 }));
    closeDb(db);
  });

  it('D5 三个查询索引齐备', () => {
    const db = makeDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all().map((r) => r.name).sort();
    assert.deepEqual(names, ['idx_next_review', 'idx_node', 'idx_subject']);
    closeDb(db);
  });

  it('外键开启，父表无记录时拒绝挂靠', () => {
    const db = makeDb();
    assert.throws(() => insertMistake(db, { student_id: 999 }));
    closeDb(db);
  });
});
