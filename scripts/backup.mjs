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

// 只在临时目录恢复并核对记录数，绝不覆盖现有 data/。
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
    const mismatches = Object.entries(manifest.database).filter(([key, value]) => actual[key] !== value);
    return {
      ok: mismatches.length === 0,
      expected: manifest.database,
      actual,
      mismatches,
      restored: own ? null : restored,
    };
  } finally {
    if (own) rmSync(scratch, { recursive: true, force: true });
  }
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
    console.log(`[restore] ${result.ok ? '通过' : '失败'}：${JSON.stringify(result.actual)}`);
    if (!result.ok) process.exit(1);
  } else {
    const result = backup({ dataDir, outputDir: join(dataDir, 'backups') });
    console.log(`[backup] ${result.target}`);
    console.log(`[backup] 记录数 ${JSON.stringify(result.manifest.database)}，有效图片 ${result.manifest.images} 张（磁盘文件 ${result.manifest.files_total} 张，孤儿 ${result.manifest.images_detail.orphan} 张）`);
    const drill = restore({ backupDir: result.target });
    console.log(`[backup] 临时目录恢复演练：${drill.ok ? '通过' : `失败 ${JSON.stringify(drill.mismatches)}`}`);
    if (!drill.ok) process.exit(1);
  }
}
