// 闭环看板：五态并排，看一道题走到哪一步、接下来该做什么。
//
// 三条规矩贯穿全文件：
//   1) 一道题只在一列里——归列只认服务端给的 status，不靠前端猜。
//   2) 计数说的是「当前这块屏幕上真的有几张卡」——加载中不写 0，失败不写 0，
//      触到查询上限要说明可能截断，不能拿部分结果冒充全量。
//   3) 读不到就说读不到，并给重试——静悄悄显示成空板比报错更糟（#58）。
import { el, link, alert, button, toast } from '../ui.js';
import { describeError } from '../api.js';

// 五态与顺序：与后端状态机一致（src/state-machine.mjs），列序即推进顺序。
export const STAGES = [
  { status: 'new', label: '待诊断' },
  { status: 'diagnosing', label: '诊断中' },
  { status: 'correcting', label: '纠错中' },
  { status: 'reviewing', label: '复习中' },
  { status: 'mastered', label: '已掌握' },
];

const SUBJECTS = [
  { key: 'all', label: '全部' },
  { key: 'math', label: '数学' },
  { key: 'chinese', label: '语文' },
  { key: 'english', label: '英语' },
];

const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };

// 手机一次只显示一个阶段；这个断点与 layout.css 里的看板断点保持一致。
const MOBILE_QUERY = '(max-width: 767px)';
// 题库查询的服务端上限：返回条数撞上这个数就说明可能还有没拿回来的。
const LIST_LIMIT = 500;

// 掌握证据的中文名。服务端 /api/meta 下发可用的类型，这里只管怎么念。
const EVIDENCE_LABEL = {
  retell: '复述',
  transfer: '同结构变式',
  spaced: '间隔提取',
  check_method: '说出检查方法',
  teach: '讲给别人听',
};

// review_round 记的是「已经做完几轮」，所以第 4 轮做对时它是 3。
// 与服务端一致（applyReview 的闸门），也与工作台那条 resultNeedsEvidence 同一口径。
const EVIDENCE_FROM_ROUND = 3;

function isMobile() {
  try {
    return globalThis.matchMedia?.(MOBILE_QUERY)?.matches === true;
  } catch {
    return false;
  }
}

// 老师点进详情看完再回来，不该重选一遍学科和阶段（#62）。
// 存 sessionStorage 而不是 localStorage：关掉标签页就忘掉，不替下一个人记着。
export const FILTER_KEY = 'mistake-loop:board-filters';

function readFilters() {
  try {
    const raw = globalThis.sessionStorage?.getItem(FILTER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 存坏了、无痕模式写不了——都当没存过，绝不因此把看板弄挂。
    return {};
  }
}

function writeFilters(filters) {
  try {
    globalThis.sessionStorage?.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch { /* 存不了就只活在内存里，功能不受影响 */ }
}

function textbookRef(item) {
  // 没有定位就什么都不显示，不许拿 undefined 或别的字段凑一个位置出来。
  const parts = [];
  if (item.unit_title) parts.push(item.unit_title);
  if (item.lesson_title) parts.push(item.lesson_title);
  if (item.page_no) parts.push(`P${item.page_no}`);
  return parts.join(' · ');
}

function dueText(due) {
  if (!due) return '';
  const days = Number(due.overdue_days || 0);
  return days > 0 ? `逾期 ${days} 天` : '今天到期';
}

/**
 * 挂载看板。返回控制器：setSubject / setStage / reload，
 * 调用方（以及测试）可以精确编排请求时序。
 */
export async function mountBoard({ root, api }) {
  // 恢复上次的筛选；存储里的值先过一遍白名单，脏值不许直接把看板带偏。
  const stored = readFilters();
  let subject = SUBJECTS.some((option) => option.key === stored.subject) ? stored.subject : 'all';
  let activeStage = STAGES.some((stage) => stage.status === stored.stage) ? stored.stage : 'reviewing';
  // 请求序号：只有最后一次请求的结果算数，旧请求回来直接丢弃，
  // 免得快速切学科时旧结果盖掉新筛选（#61）。
  let requestToken = 0;
  let current = null;
  // 正在提交的题：按钮置灰之外的第二道闸，挡住「已经点下去的那一下」。
  const busy = new Set();

  const board = el('div', 'board');

  const bar = el('div', 'board__bar');
  const subjectGroup = el('div', 'board__group');
  subjectGroup.setAttribute('role', 'group');
  subjectGroup.setAttribute('aria-label', '学科筛选');
  const subjectChips = el('div', 'board__chips');
  subjectGroup.append(el('span', 'board__group-label', '学科'), subjectChips);

  const stageGroup = el('div', 'board__group');
  stageGroup.setAttribute('role', 'group');
  stageGroup.setAttribute('aria-label', '阶段');
  const stageChips = el('div', 'board__chips');
  stageGroup.append(el('span', 'board__group-label', '阶段'), stageChips);
  bar.append(subjectGroup, stageGroup);

  const status = el('div', 'board__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const columns = el('div', 'board__columns');
  board.append(bar, status, columns);
  root.replaceChildren(board);

  function chip({ label, count, active, attrs, onClick }) {
    const node = el('button', 'board__chip');
    node.type = 'button';
    node.setAttribute('aria-pressed', active ? 'true' : 'false');
    node.append(el('span', 'board__chip-label', label));
    if (count !== undefined && count !== null) {
      node.append(el('span', 'board__chip-count', String(count)));
    }
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    node.addEventListener('click', onClick);
    return node;
  }

  function renderChips() {
    subjectChips.replaceChildren();
    for (const option of SUBJECTS) {
      subjectChips.append(chip({
        label: option.label,
        active: subject === option.key,
        attrs: { 'data-subject': option.key },
        onClick: () => { setSubject(option.key); },
      }));
    }
    stageChips.replaceChildren();
    for (const stage of STAGES) {
      const count = current ? current.buckets.get(stage.status).length : null;
      stageChips.append(chip({
        label: stage.label,
        count,
        active: stage.status === activeStage,
        attrs: { 'data-stage': stage.status },
        onClick: () => { setStage(stage.status); },
      }));
    }
  }

  function renderSkeleton() {
    status.replaceChildren(el('span', 'board__status-text', '正在加载题目，稍等一下…'));
    columns.replaceChildren();
    const mobile = isMobile();
    for (const stage of STAGES) {
      if (mobile && stage.status !== activeStage) continue;
      const column = el('section', 'board__col');
      column.setAttribute('data-status', stage.status);
      const head = el('header', 'board__colhead');
      // 加载中写「—」，不写 0：老师分得清「还没读到」与「确实没有」。
      head.append(el('h2', 'board__coltitle', stage.label), el('span', 'board__count', '—'));
      const body = el('div', 'board__colbody');
      body.append(el('div', 'skeleton skeleton--line'));
      column.append(head, body);
      columns.append(column);
    }
  }

  function cardNode(item, due) {
    const card = el('article', 'board__card');
    card.setAttribute('data-mistake-id', String(item.id));

    const head = el('div', 'board__cardhead');
    head.append(el('span', 'board__subject', SUBJECT_LABEL[item.subject] || item.subject || ''));
    const ref = textbookRef(item);
    if (ref) head.append(el('span', 'board__ref', ref));
    card.append(head);

    card.append(el('p', 'board__prompt', item.prompt || '（题干待补）'));

    const foot = el('div', 'board__cardfoot');
    const dueLabel = dueText(due);
    if (dueLabel) {
      foot.append(el('span', `board__due${due.overdue_days > 0 ? ' board__due--overdue' : ''}`, dueLabel));
    } else if (item.status === 'reviewing' && item.next_review) {
      foot.append(el('span', 'board__due', `下次复习 ${item.next_review}`));
    }
    foot.append(link('查看详情 →', `/mistake/${item.id}`, 'board__link'));
    card.append(foot);
    // 到期的题就地登记，不用再滚回工作台那张列表另找一遍（#63）。
    if (due) card.append(reviewActions(item));
    return card;
  }

  // 到期题的做对/做错。提交必须带 due_on：那是「这次复习」的身份，
  // 后端靠它判重，连点两下才不会被记成两轮。
  function reviewActions(item) {
    const box = el('div', 'board__review');
    box.setAttribute('data-review-for', String(item.id));

    let select = null;
    if ((item.review_round ?? 0) >= EVIDENCE_FROM_ROUND) {
      const field = el('div', 'field');
      const label = el('label', '', '学生掌握证据（第 4 轮必填）');
      label.htmlFor = `board-evidence-${item.id}`;
      select = el('select', 'select');
      select.id = `board-evidence-${item.id}`;
      select.setAttribute('data-evidence', String(item.id));
      // 第一项是空值占位：不预选任何一条，掌握证据必须由老师看着学生说出来再选。
      const blank = el('option', '', '请选择观察到的证据');
      blank.value = '';
      select.append(blank);
      for (const kind of current?.evidenceKinds ?? Object.keys(EVIDENCE_LABEL)) {
        const option = el('option', '', EVIDENCE_LABEL[kind] || kind);
        option.value = kind;
        select.append(option);
      }
      select.value = '';
      field.append(label, select);
      box.append(field);
    }

    const row = el('div', 'board__row');
    const buttons = [];
    for (const [result, label] of [['correct', '做对'], ['wrong', '做错']]) {
      const node = button(label, {
        variant: 'ghost',
        onClick: () => { submitResult(item, result, select, buttons); },
      });
      node.setAttribute('data-result', result);
      buttons.push(node);
      row.append(node);
    }
    box.append(row);
    return box;
  }

  async function submitResult(item, result, select, buttons) {
    // 在途禁重复提交：置灰挡得住鼠标，挡不住「已经点下去的那一下」，所以还要一个忙标记。
    if (busy.has(item.id)) return;
    const needsEvidence = (item.review_round ?? 0) >= EVIDENCE_FROM_ROUND;
    const evidenceType = select?.value ?? '';
    if (result === 'correct' && needsEvidence && !evidenceType) {
      toast(`第 ${item.id} 题要记做对，先选一条你观察到的掌握证据。`, 'error');
      return;
    }

    busy.add(item.id);
    for (const node of buttons) node.disabled = true;
    const body = { result, due_on: item.next_review };
    if (evidenceType) body.evidence_type = evidenceType;

    try {
      await api(`/api/reviews/${item.id}/result`, { method: 'POST', body });
    } catch (error) {
      toast(describeError(error), 'error');
      busy.delete(item.id);
      for (const node of buttons) node.disabled = false;
      return;
    }

    busy.delete(item.id);
    toast(`第 ${item.id} 题：${result === 'correct' ? '已记做对' : '已记做错'}。`);

    // 写成功不等于界面知道了新状态：必须重新读取，按服务端结果归列。
    try {
      await load({ silent: true });
    } catch (error) {
      // 读不回来就别动卡片——凭猜把卡挪走，比停在原处更糟。
      toast(`第 ${item.id} 题已记上，但刷新没成功：${describeError(error)}。稍后刷新页面即可，别重复提交。`, 'error');
    }
  }

  function renderColumns(buckets, dueMap) {
    columns.replaceChildren();
    const mobile = isMobile();
    for (const stage of STAGES) {
      // 手机一次只显示一个阶段；桌面五列并排。
      if (mobile && stage.status !== activeStage) continue;
      const column = el('section', 'board__col');
      column.setAttribute('data-status', stage.status);
      if (stage.status === activeStage) column.classList.add('is-active');

      const head = el('header', 'board__colhead');
      head.append(
        el('h2', 'board__coltitle', stage.label),
        el('span', 'board__count', String(buckets.get(stage.status).length)),
      );

      const body = el('div', 'board__colbody');
      const items = buckets.get(stage.status);
      if (items.length === 0) {
        body.append(el('p', 'board__empty', '这一阶段没有题。'));
      } else {
        for (const item of items) body.append(cardNode(item, dueMap.get(item.id)));
      }
      column.append(head, body);
      columns.append(column);
    }
  }

  function renderError(error) {
    const message = describeError(error);
    status.replaceChildren();
    const box = el('div', 'board__status-box');
    box.append(alert(`看板没能加载：${message}`, 'error'));
    box.append(button('重试', { variant: 'secondary', onClick: () => { load(); } }));
    status.append(box);
    // 失败时列区说清楚是「没读到」，不是「没有题」——两件事必须能分开。
    columns.replaceChildren();
    const placeholder = el('section', 'board__col board__col--error');
    placeholder.setAttribute('data-status', 'error');
    placeholder.append(el('p', 'board__empty', '看板数据没读到，暂时看不到题。点上面「重试」再试一次。'));
    columns.append(placeholder);
    toast(`看板没能加载：${message}`, 'error');
  }

  function renderSummary(items, meta, truncated) {
    const scope = SUBJECTS.find((option) => option.key === subject)?.label || '全部';
    status.replaceChildren();
    const text = el('span', 'board__status-text');
    text.textContent = `${scope} · 共 ${items.length} 道题`;
    status.append(text);
    if (truncated) {
      // 撞上限就说明白：这份看板可能不全，不能冒充全量聚合。
      status.append(el('span', 'board__status-warn',
        `已取回 ${items.length} 道，题库查询最多返回 ${LIST_LIMIT} 条，可能已截断——这里显示的不是全部。`));
    }
    const byStatus = meta?.stats?.byStatus;
    if (byStatus && Object.keys(byStatus).length && subject === 'all' && !truncated) {
      const local = STAGES.reduce((sum, stage) => sum + (items.filter((item) => item.status === stage.status).length), 0);
      const server = STAGES.reduce((sum, stage) => sum + (Number(byStatus[stage.status] || 0)), 0);
      if (local !== server) {
        status.append(el('span', 'board__status-warn',
          `板上 ${local} 道，统计说 ${server} 道——两处对不上，先别当成全量。`));
      }
    }
  }

  function bucketsOf(items, dueMap) {
    const buckets = new Map(STAGES.map((stage) => [stage.status, []]));
    for (const item of items) {
      if (buckets.has(item.status)) buckets.get(item.status).push(item);
    }
    // 复习列：到期的排前面（按到期日），没到期的按下次复习日排。
    const dueIds = new Set(dueMap.keys());
    const reviewing = buckets.get('reviewing');
    reviewing.sort((a, b) => {
      const aDue = dueIds.has(a.id);
      const bDue = dueIds.has(b.id);
      if (aDue !== bDue) return aDue ? -1 : 1;
      const date = String(a.next_review || '9999').localeCompare(String(b.next_review || '9999'));
      return date || a.id - b.id;
    });
    for (const [status, list] of buckets) {
      if (status !== 'reviewing') list.sort((a, b) => a.id - b.id);
    }
    return buckets;
  }

  /**
   * 取数并渲染。
   * silent=true 用于「写完再读回」：不画骨架、失败不改版面，直接抛给调用方，
   * 由它把「已记上但刷新失败」说清楚——读不回来时把看板清成错误态属于帮倒忙。
   */
  async function load({ silent = false } = {}) {
    const token = ++requestToken;
    if (!silent) renderSkeleton();
    const path = subject === 'all' ? '/api/mistakes' : `/api/mistakes?subject=${subject}`;
    try {
      const [list, reviews, meta] = await Promise.all([
        api(path),
        // 复习到期信息读不到，不该让整块看板都瞎掉：题照常显示，只是分不出到期。
        api('/api/reviews/today').catch(() => null),
        api('/api/meta').catch(() => null),
      ]);
      // 旧请求：不渲染。它回来得晚，不代表现在要看的还是它。
      if (token !== requestToken) return;
      const items = Array.isArray(list?.items) ? list.items : [];
      const dueMap = new Map();
      for (const item of reviews?.items || []) dueMap.set(item.id, item);
      const buckets = bucketsOf(items, dueMap);
      current = { buckets, dueMap, evidenceKinds: meta?.evidenceKinds ?? null };
      renderChips();
      renderColumns(buckets, dueMap);
      renderSummary(items, meta, items.length >= LIST_LIMIT || Number(list?.total || 0) >= LIST_LIMIT);
    } catch (error) {
      if (token !== requestToken) return;
      if (silent) throw error;
      renderError(error);
    }
  }

  async function setSubject(next) {
    subject = next;
    writeFilters({ subject, stage: activeStage });
    renderChips();
    return load();
  }

  async function setStage(next) {
    activeStage = next;
    writeFilters({ subject, stage: activeStage });
    if (current) {
      renderChips();
      renderColumns(current.buckets, current.dueMap);
    }
    return undefined;
  }

  async function reload() {
    return load();
  }

  renderChips();
  await load();
  return { setSubject, setStage, reload };
}
