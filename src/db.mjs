import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export function migrate(db) {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrateV2(db);
}

// v2 幂等升级：建新表 + 给已有 mistakes 补溯源列。
// 新库里 schema.sql 已含该列，PRAGMA 检查后跳过 ALTER；旧库则只加一次。
export function migrateV2(db) {
  db.exec(readFileSync(join(here, 'schema-v2.sql'), 'utf8'));
  const cols = db.prepare('PRAGMA table_info(mistakes)').all().map((r) => r.name);
  if (!cols.includes('recognition_draft_id')) {
    db.exec('ALTER TABLE mistakes ADD COLUMN recognition_draft_id INTEGER');
  }
  // recognition_jobs.manual_retries：人工重试次数（规格：人工重试最多 2 次）。
  // CREATE TABLE IF NOT EXISTS 对已有表不改结构，旧库必须靠这条 ALTER 补列。
  // 不复用 attempts：attempts 归零是重试能跑的前提，且 attempts > 0 是每日配额的判据。
  const jobCols = db.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
  if (!jobCols.includes('manual_retries')) {
    db.exec('ALTER TABLE recognition_jobs ADD COLUMN manual_retries INTEGER NOT NULL DEFAULT 0');
  }
}

// node:sqlite 没有事务包装器，本项目唯一需要手写的运行时补丁。
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已由底层终止时不再掩盖原始异常
    }
    throw err;
  }
}

export function closeDb(db) {
  if (db) db.close();
}
