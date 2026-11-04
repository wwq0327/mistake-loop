// #5 测试先行：对已有 v1 库做幂等升级，且迁移前必须备份、迁移后计数不变。
// 红灯预期：scripts/migrate-v2.mjs 尚未实现，import 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrateV2, closeDb } from '../src/db.mjs';
import { restore } from '../scripts/backup.mjs';
import { migrateDataDir } from '../scripts/migrate-v2.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const V1_SCHEMA = readFileSync(join(here, '..', 'src', 'schema.sql'), 'utf8')
  .replace(/^\s*recognition_draft_id.*$/m, '');

function v1FileDb(dir) {
  const db = new DatabaseSync(join(dir, 'mistakes.db'));
  db.exec(V1_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, created_at, updated_at)
    VALUES (?, ?, 'reviewing', 1, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `);
  for (let i = 1; i <= 3; i += 1) insert.run('math', `旧题 ${i}`);
  db.close();
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-migrate-'));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('旧结构内存库升级后溯源列出现且原数据保留', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(V1_SCHEMA);
  db.prepare(`INSERT INTO mistakes (subject, prompt, status, review_round, created_at, updated_at)
              VALUES ('math','旧题','reviewing',1,'2026-05-01T00:00:00Z','2026-05-01T00:00:00Z')`).run();
  migrateV2(db);
  const cols = db.prepare('PRAGMA table_info(mistakes)').all().map((r) => r.name);
  assert.ok(cols.includes('recognition_draft_id'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 1);
  assert.equal(db.prepare("SELECT prompt FROM mistakes WHERE id=1").get().prompt, '旧题');
  db.close();
});

test('连续两次 migrateV2 不报错、列不重复', () => {
  const db = openDb(':memory:');
  db.exec(V1_SCHEMA);
  migrateV2(db);
  migrateV2(db);
  const cols = db.prepare('PRAGMA table_info(mistakes)').all().map((r) => r.name);
  assert.equal(cols.filter((c) => c === 'recognition_draft_id').length, 1);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='recognition_drafts'").get());
  closeDb(db);
});

test('迁移脚本先备份、计数不变、备份可恢复', () => {
  const s = scratch();
  try {
    v1FileDb(s.dir);
    const out = migrateDataDir({ dataDir: s.dir, now: new Date('2026-11-04T12:00:00Z') });
    assert.ok(out.backupPath, '未生成备份');
    assert.deepEqual(out.before, out.after, '迁移前后计数不一致');
    assert.equal(out.after.mistakes, 3);
    assert.ok(existsSync(join(out.backupPath, 'mistakes.db')), '备份快照未生成');
    const scratchDir = join(s.dir, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const drill = restore({ backupDir: out.backupPath, scratchDir });
    assert.equal(drill.ok, true, JSON.stringify(drill.mismatches));
    assert.equal(readdirSync(join(s.dir, 'backups')).length, 1);
  } finally {
    s.clean();
  }
});

test('空数据目录直接建新库且两表齐备', () => {
  const s = scratch();
  try {
    const out = migrateDataDir({ dataDir: s.dir, now: new Date('2026-11-04T12:00:00Z') });
    assert.equal(out.backupPath, null, '空库不应触发备份');
    const db = new DatabaseSync(join(s.dir, 'mistakes.db'));
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(names.includes('recognition_jobs'));
    assert.ok(names.includes('recognition_drafts'));
    db.close();
  } finally {
    s.clean();
  }
});
