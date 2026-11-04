// 题库：按科目 / 状态 / 待补定位检索。批量补教材定位在 #23 接入。
import { el, card, stateTag, link, empty } from '../ui.js';

const SUBJECTS = [['', '全部科目'], ['math', '数学'], ['chinese', '语文'], ['english', '英语']];
const STATUSES = [['', '全部状态'], ['new', '待诊断'], ['diagnosing', '诊断中'], ['correcting', '纠错中'], ['reviewing', '复习中'], ['mastered', '已掌握']];
const STATUS_LABEL = { new: '待诊断', diagnosing: '诊断中', correcting: '纠错中', reviewing: '复习中', mastered: '已掌握' };
const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };

export async function mount({ root, api }) {
  const filters = el('div', 'field-row');
  const subjectSelect = el('select', 'select');
  subjectSelect.id = 'filter-subject';
  for (const [value, label] of SUBJECTS) {
    const option = el('option', '', label);
    option.value = value;
    subjectSelect.append(option);
  }
  const subjectField = el('div', 'field');
  const subjectLabel = el('label', '', '科目');
  subjectLabel.htmlFor = 'filter-subject';
  subjectField.append(subjectLabel, subjectSelect);

  const statusSelect = el('select', 'select');
  statusSelect.id = 'filter-status';
  for (const [value, label] of STATUSES) {
    const option = el('option', '', label);
    option.value = value;
    statusSelect.append(option);
  }
  const statusField = el('div', 'field');
  const statusLabel = el('label', '', '状态');
  statusLabel.htmlFor = 'filter-status';
  statusField.append(statusLabel, statusSelect);
  filters.append(subjectField, statusField);

  const listCard = card('题目列表');
  const render = async () => {
    const params = new URLSearchParams();
    if (subjectSelect.value) params.set('subject', subjectSelect.value);
    if (statusSelect.value) params.set('status', statusSelect.value);
    const data = await api(`/api/mistakes?${params}`);
    listCard.node.querySelector('.card__head h2').textContent = `题目列表 · ${data.total} 道`;
    if (data.items.length === 0) {
      listCard.body.replaceChildren(empty('没有符合条件的题', '换个筛选条件，或去收件箱录一道。'));
      return;
    }
    const list = el('div', 'stack');
    for (const item of data.items) {
      const row = el('div', 'row');
      row.append(
        stateTag(item.status, STATUS_LABEL[item.status] || item.status),
        el('span', 'small muted', SUBJECT_LABEL[item.subject] || item.subject),
        link(item.prompt?.slice(0, 46) || `第 ${item.id} 题`, `/mistake/${item.id}`, 'grow'),
        item.needs_textbook_ref ? el('span', 'small', '待补定位') : el('span', 'small muted', item.unit_title || ''),
      );
      list.append(row);
    }
    listCard.body.replaceChildren(list);
  };
  subjectSelect.addEventListener('change', render);
  statusSelect.addEventListener('change', render);

  root.replaceChildren(filters, listCard.node);
  await render();
}
