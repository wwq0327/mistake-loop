// #72 测试先行：AI 错步分析与「一次一问」的支架草稿。
//
// 要守的：
//   1. 草稿给出目标能力、具体错步、作答依据、待确认点与**一个**验证问题，引用真实题干/作答。
//   2. 过程不足只给待验证假设；「粗心 / 基础差」这类空泛结论不许当结论用；
//      也不强行每题凑两个原因。
//   3. 老师记一句学生原话可以修正分析；缺关键条件停在待核对；
//      AI 不得替学生写第一人称结论（写进 mistakes.student_conclusion）。
//   4. 三科都能给示例；改动原题后旧分析失效，老师补的话不串到新版本。
//
// 红灯预期：src/ai/analysis.mjs 尚不存在。
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createTask, runTaskOnce } from '../src/ai/tasks.mjs';
import { listenLoopback } from './helpers/server.mjs';

const NOW = '2026-11-05T03:00:00.000Z';

let dataDir;
let db;
let server;
let base;
let reply;

function providerReturning(payload) {
  return {
    isEnabled: true,
    runStage: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-analysis-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(NOW);
  reply = {};
  const app = createApp({
    db,
    dataDir,
    schedulerState: { running: true },
    aiStatus: () => ({ enabled: true, configured: true }),
    aiControl: { configured: true, enabled: true },
    aiPipeline: { provider: providerReturning({}), quota: 30, now: () => NOW },
  });
  server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => { reply = {}; });

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

let seq = 0;
async function makeMistake(overrides = {}) {
  seq += 1;
  const body = {
    subject: 'math',
    prompt: `分析用题 ${seq}：3/4 与 5/6 哪个大？`,
    student_answer: '3/4',
    correct_answer: '5/6',
    ...overrides,
  };
  const out = await call('/api/mistakes', { method: 'POST', body });
  assert.equal(out.status, 201, JSON.stringify(out.data));
  return out.data.id;
}

// 跑一次分析阶段，返回该任务的草稿对象。
async function analyze(mistakeId, payload) {
  const created = createTask(db, { kind: 'analysis', targetType: 'mistake', targetId: mistakeId, now: NOW });
  if (payload !== undefined) reply = payload;
  const provider = {
    isEnabled: true,
    runStage: async () => {
      const value = reply === undefined ? {} : reply;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
  // worker 取最老的 queued，可能先跑到别的任务；一直跑到本条离开队列为止。
  for (let i = 0; i < 10; i += 1) {
    const row = db.prepare('SELECT status FROM ai_tasks WHERE id = ?').get(created.task.id);
    if (row.status !== 'queued') break;
    await runTaskOnce({ db, provider, now: () => NOW });
  }
  const task = db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(created.task.id);
  return { task, draft: task.result_json ? JSON.parse(task.result_json) : null };
}

const GOOD = {
  target_ability: '异分母分数比较（通分）',
  error_step: '通分后没有比较同分母的分子，直接按分母大小判断',
  basis: ['学生答 3/4', '原题要求比较 3/4 与 5/6'],
  uncertainties: ['是否理解通分的意义', '是否有口算失误'],
  verification_question: '把 3/4 和 5/6 通分，分母都是几？',
};

test('#72 数学示例：草稿含目标能力、错步、依据、待确认点与唯一验证问题', async () => {
  const id = await makeMistake();
  const { draft } = await analyze(id, GOOD);

  assert.equal(draft.target_ability, GOOD.target_ability);
  assert.match(draft.error_step, /通分/);
  assert.ok(draft.basis.length >= 1, '要引用真实作答或题干');
  assert.ok(draft.uncertainties.length >= 1);
  assert.equal(typeof draft.verification_question, 'string');
  assert.equal(draft.question_count, 1, '一次只问一个问题');
  assert.equal(draft.status, 'ok');
  assert.equal('student_conclusion' in draft, false, 'AI 不得生成学生结论');
});

test('#72 语文与英语示例同样成稿，不套数学模板', async () => {
  const chinese = await makeMistake({
    subject: 'chinese',
    prompt: '「他的脸像红苹果」用了什么修辞？',
    student_answer: '夸张',
    correct_answer: '比喻',
  });
  const cn = await analyze(chinese, {
    target_ability: '比喻与夸张的区分',
    error_step: '把「像」字句直接归为夸张，没有看是否在夸大事实',
    basis: ['学生答「夸张」', '题干含「像红苹果」'],
    uncertainties: ['是否知道夸张要夸大'],
    verification_question: '「脸像红苹果」有没有把事情说得更大？',
  });
  assert.equal(cn.draft.status, 'ok');
  assert.equal(cn.draft.question_count, 1);

  const english = await makeMistake({
    subject: 'english',
    prompt: 'She ___ (go) to school yesterday.',
    student_answer: 'goes',
    correct_answer: 'went',
  });
  const en = await analyze(english, {
    target_ability: '一般过去时动词形式',
    error_step: '看到 She 就用第三人称单数，忽略了 yesterday',
    basis: ['学生答 goes', '题干有 yesterday'],
    uncertainties: ['是否注意到时间状语'],
    verification_question: 'yesterday 说明动作发生在什么时候？',
  });
  assert.equal(en.draft.status, 'ok');
  assert.equal(en.draft.question_count, 1);
});

test('#72 空泛结论不算结论：粗心/基础差 降为待验证假设', async () => {
  const id = await makeMistake();
  const { draft } = await analyze(id, {
    target_ability: '异分母分数比较',
    error_step: '粗心',
    basis: [],
    uncertainties: [],
    verification_question: '这道题错在哪？',
  });

  assert.equal(draft.status, 'needs_check', '没有依据只能停待核对');
  assert.ok(draft.flags.includes('VAGUE_REASON'), '空泛结论要标记');
  assert.ok(draft.hypotheses.length >= 1, '要退成待验证假设而不是下结论');
  assert.ok(!/粗心/.test(draft.error_step), '空泛词不能留在结论位');
});

test('#72 过程不足只给假设，不硬凑两条原因', async () => {
  const id = await makeMistake({ student_answer: null, prompt: '没有作答痕迹的一道题' });
  const { draft } = await analyze(id, {
    target_ability: '分数比较',
    error_step: '看不出具体错在哪一步',
    basis: ['只有题干，没有学生作答'],
    uncertainties: ['缺学生过程'],
    verification_question: '你是怎么比较这两个分数的？',
    hypotheses: ['可能没通分', '可能看错了分子'],
  });

  assert.equal(draft.status, 'needs_check');
  assert.ok(draft.flags.includes('NO_PROCESS'));
  assert.equal(draft.definitive, false, '过程不足不得给确定结论');
  assert.ok(draft.hypotheses.length <= 2, '不强行凑原因');
});

test('#72 引用必须对得上原题：凭空引用标为待核对', async () => {
  const id = await makeMistake({ prompt: '原题：7/8 与 8/9 哪个大？', student_answer: '7/8' });
  const { draft } = await analyze(id, {
    target_ability: '分数比较',
    error_step: '没有通分',
    basis: ['学生写了 3/4', '题干是 1/2 与 1/3'],
    uncertainties: [],
    verification_question: '先通分看看？',
  });

  assert.equal(draft.status, 'needs_check');
  assert.ok(draft.flags.includes('BASIS_MISMATCH'), '引用对不上要显式标出来');
});

test('#72 老师记一句学生原话修正分析：有版本记录，不写学生结论', async () => {
  const id = await makeMistake();
  const { task, draft } = await analyze(id, GOOD);
  assert.equal(draft.teacher_quote ?? null, null);

  const before = db.prepare('SELECT student_conclusion FROM mistakes WHERE id = ?').get(id).student_conclusion;
  const out = await call(`/api/ai/tasks/${task.id}/note`, {
    method: 'POST',
    body: { student_quote: '学生说：我以为分母大的分数就大' },
  });
  assert.equal(out.status, 200, JSON.stringify(out.data));

  const revised = JSON.parse(db.prepare('SELECT result_json FROM ai_tasks WHERE id = ?').get(task.id).result_json);
  assert.equal(revised.teacher_quote, '学生说：我以为分母大的分数就大');
  assert.equal(revised.revisions.length, 1);
  assert.equal(revised.revisions[0].quote, revised.teacher_quote);
  assert.ok(revised.target_ability, '原有分析内容要保留');

  const after = db.prepare('SELECT student_conclusion FROM mistakes WHERE id = ?').get(id).student_conclusion;
  assert.equal(after, before, 'AI 与记录笔记都不得替学生写结论');
});

test('#72 改写原题后旧分析作废，老师补的话不串到新版本', async () => {
  const id = await makeMistake();
  const { task } = await analyze(id, GOOD);
  await call(`/api/ai/tasks/${task.id}/note`, { method: 'POST', body: { student_quote: '学生原话' } });

  db.prepare('UPDATE mistakes SET prompt = ?, updated_at = ? WHERE id = ?').run('改过的题干', NOW, id);
  const again = createTask(db, { kind: 'analysis', targetType: 'mistake', targetId: id, now: NOW });

  const oldRow = db.prepare('SELECT status, result_json FROM ai_tasks WHERE id = ?').get(task.id);
  assert.equal(oldRow.status, 'superseded');
  assert.equal(again.reused, false);
  assert.notEqual(again.task.id, task.id);
});

test('#72 一次一问：模型给两个问题也只留第一个，并标出来', async () => {
  const id = await makeMistake();
  const { draft } = await analyze(id, {
    ...GOOD,
    verification_question: ['通分后分母是几？', '分子怎么比？'],
  });

  assert.equal(draft.verification_question, '通分后分母是几？', '只留第一个问题');
  assert.equal(draft.question_count, 1);
  assert.ok(draft.flags.includes('MULTI_QUESTION'), '被砍掉的问题要留下痕迹');
});
