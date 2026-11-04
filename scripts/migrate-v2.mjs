// #5 实现：把已有 v1 库无损升级到 v2 结构。
// 顺序固定：先读计数 → 先做一致性备份 → 再迁移 → 回读计数比对。
// 由 test/migration.test.mjs 测试先行定义行为。
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { backup } from './backup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const COUNT_TABLES = ['mistakes', 'variants', 'review_events', 'mastery_evidence', 'textbook_nodes'];

function readCounts(db) {
  return Object.fromEntries(COUNT_TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
}

export function migrateDataDir({ dataDir, now = new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'mistakes.db');

  if (!existsSync(dbPath)) {
    const db = openDb(dbPath);
    try {
      migrate(db);
      return { backupPath: null, before: null, after: readCounts(db) };
    } finally {
      closeDb(db);
    }
  }

  let before;
  const probe = openDb(dbPath);
  try { before = readCounts(probe); } finally { closeDb(probe); }

  const { target } = backup({ dataDir, outputDir: join(dataDir, 'backups'), now });

  const db = openDb(dbPath);
  let after;
  try {
    migrate(db); // 内含 migrateV2，幂等
    after = readCounts(db);
  } finally {
    closeDb(db);
  }

  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  if (changed.length) {
    throw new Error(`迁移后计数变化：${changed.join(', ')}；备份保留在 ${target}`);
  }
  return { backupPath: target, before, after };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
  try {
    const out = migrateDataDir({ dataDir });
    console.log(`[migrate] 备份：${out.backupPath ?? '空库，无需备份'}`);
    console.log(`[migrate] 迁移前：${JSON.stringify(out.before)}`);
    console.log(`[migrate] 迁移后：${JSON.stringify(out.after)}`);
    console.log('[migrate] 计数一致，升级完成');
  } catch (err) {
    console.error(`[migrate] 失败：${err.message}`);
    process.exit(1);
  }
}
