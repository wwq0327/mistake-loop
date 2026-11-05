// #71 v4 迁移：ai_tasks 纯新增表，不改既有列；存量行原样保留。
// 与 v2/v3 同纪律：幂等、迁移前自动备份（server.mjs 主入口）、回滚只是 git revert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, migrateV4, needsV4Migration, closeDb } from '../src/db.mjs';

const tableExists = (db, name) => db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

test('#71 新库 migrate() 一次到位：ai_tasks 与索引都在', () => {
  // 空库（还没有任何表）不算「缺 ai_tasks」：否则全新安装会先跑一次空库备份再崩（#78 同款）。
  const blank = openDb(':memory:');
  assert.equal(needsV4Migration(blank), false, '空库应交给 migrate() 一次建到 v4');
  closeDb(blank);

  const db = openDb(':memory:');
  migrate(db);
  assert.ok(tableExists(db, 'ai_tasks'));
  assert.equal(needsV4Migration(db), false);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ai_tasks%'")
    .all().map((r) => r.name).sort();
  assert.deepEqual(indexes, ['idx_ai_tasks_status', 'idx_ai_tasks_target']);
  closeDb(db);
});

test('#71 老库（无 ai_tasks）判为需要 v4，迁移后数据原样保留', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.exec('DROP TABLE ai_tasks');
  assert.equal(needsV4Migration(db), true, '旧库要能报出缺表');

  db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, created_at, updated_at)
    VALUES ('math', '迁移前的老题', 'reviewing', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `).run();

  migrateV4(db);
  migrateV4(db); // 幂等
  assert.equal(needsV4Migration(db), false);
  assert.equal(db.prepare('SELECT prompt FROM mistakes WHERE id = 1').get().prompt, '迁移前的老题');
  closeDb(db);
});

test('#71 幂等键唯一、状态枚举受约束：脏数据进不去', () => {
  const db = openDb(':memory:');
  migrate(db);
  const insert = (idemKey, status = 'queued') => db.prepare(`
    INSERT INTO ai_tasks (kind, target_type, target_id, input_version, idem_key, status, created_at)
    VALUES ('analysis', 'mistake', 1, 'v1', ?, ?, '2026-11-05T00:00:00Z')
  `).run(idemKey, status);

  insert('analysis:mistake:1:v1');
  assert.throws(() => insert('analysis:mistake:1:v1'), /UNIQUE/, '同键不得重复建任务');
  assert.throws(() => insert('analysis:mistake:1:v2', 'bogus'), /CHECK/, '状态枚举外的值必须被拒');
  closeDb(db);
});

// 老库升级前必须先备份：ai_tasks 虽是纯新增表，但「加表」也是结构变更，
// 出事时用户手里得有升级前那份数据。空库不备份（#78 已修）。
test('#71 老库启动升级前自动备份，升级后服务可用', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'ml-v4-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });

  // 造一个「v3 时代」的库：有数据，但没有 ai_tasks。
  const seeded = openDb(join(dataDir, 'mistakes.db'));
  migrate(seeded);
  seeded.exec('DROP TABLE ai_tasks');
  seeded.prepare(`
    INSERT INTO mistakes (subject, prompt, status, created_at, updated_at)
    VALUES ('math', '升级前就有的题', 'reviewing', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
  `).run();
  closeDb(seeded);

  const env = { ...process.env, DATA_DIR: dataDir, PORT: '0' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`30 秒内没起来。stdout=${out} stderr=${err}`)), 30000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const m = out.match(/http:\/\/0\.0\.0\.0:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`启动即退出 code=${code} ${err}`)); });
    });

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);

    const backups = join(dataDir, 'backups');
    const made = existsSync(backups) ? readdirSync(backups).filter((n) => n.startsWith('backup-')) : [];
    assert.equal(made.length, 1, `升级前应生成一份备份，实际 ${made.length}`);
    assert.match(out, /v4 迁移前已自动备份/);

    const after = openDb(join(dataDir, 'mistakes.db'));
    assert.equal(after.prepare('SELECT prompt FROM mistakes WHERE id = 1').get().prompt, '升级前就有的题');
    assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_tasks'").get());
    closeDb(after);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
