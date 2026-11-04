// #17 测试先行：教学法红线总回归。
// 红灯预期：src/ai/redlines.mjs 守门模块不存在，import 失败。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createJobWorker } from '../src/ai/jobs.mjs';
import { snapshot, diffRedlines, scanAiSource } from '../src/ai/redlines.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const RECOGNIZED = JSON.stringify({
  questions: [
    { seq: 1, subject_hint: 'math', prompt: '红线题 1', confidence: { prompt: 0.9 }, correct_answer_draft: '机器猜的答案' },
    { seq: 2, subject_hint: 'math', prompt: '红线题 2', confidence: { prompt: 0.9 } },
  ],
});

let dataDir, db, server, base, worker, beforeSnapshot;
let existingId;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, data, text };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-redlines-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(now);
  const info = db.prepare("INSERT INTO mistakes (subject, prompt, status, created_at, updated_at) VALUES ('math', '已存在的题', 'reviewing', ?, ?)").run(now, now);
  existingId = Number(info.lastInsertRowid);
  worker = createJobWorker({
    db,
    provider: { isEnabled: true, providerName: 'fake-local', model: 'fake', recognize: async () => RECOGNIZED },
    dataDir,
    options: { pollIntervalMs: 100000, readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }) },
  });
  const app = createApp({ db, dataDir, recognitionWorker: worker });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  beforeSnapshot = snapshot(db);
});

after(async () => {
  await worker.stop();
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AI 路径的教学法红线', () => {
  it('源码静态扫描：AI 模块无证据表/复习事件/已有错题状态的写入语句', () => {
    const violations = scanAiSource(root);
    assert.deepEqual(violations, []);
  });

  it('完整识别链路后证据表、复习事件、会话新增均为 0，已有错题状态不变', async () => {
    const upload = await call('/api/recognitions', { method: 'POST', body: { image: PNG } });
    assert.equal(upload.status, 202);
    await worker.drain();
    const detail = await call(`/api/recognitions/${upload.data.jobId}`);
    assert.equal(detail.data.drafts.length, 2);
    for (const draft of detail.data.drafts) {
      const res = await call(`/api/recognition-drafts/${draft.id}/commit`, { method: 'POST' });
      assert.equal(res.status, 201, res.text);
    }
    const afterSnapshot = snapshot(db);
    const violations = diffRedlines(beforeSnapshot, afterSnapshot);
    assert.deepEqual(violations, [], `红线被越过：${violations.join(' / ')}`);
    assert.equal(afterSnapshot.mistakes - beforeSnapshot.mistakes, 2, '确认入库数量不对');
    assert.equal(afterSnapshot.statuses.find((r) => r.id === existingId).status, 'reviewing');
    const rows = db.prepare('SELECT * FROM mistakes WHERE id != ?').all(existingId);
    assert.ok(rows.every((r) => r.student_conclusion === null));
    assert.ok(rows.every((r) => r.correct_answer === null), '机器猜的答案混入了错题');
  });

  it('student_conclusion 为空仍不许进入 correcting', async () => {
    const res = await call(`/api/mistakes/${existingId}/diagnosis`, {
      method: 'PATCH', body: { status: 'correcting' },
    });
    assert.equal(res.status, 400, `竟然放行了：${res.text}`);
    assert.equal(db.prepare('SELECT status FROM mistakes WHERE id = ?').get(existingId).status, 'reviewing');
  });

  it('学生版打印响应不含 correct_answer 与 scaffold_hint', async () => {
    const res = await call('/api/print');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('correct_answer'), '打印响应含正确答案字段');
    assert.ok(!res.text.includes('scaffold_hint'), '打印响应含引导提示字段');
  });

  it('v1 的 28 个回归测试仍全绿', () => {
    const v1Files = [
      'state-machine.test.mjs', 'db.test.mjs', 'scheduler.test.mjs',
      'api.test.mjs', 'import-legacy.test.mjs',
    ].map((name) => join(root, 'test', name));
    // 清除测试上下文，否则嵌套 node --test 会被跳过并只给一条警告。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', ...v1Files], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `${result.stdout.slice(-400)}${result.stderr.slice(-200)}`);
    assert.match(result.stdout, /# pass 28\b/, 'v1 用例数不是 28');
    assert.match(result.stdout, /# fail 0\b/, 'v1 回归有失败用例');
  });
});
