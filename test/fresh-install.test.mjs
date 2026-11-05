// #67 迁移纪律补漏：全新安装（空的 data 目录）必须能直接启动。
//
// 现网缺口：needsV3Migration() 在空库上返回 true（表都不存在，PRAGMA 结果为空，
// 被当成「缺列」），server.mjs 于是先跑 backup()，backup 打开空库统计表行数，
// 直接 no such table: mistakes —— 全新安装第一次 `npm start` 就崩。
// 迁移前备份只对「已有数据的老库」有意义；空库应当跳过备份，由 migrate() 一次建到 v3。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, needsV3Migration, closeDb } from '../src/db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('#67 空库不算「需要 v3 迁移」：没有旧数据可备份', () => {
  const db = openDb(':memory:');
  assert.equal(needsV3Migration(db), false, '空库直接交给 migrate() 建表，不该触发迁移备份');
  migrate(db);
  assert.equal(needsV3Migration(db), false, '建表后也不该再要求迁移');
  closeDb(db);
});

test('#67 全新 data 目录能被服务真实拉起：健康检查通过且没有多余备份', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ml-fresh-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务 10 秒内没起来。stdout=${out} stderr=${err}`)), 10000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const m = out.match(/http:\/\/0\.0\.0\.0:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`服务启动即退出（code=${code}）。stdout=${out} stderr=${err}`));
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200, '全新安装的健康检查要通');
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.db, 'ok');

    // 空库没有历史数据，不做备份；备份只在真有旧数据时才发生。
    const backups = join(dataDir, 'backups');
    const made = existsSync(backups) ? readdirSync(backups).filter((n) => n.startsWith('backup-')) : [];
    assert.deepEqual(made, [], '空库不该生成迁移备份');
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
