// #38 图片盘点：把「磁盘上有几个文件」拆成「旧库原图 / 派生图 / 根目录原图 / 孤儿 / 缺文件」五个数。
// 背景：v2 起 data/images/ 分两层（legacy 原图 + derived 压缩派生图），
// 旧验收脚本把两层相加再跟「19 张旧库原图」比较，跨口径比较必然对不上（详见 #37）。
// 本模块只读磁盘与数据库，不写任何文件。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IMAGE_ROOT = 'images';

// 归一化成相对 dataDir 的正斜杠路径，例如 images/legacy/a.png。
function normalizePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// 分层：legacy = 旧库导入的原图；derived = 压缩派生图；root = images/ 根下的新收件原图。
export function layerOf(relPath) {
  const rel = normalizePath(relPath);
  if (rel.startsWith('images/legacy/')) return 'legacy';
  if (rel.startsWith('images/derived/')) return 'derived';
  return 'root';
}

function walk(dir, dataDir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, dataDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = normalizePath(relative(dataDir, abs));
    out.push({ abs, rel, layer: layerOf(rel), bytes: statSync(abs).size });
  }
  return out;
}

// 数据库里引用到的图片路径：错题原图 + 识别任务原图。
// v1 库在 v2 迁移前还没有 recognition_jobs 表，这里按「表在才查」处理，不让盘点把迁移流程打断。
export function referencedImagePaths(db) {
  const set = new Set();
  if (!db) return set;
  const hasTable = (name) => Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) set.add(normalizePath(value));
  };
  if (hasTable('mistakes')) {
    for (const row of db.prepare('SELECT image_path FROM mistakes WHERE image_path IS NOT NULL').all()) {
      add(row.image_path);
    }
  }
  if (hasTable('recognition_jobs')) {
    for (const row of db.prepare('SELECT image_path FROM recognition_jobs').all()) {
      add(row.image_path);
    }
  }
  return set;
}

export function indexImages({ dataDir, db }) {
  const files = walk(join(dataDir, IMAGE_ROOT), dataDir, []);
  const referenced = referencedImagePaths(db);

  // 派生图按约定与原图同名（images/<name> ↔ images/derived/<name>）：
  // 原图被引用，它的压缩派生图就算被引用；反之不成立。
  const referencedBasenames = new Set(
    [...referenced]
      .filter((p) => p.startsWith('images/') && !p.slice('images/'.length).includes('/'))
      .map((p) => p.split('/').pop()),
  );

  const onDisk = new Set(files.map((f) => f.rel));
  const orphans = [];
  const referencedOnDisk = [];
  for (const file of files) {
    const hit = referenced.has(file.rel)
      || (file.layer === 'derived' && referencedBasenames.has(file.rel.split('/').pop()));
    if (hit) referencedOnDisk.push(file.rel);
    else orphans.push(file.rel);
  }

  // 反向问题：库里有引用，磁盘上却没有（打印页会缺图）。
  const missing = [...referenced].filter((p) => !onDisk.has(p)).sort();

  const counts = { total: files.length, legacy: 0, derived: 0, root: 0 };
  for (const file of files) counts[file.layer] += 1;
  counts.referenced = referencedOnDisk.length;
  counts.orphan = orphans.length;
  counts.missing = missing.length;

  return {
    counts,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    files: files.map(({ rel, layer, bytes }) => ({ rel, layer, bytes })),
    referenced: referencedOnDisk.sort(),
    orphans: orphans.sort(),
    missing,
  };
}
