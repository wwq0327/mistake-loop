// 工作台：四个数字实时聚合、每个直达动作；今日复习按到期日排，做对做错与证据入口都在本页。
import { el, stateTag, link, alert, button, toast } from '../ui.js';
import { describeError } from '../api.js';

const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const STATUS_LABEL = { new: '待诊断', diagnosing: '诊断中', correcting: '纠错中', reviewing: '复习中', mastered: '已掌握' };
const EVIDENCE_LABEL = {
  retell: '复述', same_structure_variant: '同结构变式', spaced_recall: '间隔提取',
  self_check_method: '说出检查方法', teach_others: '讲给别人听',
};

function bodyOf(id) {
  return document.querySelector(`#${id} .card__body`);
}

export async function mount({ root, api, state }) {
  const [meta, reviews, aiStatus] = await Promise.all([
    api('/api/meta'),
    api('/api/reviews/today'),
    // 读不到就是「不知道」，不是 0。兜成 0 会在 KPI 上谎报「待确认草稿 0」，
    // 老师会以为收件箱是空的——比报错更糟（#58）。
    api('/api/ai/status').catch(() => null),
  ]);
  const kpis = {
    pendingDrafts: aiStatus ? Number(aiStatus.pendingDrafts ?? 0) : null,
    today: reviews.total,
    overdue: meta.stats.overdue,
    awaitingTextbookRef: meta.stats.awaitingTextbookRef,
  };
  for (const [key, value] of Object.entries(kpis)) {
    const node = document.getElementById(`kpi-${key}`);
    if (node) node.textContent = value === null || value === undefined ? '未知' : value;
  }

  const actions = document.getElementById('workbench-actions');
  actions.replaceChildren(
    button('收一道新题', { variant: 'primary', onClick: () => { location.href = '/inbox'; } }),
    button('出今日练习纸', { variant: 'secondary', onClick: () => { location.href = '/print'; } }),
    button('翻题库', { variant: 'ghost', onClick: () => { location.href = '/library'; } }),
  );

  async function submitResult(item, result, evidenceSelect, rowButtons) {
    const body = { result };
    // #56：带上这道题「这次复习」的到期日——它是这次复习的身份。
    // 后端拿它判重，同一次复习只记一遍；不带的话后端分不清「连点两下」与「连做多轮」。
    if (item.next_review) body.due_on = item.next_review;
    if (result === 'correct' && (item.review_round ?? 0) >= 3 && evidenceSelect?.value) {
      body.evidence_type = evidenceSelect.value;
      body.evidence_note = '老师在复习现场记录的学生证据';
    }
    // 请求在飞时把这一行的两个按钮都置灰：老师手快连点两下不该记成两轮。
    // 与后端的 due_on 判重是两道独立的防线——置灰防的是「还没发出去的那一下」，
    // due_on 防的是「已经发出去两次」。
    for (const node of rowButtons) node.disabled = true;
    try {
      await api(`/api/reviews/${item.id}/result`, { method: 'POST', body });
      toast(result === 'correct' ? '已记做对，下一次复习按 1-3-7-30 排期。' : '已记做错，回到当前轮次继续练。');
      await mount({ root, api, state });
    } catch (error) {
      // 409 是「这次复习已经记过了」，不是记录失败：说人话，
      // 别让老师以为自己没记上、又去点一次。其余状态按 describeError 分开说。
      toast(describeError(error), 'error');
      for (const node of rowButtons) node.disabled = false;
    }
  }

  const todayBody = bodyOf('workbench-today');
  todayBody.replaceChildren();
  const head = document.querySelector('#workbench-today .card__head');
  if (head) head.lastChild.textContent = `${reviews.date} · 按到期日排序`;
  if (reviews.items.length === 0) {
    todayBody.append(alert('今天没有到期的题。逾期不会自动清零，到期了就会出现在这里。', 'info'));
  }
  // 接口已按 next_review 排序，这里再按到期日与逾期天数稳定排一次，保证界面顺序一致。
  const sorted = [...reviews.items].sort((a, b) => String(a.next_review).localeCompare(String(b.next_review)) || a.id - b.id);
  for (const item of sorted.slice(0, 20)) {
    const row = el('div', 'row');
    row.append(
      stateTag('reviewing', STATUS_LABEL.reviewing),
      el('span', 'small muted', `${SUBJECT_LABEL[item.subject] || item.subject} · 第 ${item.review_round} 轮`),
      link(item.prompt?.slice(0, 40) || `第 ${item.id} 题`, `/mistake/${item.id}`, 'grow'),
      el('span', 'small', item.next_review || '未排期'),
      el('span', 'small', item.overdue_days > 0 ? `逾期 ${item.overdue_days} 天` : '今天到期'),
    );
    let evidenceSelect = null;
    if (resultNeedsEvidence(item)) {
      const field = el('div', 'field');
      const label = el('label', '', '学生掌握证据（第 4 轮必填）');
      label.htmlFor = `evidence-${item.id}`;
      evidenceSelect = el('select', 'select');
      evidenceSelect.id = `evidence-${item.id}`;
      for (const kind of meta.evidenceKinds || Object.keys(EVIDENCE_LABEL)) {
        const option = el('option', '', EVIDENCE_LABEL[kind] || kind);
        option.value = kind;
        evidenceSelect.append(option);
      }
      field.append(label, evidenceSelect);
      row.append(field);
    }
    // 这一行的两个动作按钮：提交在飞时一并置灰，所以按钮要先造出来再互相引用。
    const rowButtons = [];
    const correctBtn = button('做对', { variant: 'ghost', onClick: () => submitResult(item, 'correct', evidenceSelect, rowButtons) });
    const wrongBtn = button('做错', { variant: 'ghost', onClick: () => submitResult(item, 'wrong', evidenceSelect, rowButtons) });
    rowButtons.push(correctBtn, wrongBtn);
    row.append(
      correctBtn,
      wrongBtn,
      link('记录证据 →', `/mistake/${item.id}`, 'small'),
    );
    todayBody.append(row);
  }

  const pendingBody = bodyOf('workbench-pending');
  pendingBody.replaceChildren();
  if (meta.pendingVariants.length === 0) {
    pendingBody.append(el('p', 'muted small', '暂无待审核变式。'));
  } else {
    for (const item of meta.pendingVariants.slice(0, 8)) {
      pendingBody.append(link(`#${item.mistake_id} ${item.level}：${item.prompt?.slice(0, 46) || '（待补题干）'}`, `/mistake/${item.mistake_id}`, 'small'));
    }
  }
  root.replaceChildren(alert(`统计来自实时查询：共 ${meta.stats.total} 道题，复习中 ${meta.stats.byStatus.reviewing} 道。`, 'info'));
}

function resultNeedsEvidence(item) {
  return (item.review_round ?? 0) >= 3;
}
