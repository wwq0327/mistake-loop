// #38 图片孤儿盘点与归档。
// 默认只读：只打印清单，不动任何文件。加 --archive 才把孤儿移入 data/orphans/<时间戳>/。
// 按仓库红线「废弃内容不直接删除」，归档用移动而不是 rm，随时可取回。
// 用法：
//   node scripts/prune-images.mjs                # 盘点（只读）
//   node scripts/prune-images.mjs --archive      # 盘点并归档孤儿
//   node scripts/prune-images.mjs --data-dir ./data
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { indexImages } from '../src/lib/image-index.mjs';
import { today } from '../src/lib/dates.mjs';

function bucketName(now) {
  return today(now).replaceAll('-', '');
}

// 只读打开：盘点不该在真实 data/ 下留下 -wal / -shm。
// 老版本 node:sqlite 不支持 readOnly，退回普通打开（仍然只跑 SELECT）。
export function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new DatabaseSync(dbPath);
  }
}

export function pruneImages({ dataDir, db, archive = false, now = new Date() }) {
  const index = indexImages({ dataDir, db });
  if (!archive || index.orphans.length === 0) return { index, moved: [], bucket: null };

  const bucket = join(dataDir, 'orphans', bucketName(now));
  mkdirSync(bucket, { recursive: true });
  const moved = [];
  for (const rel of index.orphans) {
    const from = join(dataDir, rel);
    if (!existsSync(from)) continue;
    // 保留层级（images/legacy/x → orphans/<桶>/legacy/x），避免同名文件互相覆盖。
    const target = join(bucket, rel.replace(/^images\//, ''));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(from, target);
    moved.push({ from: rel, to: target });
  }
  return { index, moved, bucket };
}

function formatReport(result, { dataDir }) {
  const { index, moved } = result;
  const lines = [];
  lines.push(`[图片盘点] 数据目录 ${dataDir}`);
  lines.push(`  旧库原图 images/legacy   ${index.counts.legacy} 张`);
  lines.push(`  压缩派生图 images/derived ${index.counts.derived} 张`);
  lines.push(`  新收件原图 images/根目录  ${index.counts.root} 张`);
  lines.push(`  磁盘文件合计             ${index.counts.total} 张（${index.bytes} 字节）`);
  lines.push(`  被数据库引用             ${index.counts.referenced} 张`);
  lines.push(`  孤儿（磁盘有、库无引用） ${index.counts.orphan} 张`);
  lines.push(`  缺文件（库有引用、磁盘无）${index.counts.missing} 张`);
  for (const rel of index.orphans) lines.push(`    孤儿 ${rel}`);
  for (const rel of index.missing) lines.push(`    缺文件 ${rel}`);
  if (moved.length) {
    lines.push(`  已归档 ${moved.length} 张到 ${result.bucket}`);
    for (const item of moved) lines.push(`    归档 ${item.from} → ${item.to}`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const archive = args.includes('--archive');
  const dataDirArg = args.indexOf('--data-dir');
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = dataDirArg >= 0 && args[dataDirArg + 1]
    ? resolve(args[dataDirArg + 1])
    : resolve(join(here, '..', 'data'));
  const db = openReadOnly(join(dataDir, 'mistakes.db'));
  if (!db) {
    console.error(`[图片盘点] 找不到数据库：${join(dataDir, 'mistakes.db')}`);
    process.exit(1);
  }
  try {
    const result = pruneImages({ dataDir, db, archive });
    console.log(formatReport(result, { dataDir }));
    // 归档后重新盘点：剩下的孤儿或缺文件才需要人看一眼。
    const after = indexImages({ dataDir, db });
    if (after.counts.orphan > 0 || after.counts.missing > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}
