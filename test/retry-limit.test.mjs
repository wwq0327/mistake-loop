// #49 测试先行：人工重试最多 2 次。
// 红灯预期：POST /api/recognitions/:id/retry 现在可以无限点，
// 每次都会再走一遍 provider，消耗调用额度；规格第 86 行写的「最多 2 次」没落地。
// 依据：docs/requirements/AI-vision-spec.md 第 86 行——
//   「状态机（job）：queued → running → done | partial | failed；
//     failed → queued（人工重试，最多 2 次）」
//
// 本文件只测「次数上限」这一件事；重试入口本身在 test/ui-inbox-retry.test.mjs（#48）。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir, db, server, base;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON 按空对象 */ }
  return { status: response.status, data, text };
}

// 造一个失败任务：status='failed'，可以直接点重试。
// id 由库自增，必须回读真实 id——用外部计数器拼出来的 id 会打到不存在的任务上。
let seq = 0;
function makeFailedJob() {
  seq += 1;
  const info = db.prepare(
    "INSERT INTO recognition_jobs (image_path, status, attempts, error_code, created_at, finished_at) VALUES (?, 'failed', 2, 'UPSTREAM_TIMEOUT', '2026-11-05T00:00:00.000Z', '2026-11-05T00:01:00.000Z')",
  ).run(`images/failed-${seq}.png`);
  return Number(info.lastInsertRowid);
}

function retriesOf(id) {
  const row = db.prepare('SELECT * FROM recognition_jobs WHERE id = ?').get(id);
  return row ? row.manual_retries : null;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-retry-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const app = createApp({ db, dataDir });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#49 人工重试上限：最多 2 次', () => {
  it('库里有 manual_retries 列，默认 0', () => {
    const cols = db.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
    assert.ok(cols.includes('manual_retries'), `recognition_jobs 没有 manual_retries 列，现有列：${cols.join(', ')}`);
    const row = db.prepare('SELECT manual_retries FROM recognition_jobs LIMIT 1').get();
    assert.equal(row?.manual_retries ?? 0, 0, '新建任务的人工重试次数应为 0');
  });

  it('第一次重试成功，计数变 1', async () => {
    const id = makeFailedJob();
    const res = await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 200, `实际 ${res.status}: ${res.text}`);
    assert.equal(res.data.status, 'queued');
    assert.equal(retriesOf(id), 1, '重试一次应记 1 次');
  });

  it('第二次重试成功，计数变 2', async () => {
    const id = makeFailedJob();
    await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    db.prepare("UPDATE recognition_jobs SET status = 'failed' WHERE id = ?").run(id);
    const res = await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 200, `实际 ${res.status}: ${res.text}`);
    assert.equal(retriesOf(id), 2, '重试两次应记 2 次');
  });

  it('第三次重试被拒：409，并且不再排队', async () => {
    const id = makeFailedJob();
    await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    db.prepare("UPDATE recognition_jobs SET status = 'failed' WHERE id = ?").run(id);
    await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    db.prepare("UPDATE recognition_jobs SET status = 'failed' WHERE id = ?").run(id);

    const res = await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    assert.equal(res.status, 409, `超限应返回 409，实际 ${res.status}: ${res.text}`);
    assert.match(res.text, /2\s*次/, '错误信息要写明上限是几次，不能只给个状态码');
    assert.equal(retriesOf(id), 2, '被拒的重试不应计数');
    const row = db.prepare('SELECT status FROM recognition_jobs WHERE id = ?').get(id);
    assert.equal(row.status, 'failed', '被拒的重试不应把任务排回队列');
  });

  it('超限是按任务算的，不是全局的：一个任务用满不影响另一个', async () => {
    const a = makeFailedJob();
    const b = makeFailedJob();
    for (let i = 0; i < 3; i += 1) {
      await call(`/api/recognitions/${a}/retry`, { method: 'POST' });
      db.prepare("UPDATE recognition_jobs SET status = 'failed' WHERE id = ?").run(a);
    }
    const denied = await call(`/api/recognitions/${a}/retry`, { method: 'POST' });
    assert.equal(denied.status, 409);

    const ok = await call(`/api/recognitions/${b}/retry`, { method: 'POST' });
    assert.equal(ok.status, 200, '另一个任务的第一���重试不该被牵连');
    assert.equal(retriesOf(b), 1);
  });

  it('任务详情与列表都回读得到 manual_retries，前端才能据此置灰', async () => {
    const id = makeFailedJob();
    await call(`/api/recognitions/${id}/retry`, { method: 'POST' });
    const detail = await call(`/api/recognitions/${id}`);
    assert.equal(detail.data.job.manual_retries, 1, '详情要回读 manual_retries');
    const list = await call('/api/recognitions');
    const item = list.data.items.find((x) => x.id === id);
    assert.equal(item.manual_retries, 1, '列表也要回读 manual_retries');
  });
});

describe('#49 迁移幂等', () => {
  it('对已有 recognition_jobs 表再跑一次迁移，不报错、不重复加列', () => {
    const beforeCols = db.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
    migrate(db);
    migrate(db);
    const afterCols = db.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
    assert.deepEqual(afterCols, beforeCols, '重复迁移不应改变列集合');
    assert.equal(afterCols.filter((c) => c === 'manual_retries').length, 1);
  });

  it('旧库（有 recognition_jobs 表但没 manual_retries 列）迁移后补上，且已有数据不丢', () => {
    // 造一个「v2 之前」的库：有 recognition_jobs 表、没有 manual_retries 列。
    const legacyPath = join(dataDir, 'legacy.db');
    const legacy = openDb(legacyPath);
    legacy.exec(`
      CREATE TABLE recognition_jobs (
        id INTEGER PRIMARY KEY, image_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', provider TEXT, model TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, token_estimate INTEGER,
        created_at TEXT NOT NULL, finished_at TEXT
      );
      INSERT INTO recognition_jobs (image_path, status, attempts, created_at)
        VALUES ('images/old.png', 'failed', 3, '2026-11-01T00:00:00.000Z');
    `);
    const legacyCols = legacy.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
    assert.ok(!legacyCols.includes('manual_retries'), '前置条件：旧库不该有这列');

    migrate(legacy);

    const cols = legacy.prepare('PRAGMA table_info(recognition_jobs)').all().map((r) => r.name);
    assert.ok(cols.includes('manual_retries'), '迁移后应有 manual_retries 列');
    const row = legacy.prepare('SELECT * FROM recognition_jobs WHERE image_path = ?').get('images/old.png');
    assert.ok(row, '旧数据丢了');
    assert.equal(row.status, 'failed', '旧状态被改动了');
    assert.equal(row.attempts, 3, '旧 attempts 被改动了');
    assert.equal(row.manual_retries, 0, '旧任务的人工重试次数应为 0');
    closeDb(legacy);
  });
});
