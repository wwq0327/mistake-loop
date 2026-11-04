// #43 测试先行：恢复演练必须核对图片。
// 红灯预期：scripts/backup.mjs 的 restore() 只比对数据库记录数，
// 备份里的照片全丢也照样报 ok=true。
// 背景：错题记录能对上、照片全没有，对老师来说备份等于没备份——
// 学生交上来的作业照片是这个系统里最不可再生的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { backup, restore } from '../scripts/backup.mjs';

// 建一个带 1 道题 + 2 张图（1 张旧库原图、1 张根目录原图）的临时数据目录。
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-restore-'));
  const db = openDb(join(dir, 'mistakes.db'));
  migrate(db);

  mkdirSync(join(dir, 'images', 'legacy'), { recursive: true });
  writeFileSync(join(dir, 'images', 'legacy', 'a.png'), 'x');
  writeFileSync(join(dir, 'images', 'b.png'), 'x');

  db.prepare(`INSERT INTO mistakes (source_ref, subject, prompt, image_path, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('legacy-1', 'math', '1+1', 'images/legacy/a.png', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z');
  db.prepare(`INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, ?, ?)`)
    .run('images/b.png', 'done', '2026-11-05T00:00:00Z');
  closeDb(db);

  const out = join(dir, 'backups');
  const { target, manifest } = backup({ dataDir: dir, outputDir: out });
  return {
    dir,
    target,
    manifest,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('#43 完整备份的恢复演练通过，图片口径回读与 manifest 一致', () => {
  const s = scratch();
  try {
    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, true, `恢复演练应通过，实际：${JSON.stringify(drill.mismatches)}`);
    assert.equal(drill.images.actual.referenced, 2, '被引用图片应为 2 张');
    assert.equal(drill.images.actual.legacy, 1);
    assert.equal(drill.images.actual.root, 1);
    assert.equal(drill.images.mismatches.length, 0, '图片不应有差异');
    assert.equal(drill.images.expected.referenced, 2, '回读里应带出 manifest 记录的图片口径');
  } finally { s.clean(); }
});

test('#43 备份里照片全丢：恢复演练必须判失败，并报出缺了几张', () => {
  const s = scratch();
  try {
    rmSync(join(s.target, 'images'), { recursive: true, force: true });
    mkdirSync(join(s.target, 'images'), { recursive: true });

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false, '图片全丢却报通过，恢复演练形同虚设');
    assert.ok(drill.mismatches.length > 0, '必须给出差异说明');
    assert.match(drill.mismatches.join(' '), /图片/, '差异说明要提到图片');
    assert.equal(drill.images.actual.missing, 2, '应报出 2 张图在库里有引用、备份里没有');
    assert.ok(drill.images.missing.includes('images/legacy/a.png'), '应点名缺哪张');
    assert.ok(drill.images.missing.includes('images/b.png'), '应点名缺哪张');
  } finally { s.clean(); }
});

test('#43 备份里 images/ 目录整个不见了：判失败，不当空目录放过', () => {
  const s = scratch();
  try {
    rmSync(join(s.target, 'images'), { recursive: true, force: true });

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false, '备份目录没有 images/ 必须判失败');
    assert.match(drill.mismatches.join(' '), /images/, '差异说明要点名 images 目录');
  } finally { s.clean(); }
});

test('#43 备份里少一张图（部分丢失）：判失败且只报缺的那张', () => {
  const s = scratch();
  try {
    rmSync(join(s.target, 'images', 'legacy', 'a.png'), { force: true });

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false, '少一张图也必须判失败');
    assert.equal(drill.images.actual.missing, 1);
    assert.deepEqual(drill.images.missing, ['images/legacy/a.png']);
  } finally { s.clean(); }
});

test('#43 备份里混进多余的孤儿图：口径漂移要判失败', () => {
  const s = scratch();
  try {
    writeFileSync(join(s.target, 'images', 'stray.png'), 'x');

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false, '备份内容与 manifest 不一致必须判失败');
    assert.match(drill.mismatches.join(' '), /图片/, '差异说明要提到图片');
  } finally { s.clean(); }
});

test('#43 老备份（manifest 没有图片字段）：仍要守住「库引用的图都在」这条底线', () => {
  const s = scratch();
  try {
    // 造一份 v1 时期的 manifest：只有 database 记录数，没有 images / images_detail。
    const manifestPath = join(s.target, 'manifest.json');
    const old = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ created_at: old.created_at, database: old.database }, null, 2));

    const intact = restore({ backupDir: s.target });
    assert.equal(intact.ok, true, '图片齐全的老备份应通过');
    assert.equal(intact.images.expected, null, '老备份没有可比的图片口径');

    rmSync(join(s.target, 'images', 'legacy', 'a.png'), { force: true });
    const broken = restore({ backupDir: s.target });
    assert.equal(broken.ok, false, '老备份缺图同样必须判失败');
    assert.equal(broken.images.actual.missing, 1);
  } finally { s.clean(); }
});

test('#43 数据库记录数对不上时仍判失败（原有行为不回归）', () => {
  const s = scratch();
  try {
    const manifestPath = join(s.target, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.database.mistakes = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false);
    assert.match(drill.mismatches.join(' '), /mistakes/, '应点名记录数差异');
  } finally { s.clean(); }
});

test('#43 备份目录里 images/ 是空目录且库也没有图片引用：不误报', () => {
  const s = scratch();
  try {
    rmSync(join(s.target, 'images'), { recursive: true, force: true });
    mkdirSync(join(s.target, 'images'), { recursive: true });
    const manifestPath = join(s.target, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.images = 0;
    manifest.files_total = 0;
    manifest.images_detail = { legacy: 0, derived: 0, root: 0, referenced: 0, orphan: 0, missing: 0 };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, false, '库里有 2 张图被引用，备份里一张都没有，仍应判失败');
    assert.equal(drill.images.actual.missing, 2);
  } finally { s.clean(); }
});

test('#43 恢复演练在临时目录里做，不碰原始 data/ 目录', () => {
  const s = scratch();
  try {
    assert.ok(existsSync(join(s.dir, 'images', 'legacy', 'a.png')), '原始图片必须在');
    const drill = restore({ backupDir: s.target });
    assert.equal(drill.ok, true);
    assert.ok(existsSync(join(s.dir, 'images', 'legacy', 'a.png')), '原始图片不能被动');
    assert.ok(existsSync(join(s.dir, 'images', 'b.png')), '原始图片不能被动');
  } finally { s.clean(); }
});
