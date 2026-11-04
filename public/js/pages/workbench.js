// 工作台：四个数字实时聚合、每个直达动作；今日复习按到期日排，做对做错与证据入口都在本页。
import { el, stateTag, link, alert, button, toast } from '../ui.js';

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
    api('/api/ai/status').catch(() => ({ pendingDrafts: 0 })),
  ]);
  const kpis = {
    pendingDrafts: aiStatus.pendingDrafts ?? state.pendingDrafts ?? 0,
    today: reviews.total,
    overdue: meta.stats.overdue,
    awaitingTextbookRef: meta.stats.awaitingTextbookRef,
  };
  for (const [key, value] of Object.entries(kpis)) {
    const node = document.getElementById(`kpi-${key}`);
    if (node) node.textContent = value;
  }

  const actions = document.getElementById('workbench-actions');
  actions.replaceChildren(
    button('收一道新题', { variant: 'primary', onClick: () => { location.href = '/inbox'; } }),
    button('出今日练习纸', { variant: 'secondary', onClick: () => { location.href = '/print'; } }),
    button('翻题库', { variant: 'ghost', onClick: () => { location.href = '/library'; } }),
  );

  async function submitResult(item, result, evidenceSelect) {
    const body = { result };
    if (result === 'correct' && (item.review_round ?? 0) >= 3 && evidenceSelect?.value) {
      body.evidence_type = evidenceSelect.value;
      body.evidence_note = '老师在复习现场记录的学生证据';
    }
    try {
      await api(`/api/reviews/${item.id}/result`, { method: 'POST', body });
      toast(result === 'correct' ? '已记做对，下一次复习按 1-3-7-30 排期。' : '已记做错，回到当前轮次继续练。');
      await mount({ root, api, state });
    } catch (error) {
      toast(`没能记录：${error.message}`, 'error');
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
    row.append(
      button('做对', { variant: 'ghost', onClick: () => submitResult(item, 'correct', evidenceSelect) }),
      button('做错', { variant: 'ghost', onClick: () => submitResult(item, 'wrong', evidenceSelect) }),
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
