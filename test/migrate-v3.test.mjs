// P17 设计提案（docs/plans/2026-11-05-p17-schema-proposal.md）确认后实施：
// migrateV3 给 variants 加学生验证三列、给 mistakes 加干净题面两列。
// 红灯预期：migrateV3 / needsV3Migration 尚不存在，import 失败。
//
// 迁移纪律沿袭 v2：纯增量列、幂等 ALTER（PRAGMA 检查后补）、不删表不改旧列；
// 启动时检测到缺列先自动 backup（server.mjs 主入口），这里只测迁移本体与检测函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate, migrateV3, needsV3Migration, closeDb } from '../src/db.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// 从现行 schema.sql 剥掉 v3 五列，得到「v2 及更早」的旧结构，用来模拟存量库。
const CURRENT_SCHEMA = readFileSync(join(here, '..', 'src', 'schema.sql'), 'utf8');
const V2_SCHEMA = CURRENT_SCHEMA
  .replace(/^\s*student_result\s+TEXT.*$/gm, '')
  .replace(/^\s*student_note\s+TEXT.*$/gm, '')
  .replace(/^\s*student_verified_at\s+TEXT.*$/gm, '')
  .replace(/^\s*clean_image_path\s+TEXT.*$/gm, '')
  .replace(/^\s*sheet_image_ok\s+INTEGER.*$/gm, '');

const V3_MISTAKE_COLS = ['clean_image_path', 'sheet_image_ok'];
const V3_VARIANT_COLS = ['student_result', 'student_note', 'student_verified_at'];

const colsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

test('新库 migrate() 一次到位：五列都在', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const c of V3_MISTAKE_COLS) assert.ok(colsOf(db, 'mistakes').includes(c), `mistakes 缺 ${c}`);
  for (const c of V3_VARIANT_COLS) assert.ok(colsOf(db, 'variants').includes(c), `variants 缺 ${c}`);
  closeDb(db);
});

test('旧库 migrateV3()：五列补齐、原数据保留、默认值正确', () => {
  const db = openDb(':memory:');
  db.exec(V2_SCHEMA);
  db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, created_at, updated_at)
    VALUES ('math', '旧题', 'reviewing', 2, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO variants (mistake_id, level, prompt, reviewed, result)
    VALUES (1, 'surface', '旧变式', 1, 'pass')
  `).run();

  assert.equal(needsV3Migration(db), true, '迁移前应报告需要 v3 迁移');
  migrateV3(db);

  for (const c of V3_MISTAKE_COLS) assert.ok(colsOf(db, 'mistakes').includes(c), `mistakes 缺 ${c}`);
  for (const c of V3_VARIANT_COLS) assert.ok(colsOf(db, 'variants').includes(c), `variants 缺 ${c}`);
  assert.equal(needsV3Migration(db), false, '迁移后不应再报告需要迁移');

  const mistake = db.prepare('SELECT prompt, clean_image_path, sheet_image_ok FROM mistakes WHERE id = 1').get();
  assert.equal(mistake.prompt, '旧题', '原数据要保留');
  assert.equal(mistake.clean_image_path, null, '净图默认为空');
  assert.equal(mistake.sheet_image_ok, 0, '上纸确认默认不放行');
  const variant = db.prepare('SELECT prompt, student_result, student_verified_at FROM variants WHERE id = 1').get();
  assert.equal(variant.prompt, '旧变式', '原数据要保留');
  assert.equal(variant.student_result, null, '存量审核不得补造学生作答');
  assert.equal(variant.student_verified_at, null, '存量审核不得补造验证时间');
  closeDb(db);
});

test('migrateV3() 幂等：连跑两次不报错、列不重复', () => {
  const db = openDb(':memory:');
  db.exec(V2_SCHEMA);
  migrateV3(db);
  migrateV3(db);
  const m = colsOf(db, 'mistakes').filter((c) => V3_MISTAKE_COLS.includes(c));
  const v = colsOf(db, 'variants').filter((c) => V3_VARIANT_COLS.includes(c));
  assert.equal(m.length, V3_MISTAKE_COLS.length);
  assert.equal(v.length, V3_VARIANT_COLS.length);
  closeDb(db);
});

test('新库直接 migrateV3()：PRAGMA 检查后跳过，不报错', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(CURRENT_SCHEMA);
  assert.equal(needsV3Migration(db), false);
  migrateV3(db);
  assert.equal(colsOf(db, 'mistakes').filter((c) => c === 'clean_image_path').length, 1);
  db.close();
});

test('student_result 只接受四档取值，脏数据进不去', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-05T00:00:00.000Z')").run();
  db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, created_at, updated_at)
    VALUES ('math', '一道题', 'correcting', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO variants (mistake_id, level, prompt, student_result)
    VALUES (1, 'surface', '变式', 'independent')
  `).run();
  assert.throws(
    () => db.prepare("INSERT INTO variants (mistake_id, level, prompt, student_result) VALUES (1, 'structure', '变式', 'pass')").run(),
    /CHECK constraint failed/,
    '学生作答档位不得混入质量审核的取值',
  );
  closeDb(db);
});
