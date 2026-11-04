// #39 实现：数据目录的一致性快照。
// 背景：验收脚本原先用 copyFileSync 逐个拷贝 mistakes.db / -wal / -shm 当作「真实库副本」。
// WAL 模式下这三件套不是同一时刻的状态：实测源库 3 行、副本只读到 2 行（撕裂快照），
// 而 B1 与 B10 的计数回读全都建立在这个副本上，回读数字因此不可信。
// 这里改用 VACUUM INTO：SQLite 自己保证快照一致，不需要停服，也不碰源目录。
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function vacuumInto(sourcePath, targetPath) {
  const target = targetPath.replaceAll("'", "''");
  // 优先只读打开：只读连接不会在源目录触发 WAL checkpoint，也不新建 -wal / -shm。
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${target}'`);
    } finally {
      source.close();
    }
    return;
  } catch {
    // 只读打不开（例如缺少 -shm）时退回读写打开；仍然不写源数据，只是可能触发 checkpoint。
    if (existsSync(target)) rmSync(target, { force: true });
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`VACUUM INTO '${target}'`);
    } finally {
      source.close();
    }
  }
}

// 复制一份数据目录：数据库走一致性快照，图片整目录复制。
export function copyDataDir({ dataDir, outputDir = null, now = new Date() }) {
  const dir = outputDir || mkdtempSync(join(tmpdir(), 'ml-snapshot-'));
  mkdirSync(dir, { recursive: true });

  const sourceDb = join(dataDir, 'mistakes.db');
  if (existsSync(sourceDb)) vacuumInto(sourceDb, join(dir, 'mistakes.db'));

  const images = join(dataDir, 'images');
  if (existsSync(images)) cpSync(images, join(dir, 'images'), { recursive: true });
  else mkdirSync(join(dir, 'images'), { recursive: true });

  return {
    dir,
    createdAt: now.toISOString(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
