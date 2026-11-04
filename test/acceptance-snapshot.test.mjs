// #39 测试先行：验收脚本复制「真实库副本」必须是一致性快照。
// 红灯预期：scripts/snapshot.mjs 尚不存在，copyDataDir 无从导入。
// 实证背景：源库 3 行时，逐个拷贝 db + wal + shm 得到的副本只读到 2 行 —— 撕裂快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { copyDataDir } from '../scripts/snapshot.mjs';

const NOW = new Date('2026-11-05T08:00:00Z');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-snapshot-'));
  const db = openDb(join(dir, 'mistakes.db'));
  migrate(db);
  const insert = (n) => db.prepare(`INSERT INTO mistakes (source_ref, subject, prompt, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?)`)
    .run(`m-${n}`, 'math', `题目 ${n}`, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z');
  insert(1);
  // 先把第 1 行落进主库文件，再写 2、3 行留在 WAL 里：主库文件从此落后于真实数据。
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  insert(2);
  insert(3);
  return { dir, db, clean: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

test('#39 一致性快照的计数必须与源库一致（WAL 未落盘时也是）', () => {
  const s = scratch();
  try {
    const source = s.db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    assert.equal(source, 3, '源库应有 3 行');

    // 旧做法的前车之鉴：主库文件此刻只有第 1 行。
    const naiveDir = mkdtempSync(join(tmpdir(), 'ml-naive-'));
    try {
      copyFileSync(join(s.dir, 'mistakes.db'), join(naiveDir, 'naive.db'));
      const naive = new DatabaseSync(join(naiveDir, 'naive.db'));
      const naiveCount = naive.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
      naive.close();
      assert.equal(naiveCount, 1, '主库文件此刻确实落后（WAL 里还有 2 行）');
    } finally { rmSync(naiveDir, { recursive: true, force: true }); }

    const snap = copyDataDir({ dataDir: s.dir, now: NOW });
    try {
      const snapDb = openDb(join(snap.dir, 'mistakes.db'));
      const snapCount = snapDb.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
      closeDb(snapDb);
      assert.equal(snapCount, source, '快照计数必须等于源库计数');
    } finally { snap.cleanup(); }
  } finally { s.clean(); }
});

test('#39 快照不往源目录写任何文件', () => {
  const s = scratch();
  try {
    const before = readdirSync(s.dir).sort();
    const snap = copyDataDir({ dataDir: s.dir, now: NOW });
    try {
      const after = readdirSync(s.dir).sort();
      assert.deepEqual(after, before, `源目录多出或少了文件：${JSON.stringify({ before, after })}`);
    } finally { snap.cleanup(); }
  } finally { s.clean(); }
});

test('#39 快照带上图片目录', () => {
  const s = scratch();
  try {
    mkdirSync(join(s.dir, 'images', 'legacy'), { recursive: true });
    writeFileSync(join(s.dir, 'images', 'legacy', 'a.png'), 'x');
    const snap = copyDataDir({ dataDir: s.dir, now: NOW });
    try {
      assert.ok(existsSync(join(snap.dir, 'images', 'legacy', 'a.png')), '快照应带上图片');
    } finally { snap.cleanup(); }
  } finally { s.clean(); }
});

test('#39 快照目录是独立临时目录，清理后不残留', () => {
  const s = scratch();
  try {
    const snap = copyDataDir({ dataDir: s.dir, now: NOW });
    assert.ok(existsSync(snap.dir), '快照目录应存在');
    const dir = snap.dir;
    snap.cleanup();
    assert.equal(existsSync(dir), false, '清理后不应残留');
  } finally { s.clean(); }
});

test('#39 快照可指定输出目录（备份演练用）', () => {
  const s = scratch();
  const out = mkdtempSync(join(tmpdir(), 'ml-snapshot-out-'));
  try {
    const snap = copyDataDir({ dataDir: s.dir, outputDir: out, now: NOW });
    assert.equal(snap.dir, out, '指定输出目录时应直接用它');
    assert.ok(existsSync(join(out, 'mistakes.db')), '输出目录里应有一致性数据库');
  } finally {
    rmSync(out, { recursive: true, force: true });
    s.clean();
  }
});
