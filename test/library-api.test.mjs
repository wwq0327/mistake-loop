// #23 测试先行：题库检索与批量补教材定位的真实 HTTP 链路。
// 红灯预期：GET /api/mistakes 忽略 textbook_node_id，批量接口 404，挂错科目不拦截。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { listenLoopback } from './helpers/server.mjs';

let dataDir;
let db;
let server;
let base;
let mathNodeId;
let chineseNodeId;
let mathA;
let mathB;
let chineseA;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-library-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (1, ?, ?)').run('默认学生', now);
  const node = db.prepare(`
    INSERT INTO textbook_nodes (subject, edition, grade, semester, unit_no, unit_title, lesson_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  mathNodeId = Number(node.run('math', '人教版', 4, 1, 1, '大数的认识', '').lastInsertRowid);
  chineseNodeId = Number(node.run('chinese', '统编版', 4, 1, 1, '自然之美', '').lastInsertRowid);
  const ins = db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, needs_textbook_ref, created_at, updated_at)
    VALUES (?, ?, 'new', 0, 1, ?, ?)
  `);
  mathA = Number(ins.run('math', '数学题甲', now, now).lastInsertRowid);
  mathB = Number(ins.run('math', '数学题乙', now, now).lastInsertRowid);
  chineseA = Number(ins.run('chinese', '语文题甲', now, now).lastInsertRowid);

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

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

const snapshot = () => db.prepare(`
  SELECT id, subject, textbook_node_id, needs_textbook_ref FROM mistakes ORDER BY id
`).all();

describe('#23 题库检索与批量补教材定位', () => {
  it('按科目/状态/待补定位筛选，total 恒等于 items.length（无手填计数）', async () => {
    const bySubject = await call('/api/mistakes?subject=math');
    assert.equal(bySubject.status, 200);
    assert.equal(bySubject.data.total, 2);
    assert.equal(bySubject.data.total, bySubject.data.items.length);
    assert.ok(bySubject.data.items.every((item) => item.subject === 'math'));
    const byStatus = await call('/api/mistakes?status=new');
    assert.equal(byStatus.data.total, 3);
    assert.equal(byStatus.data.total, byStatus.data.items.length);
    const pending = await call('/api/mistakes?needs_textbook_ref=1');
    assert.equal(pending.data.total, 3);
  });

  it('按教材单元筛选：挂节点前该单元为 0 道', async () => {
    const res = await call(`/api/mistakes?textbook_node_id=${mathNodeId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.total, 0, '未实现单元筛选时会被忽略，返回全部 3 道');
    assert.equal(res.data.total, res.data.items.length);
  });

  it('批量挂节点：挂错科目的节点整批拒绝，且数据库一行未改', async () => {
    const before = snapshot();
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathA, chineseA], textbook_node_id: mathNodeId },
    });
    assert.ok(res.status >= 400, `挂错科目应被拒绝，实际 ${res.status}`);
    assert.equal(res.data.error?.code, 'SUBJECT_MISMATCH', `错误码不对：${JSON.stringify(res.data)}`);
    assert.deepEqual(snapshot(), before, '拒绝后不允许留下半批写入');
  });

  it('批量挂节点：节点不存在 404、空 ids 400、越界 id 400', async () => {
    assert.equal((await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST', body: { ids: [mathA], textbook_node_id: 999999 },
    })).status, 404);
    assert.equal((await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST', body: { ids: [], textbook_node_id: mathNodeId },
    })).status, 400);
    assert.equal((await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST', body: { ids: [999999], textbook_node_id: mathNodeId },
    })).status, 400);
  });

  it('批量挂节点：同科目两道一次挂上，教材字段回填且待补定位清零', async () => {
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathA, mathB], textbook_node_id: mathNodeId },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.updated, 2);
    assert.equal(res.data.nodeId, mathNodeId);
    const rows = db.prepare('SELECT * FROM mistakes WHERE id IN (?, ?) ORDER BY id').all(mathA, mathB);
    for (const row of rows) {
      assert.equal(row.textbook_node_id, mathNodeId);
      assert.equal(row.needs_textbook_ref, 0);
      assert.equal(row.subject, 'math');
      assert.equal(row.unit_no, 1);
      assert.equal(row.unit_title, '大数的认识');
      assert.equal(row.edition, '人教版');
    }
  });

  it('挂完之后：单元筛选与 meta 待补定位数都实时变化', async () => {
    const unit = await call(`/api/mistakes?textbook_node_id=${mathNodeId}`);
    assert.equal(unit.data.total, 2);
    assert.equal(unit.data.total, unit.data.items.length);
    assert.ok(unit.data.items.every((item) => item.subject === 'math'));
    const meta = await call('/api/meta');
    assert.equal(meta.data.stats.awaitingTextbookRef, 1, 'meta 必须是实时聚合，不能是手填计数');
    assert.equal(meta.data.stats.total, 3);
  });

  it('重复挂同一节点幂等：updated=0，不制造多余写入', async () => {
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathA, mathB], textbook_node_id: mathNodeId },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.updated, 0);
    assert.equal(res.data.skipped, 2);
  });

  it('语文题可以挂到语文节点，不受前面数学批次影响', async () => {
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [chineseA], textbook_node_id: chineseNodeId },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.updated, 1);
    assert.equal((await call('/api/meta')).data.stats.awaitingTextbookRef, 0);
  });
});
