// #24 测试先行：设置页依赖的三个后端能力的真实 HTTP 链路。
// 红灯预期：/api/ai/status 缺 configured，/api/ai/toggle 与 /api/backup 均 404。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-settings-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (1, ?, ?)').run('默认学生', now);
  db.prepare(`
    INSERT INTO textbook_nodes (subject, edition, grade, semester, unit_no, unit_title, lesson_title)
    VALUES ('math', '人教版', 4, 1, 1, '大数的认识', '')
  `).run();
  db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, needs_textbook_ref, created_at, updated_at)
    VALUES ('math', '设置页测试题', 'new', 0, 1, ?, ?)
  `).run(now, now);

  const app = createApp({ db, dataDir });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body, url = base } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

describe('#24 设置页后端能力', () => {
  it('GET /api/ai/status 回状态、用量、上限、失败原因、待确认数与是否已配置', async () => {
    const res = await call('/api/ai/status');
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.enabled, 'boolean');
    assert.equal(typeof res.data.configured, 'boolean', '缺 configured：未配置时开关应不可用');
    assert.equal(typeof res.data.todayUsed, 'number');
    assert.equal(typeof res.data.dailyLimit, 'number');
    assert.ok(Object.hasOwn(res.data, 'lastError'));
    assert.equal(typeof res.data.pendingDrafts, 'number');
  });

  it('状态与开关响应都不含密钥、端点、模型名、上游原文', async () => {
    const text = JSON.stringify((await call('/api/ai/status')).data)
      + JSON.stringify((await call('/api/ai/toggle', { method: 'POST', body: { enabled: true } })).data);
    for (const key of ['apiKey', 'AI_API_KEY', 'baseUrl', 'AI_BASE_URL', 'model', 'rawExcerpt', 'sk-test-secret']) {
      assert.ok(!text.includes(key), `响应泄漏 ${key}`);
    }
  });

  it('未配置时开关不能凭空开启：409 AI_NOT_CONFIGURED 且状态不变', async () => {
    const before = (await call('/api/ai/status')).data.enabled;
    const res = await call('/api/ai/toggle', { method: 'POST', body: { enabled: true } });
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.equal(res.data.error?.code, 'AI_NOT_CONFIGURED');
    assert.equal((await call('/api/ai/status')).data.enabled, before);
  });

  it('开关参数必须是布尔值，否则 400', async () => {
    const res = await call('/api/ai/toggle', { method: 'POST', body: { enabled: 'yes' } });
    assert.equal(res.status, 400);
  });

  it('已配置时开关真的切换进程内启用状态，状态接口同步变化', async () => {
    const control = { configured: true, enabled: true };
    const statusOf = () => ({
      enabled: control.enabled,
      configured: true,
      todayUsed: 0,
      dailyLimit: 30,
      lastError: null,
      pendingDrafts: 0,
    });
    const app2 = createApp({ db, dataDir, aiControl: control, aiStatus: statusOf });
    const server2 = app2.listen(0);
    await new Promise((resolve) => server2.once('listening', resolve));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    try {
      const off = await call('/api/ai/toggle', { method: 'POST', body: { enabled: false }, url: base2 });
      assert.equal(off.status, 200, JSON.stringify(off.data));
      assert.equal(off.data.enabled, false);
      assert.equal((await call('/api/ai/status', { url: base2 })).data.enabled, false);
      const on = await call('/api/ai/toggle', { method: 'POST', body: { enabled: true }, url: base2 });
      assert.equal(on.status, 200);
      assert.equal(on.data.enabled, true);
      assert.equal((await call('/api/ai/status', { url: base2 })).data.enabled, true);
      assert.ok(!JSON.stringify(on.data).includes('apiKey'), '开关响应不得带密钥');
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  it('POST /api/backup 真出一份快照并做恢复演练，回读实际计数', async () => {
    const res = await call('/api/backup', { method: 'POST' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.restore.ok, true);
    assert.equal(res.data.database.mistakes, 1);
    assert.equal(res.data.database.textbook_nodes, 1);
    assert.equal(typeof res.data.images, 'number');
    assert.ok(!String(res.data.target).includes(dataDir), '响应不应暴露本机绝对路径');
    const backupsDir = join(dataDir, 'backups');
    assert.ok(existsSync(backupsDir), '备份目录未生成');
    const dirs = readdirSync(backupsDir);
    assert.ok(dirs.some((name) => name.startsWith('backup-')), '未生成快照目录');
  });

  it('GET /health 仍回 200 且带数据库与调度状态', async () => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.db, 'ok');
    assert.ok(Object.hasOwn(res.data, 'scheduler'));
  });
});
