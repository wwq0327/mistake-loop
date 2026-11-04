import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { today, nowIso } from '../src/lib/dates.mjs';
import { indexImages } from '../src/lib/image-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// 图片分层的口径名，差异说明里要让人一眼看懂差在哪一层。
const LAYER_LABEL = {
  legacy: '旧库原图',
  derived: '压缩派生图',
  root: '新收件原图',
  referenced: '被引用',
  orphan: '孤儿',
  missing: '缺文件',
};

function dbCounts(path) {
  const db = new DatabaseSync(path);
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    return {
      mistakes: count('mistakes'),
      variants: count('variants'),
      review_events: count('review_events'),
      mastery_evidence: count('mastery_evidence'),
      textbook_nodes: count('textbook_nodes'),
    };
  } finally {
    db.close();
  }
}

// VACUUM INTO 出一致性快照，不需要停服；不删任何历史备份。
export function backup({ dataDir, outputDir, now = new Date() }) {
  const dbPath = join(dataDir, 'mistakes.db');
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  const stamp = `${today(now).replaceAll('-', '')}-${now.toISOString().slice(11, 19).replaceAll(':', '')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const target = join(outputDir, `backup-${stamp}`);
  mkdirSync(target, { recursive: true });

  const snapshot = join(target, 'mistakes.db');
  const source = new DatabaseSync(dbPath);
  try {
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }

  const imagesSrc = join(dataDir, 'images');
  if (existsSync(imagesSrc)) cpSync(imagesSrc, join(target, 'images'), { recursive: true });
  else mkdirSync(join(target, 'images'), { recursive: true });

  // 图片口径分层：images 是「被数据库引用的有效图片数」，files_total 是磁盘文件总数。
  // 两者不是同一个数，别再拿 files_total 去比「旧库导入 19 张」这种口径（见 #37）。
  const database = dbCounts(snapshot);
  const snapshotDb = new DatabaseSync(snapshot, { readOnly: true });
  let index;
  try {
    index = indexImages({ dataDir, db: snapshotDb });
  } finally {
    snapshotDb.close();
  }

  const manifest = {
    created_at: nowIso(now),
    database,
    images: index.counts.referenced,
    files_total: index.counts.total,
    images_detail: {
      legacy: index.counts.legacy,
      derived: index.counts.derived,
      root: index.counts.root,
      referenced: index.counts.referenced,
      orphan: index.counts.orphan,
      missing: index.counts.missing,
    },
  };
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { target, manifest };
}

// 恢复演练要核对图片，不只是记录数。
// 数据库记录数对得上 ≠ 备份可用：学生交上来的作业照片是这个系统里最不可再生的东西，
// 照片全丢的备份对老师毫无意义。核对分三层：
//   1) 底线（与 manifest 字段无关，老备份也守）：库里有引用、备份里没有 → 一定失败。
//   2) 口径（manifest 记了 images_detail 时）：分层计数与 manifest 逐项比对，挡住漂移。
//   3) 总数：磁盘文件总数与 manifest 记录一致。
function checkImages({ backupDir, manifest, db }) {
  const imagesDir = join(backupDir, 'images');
  if (!existsSync(imagesDir)) {
    return {
      ok: false,
      expected: manifest.images_detail ?? null,
      actual: null,
      missing: [],
      mismatches: ['备份目录缺少 images/ 目录：备份里的照片一张都没有'],
    };
  }

  const index = indexImages({ dataDir: backupDir, db });
  const actual = index.counts;
  const expected = manifest.images_detail ?? null;
  const mismatches = [];

  // 底线：被引用的图片必须都在备份里。
  if (index.missing.length > 0) {
    const shown = index.missing.slice(0, 3).join('、');
    const more = index.missing.length > 3 ? ` 等 ${index.missing.length} 张` : '';
    mismatches.push(`备份里缺 ${index.missing.length} 张被引用的图片：${shown}${more}`);
  }

  // 口径：manifest 记了分层数字就逐项比，挡住「备份被塞进多余文件」这类漂移。
  if (expected) {
    for (const key of ['legacy', 'derived', 'root', 'referenced', 'orphan', 'missing']) {
      if (expected[key] === undefined) continue;
      if (actual[key] !== expected[key]) {
        mismatches.push(`图片${LAYER_LABEL[key]}数不符：备份 ${actual[key]} 张，manifest 记录 ${expected[key]} 张`);
      }
    }
  }

  if (manifest.files_total !== undefined && actual.total !== manifest.files_total) {
    mismatches.push(`磁盘图片总数不符：备份 ${actual.total} 张，manifest 记录 ${manifest.files_total} 张`);
  } else if (manifest.files_total === undefined && manifest.images !== undefined && actual.referenced !== manifest.images) {
    mismatches.push(`有效图片数不符：备份 ${actual.referenced} 张，manifest 记录 ${manifest.images} 张`);
  }

  return {
    ok: mismatches.length === 0,
    expected,
    actual,
    missing: index.missing,
    mismatches,
  };
}

// 只在临时目录恢复并核对记录数与图片，绝不覆盖现有 data/。
export function restore({ backupDir, scratchDir }) {
  const own = !scratchDir;
  const scratch = scratchDir || mkdtempSync(join(tmpdir(), 'ml-restore-'));
  try {
    const snapshot = join(backupDir, 'mistakes.db');
    if (!existsSync(snapshot)) throw new Error(`备份快照不存在：${snapshot}`);
    const restored = join(scratch, 'restored.db');
    copyFileSync(snapshot, restored);
    const actual = dbCounts(restored);
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));

    const dbMismatches = Object.entries(manifest.database)
      .filter(([key, value]) => actual[key] !== value)
      .map(([key, value]) => `${key} 记录数不符：备份 ${value} 条，实际 ${actual[key]} 条`);

    // 图片核对用恢复出来的库当引用源：备份里的图必须能喂饱这个库。
    const restoredDb = new DatabaseSync(restored, { readOnly: true });
    let images;
    try {
      images = checkImages({ backupDir, manifest, db: restoredDb });
    } finally {
      restoredDb.close();
    }

    const mismatches = [...dbMismatches, ...images.mismatches];
    return {
      ok: mismatches.length === 0,
      expected: manifest.database,
      actual,
      mismatches,
      images,
      restored: own ? null : restored,
    };
  } finally {
    if (own) rmSync(scratch, { recursive: true, force: true });
  }
}

// 图片核对结果的一句话回读：让人一眼看出备份里的照片齐不齐。
function describeImages(images) {
  if (!images) return '无核对结果';
  if (!images.actual) return '备份目录里没有 images/ 目录';
  const a = images.actual;
  const parts = [
    `旧库原图 ${a.legacy} 张`,
    `派生图 ${a.derived} 张`,
    `新收件原图 ${a.root} 张`,
    `被引用 ${a.referenced} 张`,
    `孤儿 ${a.orphan} 张`,
    `缺文件 ${a.missing} 张`,
  ];
  if (images.expected === null) parts.push('manifest 无图片口径可比');
  return parts.join(' / ');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
  if (args[0] === '--restore') {
    if (!args[1]) {
      console.error('用法：node scripts/backup.mjs --restore <备份目录>');
      process.exit(1);
    }
    const result = restore({ backupDir: resolve(args[1]) });
    console.log(`[restore] ${result.ok ? '通过' : '失败'}：记录数 ${JSON.stringify(result.actual)}`);
    console.log(`[restore] 图片核对：${describeImages(result.images)}`);
    if (!result.ok) {
      for (const line of result.mismatches) console.error(`[restore] 差异：${line}`);
      process.exit(1);
    }
  } else {
    const result = backup({ dataDir, outputDir: join(dataDir, 'backups') });
    console.log(`[backup] ${result.target}`);
    console.log(`[backup] 记录数 ${JSON.stringify(result.manifest.database)}，有效图片 ${result.manifest.images} 张（磁盘文件 ${result.manifest.files_total} 张，孤儿 ${result.manifest.images_detail.orphan} 张）`);
    const drill = restore({ backupDir: result.target });
    console.log(`[backup] 临时目录恢复演练：${drill.ok ? '通过' : `失败 ${JSON.stringify(drill.mismatches)}`}`);
    console.log(`[backup] 恢复演练图片核对：${describeImages(drill.images)}`);
    if (!drill.ok) process.exit(1);
  }
}
