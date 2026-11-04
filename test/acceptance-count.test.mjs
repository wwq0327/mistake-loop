// #37 测试先行：B10 的图片口径必须分层，不能拿「磁盘文件总数」去比「旧库导入 19 张」。
// 红灯预期：scripts/acceptance-checks.mjs 尚不存在，evaluateB10 无从导入。
// 真实背景：v2 起 images/ 分 legacy 原图与 derived 派生图两层，旧口径把两层相加，
// 22 ≠ 19 于是 B10 长期挂着一个自相矛盾的 FAIL。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { indexImages } from '../src/lib/image-index.mjs';
import { evaluateB10 } from '../scripts/acceptance-checks.mjs';

// 一份「计数正确」的基线：19 题 / 6 变式 / 25 节点，旧库 28 项未动。
const GOOD_DB = { mistakes: 19, variants: 6, textbook_nodes: 25 };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-b10-'));
  const db = openDb(join(dir, 'mistakes.db'));
  migrate(db);
  const write = (rel) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x');
    return rel;
  };
  return { dir, db, write, clean: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

function scenario({ legacy = 19, derived = 0, orphan = 0 } = {}) {
  const s = scratch();
  for (let i = 0; i < legacy; i += 1) {
    const rel = s.write(`images/legacy/题${i}.png`);
    s.db.prepare(`INSERT INTO mistakes (source_ref, subject, prompt, image_path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`legacy-${i}`, 'math', '1+1', rel, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z');
  }
  // 派生图按约定与原图同名：原图被识别任务引用，派生图就算被引用，不是孤儿。
  for (let i = 0; i < derived; i += 1) {
    const original = s.write(`images/原图${i}.png`);
    s.write(`images/derived/原图${i}.png`);
    s.db.prepare(`INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, ?, ?)`)
      .run(original, 'done', '2026-11-04T00:00:00Z');
  }
  for (let i = 0; i < orphan; i += 1) {
    s.write(`images/孤儿${i}.png`);
  }
  const counts = indexImages({ dataDir: s.dir, db: s.db }).counts;
  return { ...s, counts };
}

test('#37 派生图存在不算丢数据：旧库原图 19 张就该通过', () => {
  const s = scenario({ legacy: 19, derived: 3 });
  try {
    assert.equal(s.counts.total, 25, '磁盘文件总数应为 25');
    assert.equal(s.counts.legacy, 19, '旧库原图应为 19');
    assert.notEqual(s.counts.total, 19, '旧口径正是拿总数去比 19，这里必须不同');
    const out = evaluateB10({ legacyStatusLines: 28, dbCounts: GOOD_DB, imageCounts: s.counts });
    assert.equal(out.ok, true, `分层后仍应通过，实际：${out.evidence}`);
  } finally { s.clean(); }
});

test('#37 旧库原图数量不对时必须 FAIL', () => {
  const s = scenario({ legacy: 18, derived: 3 });
  try {
    const out = evaluateB10({ legacyStatusLines: 28, dbCounts: GOOD_DB, imageCounts: s.counts });
    assert.equal(out.ok, false, '旧库原图 18 张不该通过');
  } finally { s.clean(); }
});

test('#37 有孤儿图片时必须 FAIL，不能只看总数', () => {
  const s = scenario({ legacy: 19, orphan: 2 });
  try {
    const out = evaluateB10({ legacyStatusLines: 28, dbCounts: GOOD_DB, imageCounts: s.counts });
    assert.equal(out.ok, false, '存在孤儿图片不该通过');
    assert.match(out.evidence, /孤儿/, '证据行要写出孤儿数');
  } finally { s.clean(); }
});

test('#37 缺文件时必须 FAIL（库里有引用、磁盘上没了）', () => {
  const s = scenario({ legacy: 19 });
  try {
    s.db.prepare('INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, ?, ?)')
      .run('images/早就不在了.png', 'queued', '2026-11-04T00:00:00Z');
    const counts = indexImages({ dataDir: s.dir, db: s.db }).counts;
    const out = evaluateB10({ legacyStatusLines: 28, dbCounts: GOOD_DB, imageCounts: counts });
    assert.equal(out.ok, false, '存在缺文件不该通过');
    assert.match(out.evidence, /缺文件/, '证据行要写出缺文件数');
  } finally { s.clean(); }
});

test('#37 旧库被写过时不通过（只读红线）', () => {
  const s = scenario({ legacy: 19 });
  try {
    const out = evaluateB10({ legacyStatusLines: 29, dbCounts: GOOD_DB, imageCounts: s.counts });
    assert.equal(out.ok, false, '旧库 git status 变了必须 FAIL');
  } finally { s.clean(); }
});

test('#37 数据库计数不对时不通过', () => {
  const s = scenario({ legacy: 19 });
  try {
    const out = evaluateB10({
      legacyStatusLines: 28,
      dbCounts: { mistakes: 18, variants: 6, textbook_nodes: 25 },
      imageCounts: s.counts,
    });
    assert.equal(out.ok, false, '错题数不对必须 FAIL');
  } finally { s.clean(); }
});

test('#37 证据行分层写数，不再出现「总数 22 却判定 19」的矛盾', () => {
  const s = scenario({ legacy: 19, derived: 3 });
  try {
    const out = evaluateB10({ legacyStatusLines: 28, dbCounts: GOOD_DB, imageCounts: s.counts });
    assert.match(out.evidence, /旧库原图 19 张/);
    assert.match(out.evidence, /压缩派生图 3 张/);
    assert.match(out.evidence, /孤儿 0 张/);
    assert.match(out.evidence, /缺文件 0 张/);
  } finally { s.clean(); }
});
