// #38 测试先行：图片孤儿盘点与归档。
// 红灯预期：src/lib/image-index.mjs 与 scripts/prune-images.mjs 尚不存在。
// 背景：真实 data/images/derived/ 有 3 个文件，数据库里没有任何引用，属于「磁盘有、库无引用」的孤儿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { indexImages } from '../src/lib/image-index.mjs';
import { pruneImages } from '../scripts/prune-images.mjs';
import { backup } from '../scripts/backup.mjs';

const NOW = new Date('2026-11-05T08:00:00Z');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-prune-'));
  const db = openDb(join(dir, 'mistakes.db'));
  migrate(db);
  const write = (rel) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x');
    return rel;
  };

  // 一张被 mistakes 引用的旧库原图
  const legacy = write('images/legacy/2026-05-24_Q3.png');
  db.prepare(`INSERT INTO mistakes (source_ref, subject, prompt, image_path, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('legacy-1', 'math', '1+1', legacy, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z');

  // 一张被识别任务引用的原图，以及它的压缩派生图（同 basename）
  const original = write('images/aaaabbbb-cccc-dddd-eeee-ffff00001111.png');
  const derived = write('images/derived/aaaabbbb-cccc-dddd-eeee-ffff00001111.png');
  db.prepare(`INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, ?, ?)`)
    .run(original, 'done', '2026-11-04T00:00:00Z');

  // 两张孤儿：一张派生图、一张根目录原图
  const orphanDerived = write('images/derived/99999999-0000-0000-0000-000000000000.png');
  const orphanRoot = write('images/88888888-0000-0000-0000-000000000000.png');

  // 一条引用了但磁盘没有的记录
  db.prepare(`INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, ?, ?)`)
    .run('images/missing-on-disk.png', 'queued', '2026-11-04T00:00:00Z');

  return {
    dir,
    db,
    clean: () => { closeDb(db); rmSync(dir, { recursive: true, force: true }); },
    paths: { legacy, original, derived, orphanDerived, orphanRoot },
  };
}

test('#38 盘点按层报告：旧库原图、派生图、根目录原图分开算', () => {
  const s = scratch();
  try {
    const index = indexImages({ dataDir: s.dir, db: s.db });
    assert.equal(index.counts.legacy, 1, '旧库原图应为 1');
    assert.equal(index.counts.derived, 2, '派生图应为 2');
    assert.equal(index.counts.root, 2, '根目录原图应为 2');
    assert.equal(index.counts.total, 5, '磁盘文件总数应为 5');
    assert.equal(index.counts.referenced, 3, '被引用文件应为 3（原图 + 派生图 + 旧库图）');
  } finally { s.clean(); }
});

test('#38 孤儿是磁盘有、库无引用；缺文件是库有引用、磁盘没有', () => {
  const s = scratch();
  try {
    const index = indexImages({ dataDir: s.dir, db: s.db });
    assert.deepEqual([...index.orphans].sort(), [s.paths.orphanDerived, s.paths.orphanRoot].sort());
    assert.deepEqual([...index.missing], ['images/missing-on-disk.png']);
    assert.ok(!index.orphans.includes(s.paths.derived), '被引用的派生图不该算孤儿');
    assert.ok(!index.orphans.includes(s.paths.legacy), '被引用的旧库原图不该算孤儿');
  } finally { s.clean(); }
});

test('#38 默认只读：盘点后磁盘文件一个不少，孤儿原地不动', () => {
  const s = scratch();
  try {
    const before = readdirSync(join(s.dir, 'images', 'derived')).length;
    const result = pruneImages({ dataDir: s.dir, db: s.db, now: NOW });
    assert.equal(result.moved.length, 0, '默认模式不应移动任何文件');
    assert.equal(result.index.orphans.length, 2, '默认模式仍应报出 2 个孤儿');
    assert.equal(readdirSync(join(s.dir, 'images', 'derived')).length, before, '派生图目录被动了');
    assert.ok(existsSync(join(s.dir, s.paths.orphanRoot)), '孤儿原图被动了');
  } finally { s.clean(); }
});

test('#38 --archive 把孤儿移入 orphans 目录，不删除、不动被引用的图片', () => {
  const s = scratch();
  try {
    const result = pruneImages({ dataDir: s.dir, db: s.db, archive: true, now: NOW });
    assert.equal(result.moved.length, 2, '应归档 2 个孤儿');
    assert.ok(!existsSync(join(s.dir, s.paths.orphanRoot)), '孤儿原图应已移走');
    assert.ok(!existsSync(join(s.dir, s.paths.orphanDerived)), '孤儿派生图应已移走');
    assert.ok(existsSync(join(s.dir, s.paths.legacy)), '被引用的旧库原图不能动');
    assert.ok(existsSync(join(s.dir, s.paths.original)), '被引用的原图不能动');
    assert.ok(existsSync(join(s.dir, s.paths.derived)), '被引用的派生图不能动');

    const orphansDir = join(s.dir, 'orphans');
    assert.ok(existsSync(orphansDir), '应建出 orphans 目录');
    const buckets = readdirSync(orphansDir);
    assert.equal(buckets.length, 1, '孤儿应按时间戳分桶');
    const bucket = join(orphansDir, buckets[0]);
    assert.equal(readdirSync(bucket).length, 2, '桶内应有 2 个文件');

    // 归档是移动不是删除：桶里的文件内容与原文件一致。
    const kept = readdirSync(bucket).map((name) => join(bucket, name));
    assert.equal(kept.length, 2);
    assert.equal(readdirSync(join(s.dir, 'images', 'derived')).length, 1, '派生图目录只剩被引用的那张');
  } finally { s.clean(); }
});

test('#38 归档不改动数据库记录数', () => {
  const s = scratch();
  try {
    const count = (t) => s.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const before = { mistakes: count('mistakes'), jobs: count('recognition_jobs') };
    pruneImages({ dataDir: s.dir, db: s.db, archive: true, now: NOW });
    assert.equal(count('mistakes'), before.mistakes, '归档不应动 mistakes');
    assert.equal(count('recognition_jobs'), before.jobs, '归档不应动 recognition_jobs');
  } finally { s.clean(); }
});

test('#38 空目录不炸：没有图片时计数为 0、孤儿为 0，缺文件照报', () => {
  const s = scratch();
  try {
    const empty = mkdtempSync(join(tmpdir(), 'ml-prune-empty-'));
    try {
      const index = indexImages({ dataDir: empty, db: s.db });
      assert.equal(index.counts.total, 0);
      assert.equal(index.counts.orphan, 0);
      // 库里引用了 3 张图（legacy 原图、任务原图、故意缺的那张），空目录里全部缺。
      assert.equal(index.missing.length, 3);
      assert.ok(index.missing.includes('images/missing-on-disk.png'));
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { s.clean(); }
});

test('#38 备份 manifest 分层记图片：有效数与磁盘总数分开写', () => {
  const s = scratch();
  try {
    const result = backup({ dataDir: s.dir, outputDir: join(s.dir, 'backups') });
    assert.equal(result.manifest.images, 3, '有效图片应是被引用的 3 张');
    assert.equal(result.manifest.files_total, 5, '磁盘文件总数应为 5');
    assert.equal(result.manifest.images_detail.legacy, 1);
    assert.equal(result.manifest.images_detail.derived, 2);
    assert.equal(result.manifest.images_detail.root, 2);
    assert.equal(result.manifest.images_detail.orphan, 2);
    assert.equal(result.manifest.images_detail.missing, 1);
  } finally { s.clean(); }
});
