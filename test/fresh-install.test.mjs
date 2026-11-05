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
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, needsV3Migration, closeDb } from '../src/db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 子进程不是测试运行器：带着 NODE_TEST_CONTEXT 启动会进入测试上下文，
// 表现为子进程既不打印也不退出（全量并行跑时必现）。
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

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
    env: { ...cleanEnv(), DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务 30 秒内没起来。stdout=${out} stderr=${err}`)), 30000);
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

// 端口被占用时必须说人话：以前 listen 回调里读 server.address().port，
// 失败时 address() 是 null，直接 TypeError: Cannot read properties of null，
// 真正的 EADDRINUSE 被埋掉，用户只看到一段栈。
test('#78 端口被占用：明确退出并说清楚是端口占用，不抛 TypeError', async () => {
  // 占位要用和 app.listen(port) 相同的通配族（默认 ::）。
  // 只占 0.0.0.0 在 macOS 上允许 IPv6 通配再绑同一端口，冲突就复现不出来。
  const blocker = createServer();
  // 占位必须和 app.listen(port) 的默认通配族一致，故意不传 host。
  await new Promise((resolve) => blocker.listen(0, resolve)); // allow-default-listen：对照样本，需默认通配族
  const port = blocker.address().port;

  const dataDir = mkdtempSync(join(tmpdir(), 'ml-port-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...cleanEnv(), DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });

  try {
    const code = await new Promise((resolve) => {
      // 全量并行跑时子进程启动会到 8s 上下（24 个测试文件同时 spawn），留足余量。
      const timer = setTimeout(() => resolve('timeout'), 30000);
      child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.notEqual(code, 'timeout', `端口冲突时进程应当退出。stdout=${out} stderr=${err}`);
    assert.notEqual(code, 0, '端口冲突不是正常退出');
    assert.ok(!/TypeError/.test(err), `不该以 TypeError 收场：${err}`);
    assert.ok(/端口.*占用|EADDRINUSE/.test(out + err), `要说明是端口被占用：${out}${err}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => blocker.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
