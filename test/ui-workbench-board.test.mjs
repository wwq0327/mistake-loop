// #61 测试先行：工作台改为五态闭环看板。
//
// 背景：工作台过去是「四个数字 + 今日复习列表」，看不出「一道题走到哪一步、
// 接下来该做什么」。方案 B 把它改成五态闭环看板：待诊断 → 诊断中 → 纠错中
// → 复习中 → 已掌握，按真实服务端 status 唯一归列。
//
// 这份测试盯住的都是「看板容易骗人的地方」：
//   - 计数说 3、实际画了 5 张卡（计数与筛选范围脱节）
//   - 加载中/失败被当成 0（老师以为没有题，其实是没读到）
//   - 快速切学科时旧请求回来把新结果盖掉
//   - 题卡只靠颜色表意、点不进去
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDom, textOf } from './helpers/dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const STAGES = [
  { status: 'new', label: '待诊断' },
  { status: 'diagnosing', label: '诊断中' },
  { status: 'correcting', label: '纠错中' },
  { status: 'reviewing', label: '复习中' },
  { status: 'mastered', label: '已掌握' },
];

function makeItem(overrides = {}) {
  return {
    id: 1,
    subject: 'math',
    prompt: '一道题',
    status: 'new',
    unit_title: null,
    unit_no: null,
    lesson_title: null,
    page_no: null,
    textbook_node_id: null,
    review_round: 0,
    next_review: null,
    needs_textbook_ref: 0,
    ...overrides,
  };
}

/** 按 status 唯一归列（服务端就是这个语义，测试数据也照它来）。 */
function bucketBy(items) {
  const buckets = new Map(STAGES.map((s) => [s.status, []]));
  for (const item of items) {
    if (buckets.has(item.status)) buckets.get(item.status).push(item);
  }
  return buckets;
}

function makeApi(overrides = {}) {
  const state = {
    mistakes: overrides.mistakes ?? [],
    reviews: overrides.reviews ?? { date: '2026-11-05', total: 0, items: [] },
    meta: overrides.meta ?? { stats: { total: 0, byStatus: {}, bySubject: {} }, pendingVariants: [] },
    failMistakes: overrides.failMistakes ?? false,
    delay: overrides.delay ?? 0,
    calls: [],
  };

  const api = async (path) => {
    state.calls.push(path);
    if (path.startsWith('/api/mistakes')) {
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (state.failMistakes) {
        const error = new Error('看板数据读不到');
        error.status = 500;
        error.code = 'HTTP_ERROR';
        throw error;
      }
      const url = new URL(path, 'http://board.test');
      const subject = url.searchParams.get('subject');
      const items = subject ? state.mistakes.filter((m) => m.subject === subject) : state.mistakes;
      return { total: items.length, items };
    }
    if (path === '/api/reviews/today') return state.reviews;
    if (path === '/api/meta') return state.meta;
    throw new Error(`不该调这个接口：${path}`);
  };
  return { api, state };
}

/** 装好看板容器。stage 用于切换桌面/手机两种呈现。 */
function setupDom({ mobile = false } = {}) {
  const dom = installDom({ ids: ['workbench-board'] });
  dom.body.append(dom.byId('workbench-board'));
  globalThis.matchMedia = (query) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  return dom;
}

const { mountBoard } = await import('../public/js/pages/board.js');

function columnsOf(root) {
  return root.querySelectorAll('.board__col');
}

function cardsIn(root, status) {
  return root.querySelectorAll(`.board__col[data-status="${status}"] .board__card`);
}

function countTextOf(root, status) {
  const node = root.querySelector(`.board__col[data-status="${status}"] .board__count`);
  return node ? node.textContent.trim() : null;
}

test('#61 桌面并排五列，顺序按状态机走', async () => {
  const dom = setupDom({ mobile: false });
  const { api } = makeApi({ mistakes: [makeItem({ id: 1, status: 'new' })] });
  await mountBoard({ root: dom.byId('workbench-board'), api });

  const columns = columnsOf(dom.byId('workbench-board'));
  assert.equal(columns.length, 5);
  assert.deepEqual(columns.map((c) => c.getAttribute('data-status')), STAGES.map((s) => s.status));
});

test('#61 一道题只出现在一列里，列头数量与卡片数对得上', async () => {
  const dom = setupDom();
  const items = [
    makeItem({ id: 1, status: 'new' }),
    makeItem({ id: 2, status: 'new' }),
    makeItem({ id: 3, status: 'diagnosing' }),
    makeItem({ id: 4, status: 'reviewing' }),
    makeItem({ id: 5, status: 'mastered' }),
  ];
  const { api } = makeApi({ mistakes: items });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const buckets = bucketBy(items);
  for (const { status } of STAGES) {
    const cards = cardsIn(root, status);
    assert.equal(cards.length, buckets.get(status).length, `${status} 列的卡片数不对`);
    assert.equal(countTextOf(root, status), String(buckets.get(status).length), `${status} 列的数量不对`);
  }

  // 全板合计 = 全部题数，一道题不许在两列里各露一次。
  const all = root.querySelectorAll('.board__card');
  assert.equal(all.length, items.length);
  const ids = all.map((card) => card.getAttribute('data-mistake-id'));
  assert.equal(new Set(ids).size, items.length);
});

test('#61 列头写的是中文状态名，不靠颜色单独表意', async () => {
  const dom = setupDom();
  const { api } = makeApi({ mistakes: [] });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  for (const { status, label } of STAGES) {
    const column = root.querySelector(`.board__col[data-status="${status}"]`);
    assert.ok(column, `缺 ${status} 列`);
    assert.ok(textOf(column).includes(label), `${status} 列没有文字「${label}」`);
  }
});

test('#61 学科筛选：切到数学后只剩数学题，计数同步变', async () => {
  const dom = setupDom();
  const items = [
    makeItem({ id: 1, subject: 'math', status: 'new' }),
    makeItem({ id: 2, subject: 'chinese', status: 'new' }),
    makeItem({ id: 3, subject: 'math', status: 'reviewing' }),
  ];
  const { api } = makeApi({ mistakes: items });
  const root = dom.byId('workbench-board');
  const board = await mountBoard({ root, api });

  assert.equal(cardsIn(root, 'new').length, 2);
  await board.setSubject('math');

  assert.equal(cardsIn(root, 'new').length, 1);
  assert.equal(countTextOf(root, 'new'), '1');
  assert.equal(cardsIn(root, 'reviewing').length, 1);
  // 语文那道不能还在板上。
  const ids = root.querySelectorAll('.board__card').map((c) => c.getAttribute('data-mistake-id'));
  assert.deepEqual(ids.sort(), ['1', '3']);
});

test('#61 学科筛选提供全部/数学/语文/英语四档', async () => {
  const dom = setupDom();
  const { api } = makeApi({ mistakes: [] });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const chips = root.querySelectorAll('[data-subject]');
  const subjects = chips.map((chip) => chip.getAttribute('data-subject'));
  assert.deepEqual(subjects, ['all', 'math', 'chinese', 'english']);
});

test('#61 复习列区分到期与未到期：到期的写清逾期几天，没到期的写下次复习日', async () => {
  const dom = setupDom();
  const items = [
    makeItem({ id: 10, status: 'reviewing', next_review: '2026-11-01' }),
    makeItem({ id: 11, status: 'reviewing', next_review: '2026-11-20' }),
  ];
  const reviews = {
    date: '2026-11-05',
    total: 1,
    items: [{ id: 10, next_review: '2026-11-01', overdue_days: 4 }],
  };
  const { api } = makeApi({ mistakes: items, reviews });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const overdueCard = root.querySelector('.board__card[data-mistake-id="10"]');
  const upcomingCard = root.querySelector('.board__card[data-mistake-id="11"]');
  assert.ok(textOf(overdueCard).includes('逾期 4 天'), '到期的题没有写清逾期天数');
  assert.ok(textOf(upcomingCard).includes('2026-11-20'), '未到期的题没有写下次复习日');
});

test('#61 复习列里到期的排在未到期的前面', async () => {
  const dom = setupDom();
  const items = [
    makeItem({ id: 21, status: 'reviewing', next_review: '2026-11-20' }),
    makeItem({ id: 20, status: 'reviewing', next_review: '2026-11-02' }),
  ];
  const reviews = {
    date: '2026-11-05',
    total: 1,
    items: [{ id: 20, next_review: '2026-11-02', overdue_days: 3 }],
  };
  const { api } = makeApi({ mistakes: items, reviews });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const ids = cardsIn(root, 'reviewing').map((c) => c.getAttribute('data-mistake-id'));
  assert.deepEqual(ids, ['20', '21']);
});

test('#61 加载中不说「零题」', async () => {
  const dom = setupDom();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = async (path) => {
    if (path.startsWith('/api/mistakes')) {
      await gate;
      return { total: 0, items: [] };
    }
    if (path === '/api/reviews/today') return { date: '2026-11-05', total: 0, items: [] };
    if (path === '/api/meta') return { stats: {}, pendingVariants: [] };
    throw new Error('不该调这个接口');
  };
  const root = dom.byId('workbench-board');
  const pending = mountBoard({ root, api });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const count = root.querySelector('.board__col[data-status="new"] .board__count');
  assert.notEqual(count.textContent.trim(), '0', '加载中就把列头写成 0');
  assert.ok(textOf(root).includes('加载'), '加载中没有提示');

  release();
  await pending;
});

test('#61 读不到要说人话并给重试，不能静悄悄显示成空板', async () => {
  const dom = setupDom();
  const { api, state } = makeApi({ failMistakes: true });
  const root = dom.byId('workbench-board');
  const board = await mountBoard({ root, api });

  const status = root.querySelector('.board__status');
  assert.ok(textOf(status).length > 0, '失败时状态区没有说话');
  assert.ok(textOf(root).includes('看板数据读不到'), '失败提示没有带上后端原话');

  const retry = root.querySelectorAll('button').find((b) => textOf(b).includes('重试'));
  assert.ok(retry, '失败时没有重试按钮');

  state.failMistakes = false;
  state.mistakes = [makeItem({ id: 7, status: 'new' })];
  retry.click();
  await board.reload();
  assert.equal(cardsIn(root, 'new').length, 1);
});

test('#61 空列要说「这一阶段没有题」，不能看起来像还在加载', async () => {
  const dom = setupDom();
  const { api } = makeApi({ mistakes: [makeItem({ id: 1, status: 'new' })] });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const emptyColumn = root.querySelector('.board__col[data-status="mastered"]');
  assert.ok(textOf(emptyColumn).includes('没有题') || textOf(emptyColumn).includes('暂无'), '空列没有说明');
  assert.equal(countTextOf(root, 'mastered'), '0');
});

test('#61 快速切换学科时，旧请求不得覆盖新筛选的结果', async () => {
  const dom = setupDom();
  const state = { mistakes: [], slow: true };
  const api = async (path) => {
    if (path.startsWith('/api/mistakes')) {
      const url = new URL(path, 'http://board.test');
      const subject = url.searchParams.get('subject');
      if (state.slow) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { total: 1, items: [makeItem({ id: 99, subject: 'chinese', status: 'new' })] };
      }
      return { total: 1, items: [makeItem({ id: 7, subject: 'math', status: 'new' })] };
    }
    if (path === '/api/reviews/today') return { date: '2026-11-05', total: 0, items: [] };
    if (path === '/api/meta') return { stats: {}, pendingVariants: [] };
    throw new Error('不该调这个接口');
  };
  const root = dom.byId('workbench-board');
  const board = await mountBoard({ root, api });

  const slowRequest = board.setSubject('all');
  state.slow = false;
  const fastRequest = board.setSubject('math');
  await Promise.all([slowRequest, fastRequest]);

  const ids = root.querySelectorAll('.board__card').map((c) => c.getAttribute('data-mistake-id'));
  assert.deepEqual(ids, ['7'], '旧请求的结果盖掉了新筛选');
});

test('#61 题库查询触到上限时要说明可能截断，不能冒充全量', async () => {
  const dom = setupDom();
  const many = Array.from({ length: 500 }, (_, i) => makeItem({ id: i + 1, status: 'new' }));
  const { api } = makeApi({ mistakes: many });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const text = textOf(root);
  assert.ok(text.includes('截断') || text.includes('上限'), '触到上限没有说明可能截断');
});

test('#61 题卡有真实详情链接，并显示学科与可用教材定位', async () => {
  const dom = setupDom();
  const items = [
    makeItem({
      id: 33,
      subject: 'math',
      status: 'new',
      prompt: '小明的速度是多少',
      unit_title: '四年级上册',
      unit_no: 3,
      lesson_title: '速度、时间与路程',
      page_no: '42',
    }),
  ];
  const { api } = makeApi({ mistakes: items });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const card = root.querySelector('.board__card[data-mistake-id="33"]');
  assert.ok(textOf(card).includes('数学'), '题卡没有显示学科');
  assert.ok(textOf(card).includes('小明的速度是多少'), '题卡没有显示题干');
  assert.ok(textOf(card).includes('四年级上册'), '题卡没有显示教材定位');

  const link = card.querySelectorAll('a').find((a) => a.getAttribute('href') === '/mistake/33');
  assert.ok(link, '题卡没有真实详情链接');
});

test('#61 没有教材定位的题不许硬编一个位置出来', async () => {
  const dom = setupDom();
  const { api } = makeApi({ mistakes: [makeItem({ id: 44, status: 'new', unit_title: null })] });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  const card = root.querySelector('.board__card[data-mistake-id="44"]');
  assert.ok(!textOf(card).includes('undefined'), '题卡里漏出了 undefined');
  assert.ok(!/\d+\s*年级/.test(textOf(card)), '没有教材定位却编了年级');
});

test('#61 草稿不进看板：待确认草稿数不许混进列头计数', async () => {
  const dom = setupDom();
  const meta = {
    stats: { total: 1, byStatus: { new: 1 } },
    pendingDrafts: 7,
    pendingVariants: [],
  };
  const { api } = makeApi({ mistakes: [makeItem({ id: 1, status: 'new' })], meta });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  assert.equal(countTextOf(root, 'new'), '1');
  const headText = root.querySelector('.board__col[data-status="new"] .board__colhead').textContent;
  assert.ok(!headText.includes('7'), '草稿数混进了列头');
});

test('#61 手机一次只显示一个阶段，默认复习中，选择器带各阶段题数', async () => {
  const dom = setupDom({ mobile: true });
  const items = [
    makeItem({ id: 1, status: 'new' }),
    makeItem({ id: 2, status: 'diagnosing' }),
    makeItem({ id: 3, status: 'reviewing' }),
    makeItem({ id: 4, status: 'reviewing' }),
  ];
  const { api } = makeApi({ mistakes: items });
  const root = dom.byId('workbench-board');
  const board = await mountBoard({ root, api });

  const columns = columnsOf(root);
  assert.equal(columns.length, 1, '手机上看不到只显示一个阶段');
  assert.equal(columns[0].getAttribute('data-status'), 'reviewing', '手机默认不是复习中');

  const stageChips = root.querySelectorAll('[data-stage]');
  assert.equal(stageChips.length, 5);
  const reviewing = stageChips.find((chip) => chip.getAttribute('data-stage') === 'reviewing');
  assert.ok(textOf(reviewing).includes('2'), '阶段选择器没有带该阶段的题数');

  await board.setStage('new');
  const after = columnsOf(root);
  assert.equal(after.length, 1);
  assert.equal(after[0].getAttribute('data-status'), 'new');
});

test('#61 阶段选择器与学科筛选都是能按的按钮，不是只能看的色块', async () => {
  const dom = setupDom({ mobile: true });
  const { api } = makeApi({ mistakes: [] });
  const root = dom.byId('workbench-board');
  await mountBoard({ root, api });

  for (const chip of root.querySelectorAll('[data-stage], [data-subject]')) {
    assert.equal(chip.localName, 'button', '选择器不是 button，键盘用不了');
    assert.ok(chip.getAttribute('aria-pressed') !== null || chip.getAttribute('aria-selected') !== null,
      '选择器没有告诉辅助技术自己被选中了');
  }
});

test('#61 触控目标不小于 44px，状态不只是颜色', async () => {
  const css = readFileSync(join(REPO, 'public', 'css', 'components.css'), 'utf8');
  assert.ok(/\.board__chip\b[^{]*\{[^}]*min-height:\s*var\(--touch-min\)/.test(css),
    '看板选择器没有 44px 触控下限');
  assert.ok(/\.board__colhead\b[^{]*\{[^}]*min-height:\s*var\(--touch-min\)/.test(css),
    '看板列头没有 44px 触控下限');
});
