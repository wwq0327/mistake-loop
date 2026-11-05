// #30 测试先行：教材定位写入一致性。
// 红灯预期：批量挂载不校验年级/册次；diagnosis 接口只校验节点存在、连科目都不查；
// POST 接口的 body.grade 会覆盖节点的 grade。
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

let grade3Node;   // 三年级下册 数学节点
let grade4Node;   // 四年级上册 数学节点
let chineseNode;  // 四年级上册 语文节点

let mathGrade3;   // 三下数学题
let mathGrade4;   // 四上数学题
let chineseGrade4;// 四上语文题

const now = '2026-11-04T00:00:00.000Z';

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-tb-consistency-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (1, ?, ?)').run('默认学生', now);

  const node = db.prepare(`
    INSERT INTO textbook_nodes (subject, edition, grade, semester, unit_no, unit_title, lesson_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  grade3Node = Number(node.run('math', '人教版', 3, 2, 1, '位置与方向', '').lastInsertRowid);
  grade4Node = Number(node.run('math', '人教版', 4, 1, 1, '大数的认识', '').lastInsertRowid);
  chineseNode = Number(node.run('chinese', '统编版', 4, 1, 1, '自然之美', '').lastInsertRowid);

  const ins = db.prepare(`
    INSERT INTO mistakes (subject, edition, grade, semester, prompt, status, review_round,
                          needs_textbook_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'new', 0, 1, ?, ?)
  `);
  mathGrade3 = Number(ins.run('math', '人教版', 3, 2, '三下数学题', now, now).lastInsertRowid);
  mathGrade4 = Number(ins.run('math', '人教版', 4, 1, '四上数学题', now, now).lastInsertRowid);
  chineseGrade4 = Number(ins.run('chinese', '统编版', 4, 1, '四上语文题', now, now).lastInsertRowid);

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

const row = (id) => db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
const allRows = () => db.prepare('SELECT * FROM mistakes ORDER BY id').all();

describe('#30 批量挂教材定位的年级/册次一致性', () => {
  it('三下题挂四上节点：整批拒绝，报 GRADE_MISMATCH，数据库一行未改', async () => {
    const before = allRows();
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathGrade3], textbook_node_id: grade4Node },
    });
    assert.ok(res.status >= 400, `跨年级挂载应被拒绝，实际 ${res.status}`);
    assert.equal(res.data.error?.code, 'GRADE_MISMATCH', `错误码不对：${JSON.stringify(res.data)}`);
    assert.deepEqual(allRows(), before, '拒绝后不允许留下半批写入');
  });

  it('年级相同但册次不同：同样拒绝，错误码 SEMESTER_MISMATCH', async () => {
    const node = db.prepare(`
      INSERT INTO textbook_nodes (subject, edition, grade, semester, unit_no, unit_title, lesson_title)
      VALUES ('math', '人教版', 3, 1, 1, '三上数学', '')
    `).run();
    const nodeId = Number(node.lastInsertRowid);
    const before = allRows();
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathGrade3], textbook_node_id: nodeId },
    });
    assert.ok(res.status >= 400, `跨册次挂载应被拒绝，实际 ${res.status}`);
    assert.equal(res.data.error?.code, 'SEMESTER_MISMATCH', `错误码不对：${JSON.stringify(res.data)}`);
    assert.deepEqual(allRows(), before, '拒绝后不允许留下半批写入');
  });

  it('错题没记册次（NULL）时不算冲突：允许挂载并用节点的册次回填', async () => {
    const ins = db.prepare(`
      INSERT INTO mistakes (subject, edition, grade, semester, prompt, status, review_round,
                            needs_textbook_ref, created_at, updated_at)
      VALUES ('math', '人教版', NULL, NULL, '没记册次的题', 'new', 0, 1, ?, ?)
    `);
    const unknownId = Number(ins.run(now, now).lastInsertRowid);
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [unknownId], textbook_node_id: grade4Node },
    });
    assert.equal(res.status, 200, `册次未知应允许挂载：${JSON.stringify(res.data)}`);
    const node = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(grade4Node);
    const mistake = row(unknownId);
    assert.equal(mistake.grade, node.grade, '未知年级应由节点回填');
    assert.equal(mistake.semester, node.semester, '未知册次应由节点回填');
    assert.equal(mistake.needs_textbook_ref, 0);
  });

  it('年级册次都对：挂载成功，写入的教材字段全部等于节点行', async () => {
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: { ids: [mathGrade3], textbook_node_id: grade3Node },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.updated, 1);
    const node = row(grade3Node) && db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(grade3Node);
    const mistake = row(mathGrade3);
    assert.equal(mistake.textbook_node_id, grade3Node);
    assert.equal(mistake.needs_textbook_ref, 0);
    assert.equal(mistake.edition, node.edition);
    assert.equal(mistake.grade, node.grade);
    assert.equal(mistake.semester, node.semester);
    assert.equal(mistake.unit_no, node.unit_no);
    assert.equal(mistake.unit_title, node.unit_title);
  });

  it('请求体伪造的教材字段不能覆盖节点值', async () => {
    const res = await call('/api/mistakes/batch-textbook-ref', {
      method: 'POST',
      body: {
        ids: [mathGrade4],
        textbook_node_id: grade4Node,
        grade: 99,
        semester: 2,
        unit_title: '假单元',
        edition: '假版本',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const node = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(grade4Node);
    const mistake = row(mathGrade4);
    assert.equal(mistake.grade, node.grade, '请求体的 grade 覆盖了节点');
    assert.equal(mistake.semester, node.semester, '请求体的 semester 覆盖了节点');
    assert.equal(mistake.unit_title, node.unit_title, '请求体的 unit_title 覆盖了节点');
    assert.equal(mistake.edition, node.edition, '请求体的 edition 覆盖了节点');
  });
});

describe('#30 诊断接口挂节点的科目与回填一致性', () => {
  it('语文题挂数学节点：拒绝并报 SUBJECT_MISMATCH，错题行未改', async () => {
    const before = row(chineseGrade4);
    const res = await call(`/api/mistakes/${chineseGrade4}/diagnosis`, {
      method: 'PATCH',
      body: { textbook_node_id: grade4Node },
    });
    assert.ok(res.status >= 400, `挂错科目应被拒绝，实际 ${res.status}`);
    assert.equal(res.data.error?.code, 'SUBJECT_MISMATCH', `错误码不对：${JSON.stringify(res.data)}`);
    assert.deepEqual(row(chineseGrade4), before, '拒绝后错题行未改');
  });

  it('挂对节点：教材字段从节点回填，请求体里手写的教材字段被忽略', async () => {
    const res = await call(`/api/mistakes/${mathGrade4}/diagnosis`, {
      method: 'PATCH',
      body: {
        textbook_node_id: grade4Node,
        unit_title: '假单元',
        unit_no: 88,
        grade: 1,
        semester: 2,
        edition: '假版本',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const node = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(grade4Node);
    const mistake = row(mathGrade4);
    assert.equal(mistake.textbook_node_id, grade4Node);
    assert.equal(mistake.unit_no, node.unit_no);
    assert.equal(mistake.unit_title, node.unit_title);
    assert.equal(mistake.grade, node.grade);
    assert.equal(mistake.semester, node.semester);
    assert.equal(mistake.edition, node.edition);
    assert.equal(mistake.needs_textbook_ref, 0);
  });

  it('单元级节点（lesson_title 为空）：挂载后 lesson_title 保持空字符串而非 null', async () => {
    const node = db.prepare('SELECT lesson_title FROM textbook_nodes WHERE id = ?').get(grade4Node);
    assert.equal(node.lesson_title, '', '测试前提：节点课题为空');
    const mistake = row(mathGrade4);
    assert.equal(mistake.lesson_title, '', `课题不应写成 null：${JSON.stringify(mistake.lesson_title)}`);
  });
});

describe('#30 新建错题时教材字段以节点为准', () => {
  it('POST 带节点与伪造教材字段：落库的教材字段全部等于节点行', async () => {
    const res = await call('/api/mistakes', {
      method: 'POST',
      body: {
        subject: 'chinese',
        prompt: '一道新的语文题',
        textbook_node_id: chineseNode,
        grade: 1,
        semester: 2,
        edition: '假版本',
        unit_no: 88,
        unit_title: '假单元',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const node = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(chineseNode);
    const mistake = row(res.data.id);
    assert.equal(mistake.textbook_node_id, chineseNode);
    assert.equal(mistake.grade, node.grade, '请求体的 grade 覆盖了节点');
    assert.equal(mistake.semester, node.semester, '请求体的 semester 覆盖了节点');
    assert.equal(mistake.edition, node.edition, '请求体的 edition 覆盖了节点');
    assert.equal(mistake.unit_no, node.unit_no, '请求体的 unit_no 覆盖了节点');
    assert.equal(mistake.unit_title, node.unit_title, '请求体的 unit_title 覆盖了节点');
  });
});
