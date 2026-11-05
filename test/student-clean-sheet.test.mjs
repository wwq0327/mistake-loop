// #70 测试先行：学生版默认不上原卷照片，缺净图明确阻止成卷。
//
// 复现的缺口：学生版过滤了答案文字字段，但保留 image_path，题卡直接画原照片——
// 原卷若含学生作答、红笔订正或旁边几道已做的题，答案照样印给学生。
//
// 契约（设计提案已确认）：
//   学生版出图优先级 净图 > 老师确认可上纸的原图 > 不出图；
//   需图判定 = 识别草稿标了 has_figure，或题干为空（图即题）；
//   需图但没有可用净图时，该题进 blocked 明确阻止成卷，不静默印成无图题；
//   原图永远保留在教师侧详情接口，只读不删。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { listenLoopback } from './helpers/server.mjs';

// 1x1 PNG，作 data URL 上传净图用。
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-cleansheet-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-05T00:00:00.000Z')").run();
  const app = createApp({ db, dataDir, schedulerState: { running: true } });
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
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

// 一张「带作答痕迹」的原卷照片：文件真实存在，教师侧可见。
function makeMistake({ prompt = '看图列式', hasFigure = 0, withDraft = false } = {}) {
  const now = '2026-11-05T00:00:00.000Z';
  const rel = `images/fake-${Math.random().toString(36).slice(2)}.jpg`;
  writeFileSync(join(dataDir, rel), 'fake-jpeg-bytes');
  let draftId = null;
  if (withDraft) {
    draftId = Number(db.prepare(`
      INSERT INTO recognition_jobs (image_path, status, created_at) VALUES ('images/derived/x.jpg', 'done', ?)
    `).run(now).lastInsertRowid);
  }
  const info = db.prepare(`
    INSERT INTO mistakes (subject, prompt, student_answer, correct_answer, image_path, status,
      recognition_draft_id, created_at, updated_at)
    VALUES ('math', ?, '学生写的答案', '正确答案', ?, 'correcting', ?, ?, ?)
  `).run(prompt, rel, draftId, now, now);
  const id = Number(info.lastInsertRowid);
  if (withDraft) {
    db.prepare(`
      INSERT INTO recognition_drafts (job_id, seq, prompt, has_figure, status, mistake_id, created_at)
      VALUES (?, 1, '草稿题干', 1, 'committed', ?, ?)
    `).run(draftId, id, now);
  }
  return id;
}

const printOf = async (id) => {
  const res = await call(`/api/print?ids=${id}`);
  assert.equal(res.status, 200);
  return res.data;
};

test('#70 带作答痕迹的原图不默认上纸：学生版出图降级为不出图', async () => {
  const id = makeMistake();
  const sheet = await printOf(id);

  assert.equal(sheet.blocked.length, 0, '题干完整、不缺图，不阻止成卷');
  assert.equal(sheet.cards.length, 1);
  assert.equal(sheet.cards[0].image_path, null, '原图不得默认进入学生版');

  // 原图在教师侧照常可见，只读保留。
  const detail = await call(`/api/mistakes/${id}`);
  assert.ok(detail.data.image_path, '教师侧详情要保留原图');
});

test('#70 老师确认原图可上纸后才上纸，且可撤销', async () => {
  const id = makeMistake();
  const ok = await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: { confirm_original: true } });
  assert.equal(ok.status, 200, ok.text);

  const sheet = await printOf(id);
  assert.equal(sheet.cards[0].image_path, (await call(`/api/mistakes/${id}`)).data.image_path, '确认后原图上纸');

  const revoke = await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: { revoke: true } });
  assert.equal(revoke.status, 200);
  const after = await printOf(id);
  assert.equal(after.cards[0].image_path, null, '撤销后回到默认不上纸');
});

test('#70 确认过的净图优先于原图上纸', async () => {
  const id = makeMistake();
  await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: { confirm_original: true } });
  const upload = await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: { image: PNG_DATA_URL } });
  assert.equal(upload.status, 200, upload.text);
  assert.ok(upload.data.clean_image_path, '净图要落盘并回读路径');
  assert.ok(!upload.data.clean_image_path.includes('..'), '路径不得逃逸');

  const sheet = await printOf(id);
  assert.equal(sheet.cards[0].image_path, upload.data.clean_image_path, '净图优先于原图');
  assert.notEqual(sheet.cards[0].image_path, (await call(`/api/mistakes/${id}`)).data.image_path);
});

test('#70 需图而缺净图：明确阻止成卷，不静默印成无图题', async () => {
  const id = makeMistake({ prompt: '', hasFigure: 1, withDraft: true });
  const sheet = await printOf(id);

  assert.equal(sheet.cards.length, 0, '缺净图的需图题不进题卡');
  assert.equal(sheet.blocked.length, 1, '要有明确的阻止清单');
  assert.equal(sheet.blocked[0].id, id);
  assert.match(sheet.blocked[0].reason, /净图|图/, '原因要能看懂');
});

test('#70 有几何图不算缺图：需图题凭 geometry_svg 成卷', async () => {
  const id = makeMistake({ prompt: '', hasFigure: 1, withDraft: true });
  db.prepare("UPDATE mistakes SET geometry_spec = '{\"width\":100,\"height\":50,\"shapes\":[]}' WHERE id = ?").run(id);
  const sheet = await printOf(id);

  assert.equal(sheet.blocked.length, 0, '有几何图就不缺图');
  assert.equal(sheet.cards.length, 1);
  assert.ok(sheet.cards[0].geometry_svg.length > 0);
});

test('#70 上纸确认是显式教师事件：不传任何动作返回 400，路径字段不收任意文本', async () => {
  const id = makeMistake();
  const empty = await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: {} });
  assert.equal(empty.status, 400, '没有明确动作不得静默成功');

  const bad = await call(`/api/mistakes/${id}/sheet-image`, { method: 'POST', body: { clean_image_path: '../etc/passwd' } });
  assert.equal(bad.status, 400, '路径不得由调用方直接指定');
});
