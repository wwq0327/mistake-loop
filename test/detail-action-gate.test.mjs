// #57 测试先行：详情页的动作按钮必须按错题状态设闸门。
//
// 背景：后端 PATCH /mistakes/:id/diagnosis 只允许 new / diagnosing / correcting 三态
// （src/routes/mistakes.mjs 的 assert），但详情页的「只保存错因」与
// 「保存并进入纠错中」两个按钮原来无条件渲染——
// 一道已经在「复习中」或「已掌握」的题也摆着这两个按钮，老师一点就被后端拒掉。
//
// #52 已经在同一个文件里给「变式审核」加过闸门，这一条路径漏了：
// 闸门加一半等于没加。
//
// 白名单只写一份：服务端通过 /api/meta 下发，前端本地那份只是兜底，
// 两处必须一致——本文件末尾那条断言就是锁这个的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';
import { DIAGNOSABLE_STATUSES } from '../src/state-machine.mjs';

const dom = installDom({ location: { pathname: '/mistake/7', search: '' } });
const { mount, DIAGNOSABLE_FALLBACK } = await import('../public/js/pages/detail.js');

const BLOCK_IDS = ['detail-gate', 'detail-basics', 'detail-diagnosis', 'detail-variants', 'detail-reviews', 'detail-evidence'];
for (const id of BLOCK_IDS) {
  const section = dom.byId(id);
  const body = dom.document.createElement('div');
  body.className = 'card__body';
  section.append(body);
  dom.body.append(section);
}
dom.body.append(dom.byId('view'));

function baseItem(overrides = {}) {
  return {
    id: 7,
    subject: 'math',
    prompt: '一道题',
    status: 'diagnosing',
    // 结论一律填上：这样按钮不在就只能是因为状态闸门，
    // 而不是被「结论为空则不能进入纠错中」那条禁用规则挡住的。
    student_conclusion: '学生自己说：单位没换算',
    error_category: 'conceptual',
    error_subtype: '单位混淆',
    error_reason: '看错单位',
    review_round: 0,
    next_review: null,
    image_path: null,
    unit_title: null,
    unit_no: null,
    lesson_title: null,
    page_no: null,
    textbook_node_id: null,
    variants: [],
    review_events: [],
    sessions: [],
    mastery_evidence: [],
    ...overrides,
  };
}

function fakeApi(item) {
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method });
    if (path === '/api/meta') {
      return {
        variantRules: { math: {} },
        errorSubtypes: { math: {} },
        diagnosableStatuses: DIAGNOSABLE_STATUSES,
      };
    }
    if (path.startsWith('/api/mistakes/')) return item;
    throw new Error(`不该调这个接口：${method} ${path}`);
  };
  return { api, calls };
}

function buttonsIn(node) {
  return node.descendants().filter((n) => n.localName === 'button');
}

function findButton(label) {
  return buttonsIn(dom.body).find((b) => String(b.textContent || '').includes(label));
}

function diagnosisBlockText() {
  const section = dom.byId('detail-diagnosis');
  const body = section.descendants().find((n) => n.classList.contains('card__body'));
  return textOf(body);
}

test('#57 新录入的题给诊断按钮', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'new' }));
  await mount({ root, api });

  const advance = findButton('保存并进入纠错中');
  assert.ok(advance, '新录入的题应有「保存并进入纠错中」按钮');
  assert.equal(advance.disabled, false, '新录入的题该按钮不该置灰');
  assert.ok(findButton('只保存错因'), '新录入的题应有「只保存错因」按钮');
});

test('#57 诊断中的题给诊断按钮：v1 的接口流程走的就是这条路', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'diagnosing' }));
  await mount({ root, api });

  const advance = findButton('保存并进入纠错中');
  assert.ok(advance, '诊断中的题应有「保存并进入纠错中」按钮');
  assert.equal(advance.disabled, false);
});

test('#57 纠错中的题给诊断按钮：后端白名单含 correcting', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'correcting' }));
  await mount({ root, api });

  assert.ok(findButton('保存并进入纠错中'), '纠错中的题应有「保存并进入纠错中」按钮');
});

test('#57 复习中的题不给诊断按钮，并说清为什么', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'reviewing', review_round: 2 }));
  await mount({ root, api });

  assert.equal(findButton('保存并进入纠错中'), undefined, '复习中的题不该给「保存并进入纠错中」按钮');
  assert.equal(findButton('只保存错因'), undefined, '复习中的题不该给「只保存错因」按钮：同一个接口，同样会被拒');
  assert.match(diagnosisBlockText(), /复习中/, '诊断区要说明这道题已在复习中');
});

test('#57 已掌握的题不给诊断按钮，并说清为什么', async () => {
  const root = dom.byId('view');
  const { api } = fakeApi(baseItem({ status: 'mastered', review_round: 4 }));
  await mount({ root, api });

  assert.equal(findButton('保存并进入纠错中'), undefined, '已掌握的题不该给「保存并进入纠错中」按钮');
  assert.equal(findButton('只保存错因'), undefined, '已掌握的题不该给「只保存错因」按钮');
  assert.match(diagnosisBlockText(), /已掌握/, '诊断区要说明这道题已掌握');
});

test('#57 前端兜底白名单必须与后端的事实源一致', () => {
  // 两处各写一份必然会漂移：后端放宽了、前端还按旧的挡（或反过来）。
  assert.deepEqual(DIAGNOSABLE_FALLBACK, DIAGNOSABLE_STATUSES,
    '前端兜底白名单与 src/state-machine.mjs 的事实源不一致');
});

test('#57 服务端下发的白名单必须与事实源一致', async () => {
  const { createApp } = await import('../src/server.mjs');
  const { openDb, migrate, closeDb } = await import('../src/db.mjs');
  const db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db, dataDir: '.', schedulerState: { running: true } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/meta`);
    const data = await res.json();
    assert.deepEqual(data.diagnosableStatuses, DIAGNOSABLE_STATUSES,
      '/api/meta 下发的白名单与事实源不一致');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb(db);
  }
});

test('#57 后端这道闸门得在：复习中的题不许再记错因', async () => {
  // 前端的闸门是第一道，后端这道是第二道。两道都要在：
  // 哪天有人把前端的按钮放回去，后端还拦得住。
  const { createApp } = await import('../src/server.mjs');
  const { openDb, migrate, closeDb } = await import('../src/db.mjs');
  const db = openDb(':memory:');
  migrate(db);
  const now = '2026-11-04T00:00:00.000Z';
  const id = Number(db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, next_review, created_at, updated_at)
    VALUES ('math', '一道题', 'reviewing', 2, '2026-11-01', ?, ?)
  `).run(now, now).lastInsertRowid);

  const app = createApp({ db, dataDir: '.', schedulerState: { running: true } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mistakes/${id}/diagnosis`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error_reason: '偷偷改一下错因' }),
    });
    assert.equal(res.status, 400, '复习中的题不该还能记错因');
    const row = db.prepare('SELECT error_reason, status FROM mistakes WHERE id = ?').get(id);
    assert.equal(row.error_reason, null, '被拒的请求不得改动数据');
    assert.equal(row.status, 'reviewing', '被拒的请求不得改动状态');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb(db);
  }
});
