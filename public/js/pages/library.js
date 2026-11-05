// 题库：科目 / 状态 / 教材单元三档筛选，勾选后批量补教材定位。
// 所有数字都来自实时查询（/api/meta + /api/mistakes），页面不手填计数。
import { el, stateTag, link, empty, alert, toast } from '../ui.js';
import { guard } from '../errors.js';

const SUBJECTS = [['', '全部科目'], ['math', '数学'], ['chinese', '语文'], ['english', '英语']];
const STATUSES = [['', '全部状态'], ['new', '待诊断'], ['diagnosing', '诊断中'], ['correcting', '纠错中'], ['reviewing', '复习中'], ['mastered', '已掌握']];
const STATUS_LABEL = { new: '待诊断', diagnosing: '诊断中', correcting: '纠错中', reviewing: '复习中', mastered: '已掌握' };
const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };

function fillPairs(node, pairs) {
  node.replaceChildren();
  for (const [value, label] of pairs) {
    const option = el('option', '', label);
    option.value = value;
    node.append(option);
  }
}

function fillNodes(node, nodes, placeholder) {
  node.replaceChildren();
  const first = el('option', '', placeholder);
  first.value = '';
  node.append(first);
  for (const item of nodes || []) {
    const option = el('option', '', `${SUBJECT_LABEL[item.subject] || item.subject} · 第 ${item.unit_no} 单元 ${item.unit_title}`);
    option.value = String(item.id);
    option.dataset.subject = item.subject;
    node.append(option);
  }
}

export async function mount({ root, api, toast: notify = toast }) {
  const subjectSelect = document.getElementById('library-filter-subject');
  const statusSelect = document.getElementById('library-filter-status');
  const nodeSelect = document.getElementById('library-filter-node');
  const pendingBox = document.getElementById('library-filter-pending');
  const batchNode = document.getElementById('library-batch-node');
  const applyButton = document.getElementById('library-batch-apply');
  const selectAllButton = document.getElementById('library-select-all');
  const selectedLabel = document.getElementById('library-batch-selected');
  const listBox = document.getElementById('library-list-body');
  const summary = document.getElementById('library-summary');
  if (!subjectSelect || !statusSelect || !nodeSelect || !pendingBox || !batchNode
      || !applyButton || !selectedLabel || !listBox || !summary) {
    root.replaceChildren(alert('题库页骨架不完整，请刷新页面。', 'error'));
    return;
  }

  fillPairs(subjectSelect, SUBJECTS);
  fillPairs(statusSelect, STATUSES);
  const selected = new Set();
  let visibleIds = [];
  let nodesFilled = false;

  function updateSelectedCount() {
    selectedLabel.textContent = `已勾选 ${selected.size} 道`;
  }

  async function render() {
    const params = new URLSearchParams();
    if (subjectSelect.value) params.set('subject', subjectSelect.value);
    if (statusSelect.value) params.set('status', statusSelect.value);
    if (nodeSelect.value) params.set('textbook_node_id', nodeSelect.value);
    if (pendingBox.checked) params.set('needs_textbook_ref', '1');
    const [meta, data] = await Promise.all([
      api('/api/meta'),
      api(`/api/mistakes?${params}`),
    ]);
    if (!nodesFilled) {
      fillNodes(nodeSelect, meta.textbookNodes, '全部教材单元');
      fillNodes(batchNode, meta.textbookNodes, '选择要挂的单元');
      nodesFilled = true;
    }
    summary.textContent = `实时查询：筛选 ${data.total} 道 / 题库 ${meta.stats.total} 道 / 待补定位 ${meta.stats.awaitingTextbookRef} 道`;
    document.querySelector('#library-list .card__head h2').textContent = `题目列表 · ${data.total} 道`;

    visibleIds = data.items.map((item) => Number(item.id));
    listBox.replaceChildren();
    if (data.items.length === 0) {
      listBox.append(empty('没有符合条件的题', '换个筛选条件，或去收件箱录一道。'));
      return;
    }
    for (const item of data.items) {
      const id = Number(item.id);
      const row = el('div', 'row');
      const box = el('input', 'checkbox');
      box.type = 'checkbox';
      box.id = `library-pick-${id}`;
      box.dataset.id = String(id);
      box.checked = selected.has(id);
      const label = el('label', 'small', '选');
      label.htmlFor = box.id;
      box.addEventListener('change', () => {
        if (box.checked) selected.add(id);
        else selected.delete(id);
        updateSelectedCount();
      });
      row.append(
        box,
        label,
        stateTag(item.status, STATUS_LABEL[item.status] || item.status),
        el('span', 'small muted', SUBJECT_LABEL[item.subject] || item.subject),
        link(item.prompt?.slice(0, 44) || `第 ${item.id} 题`, `/mistake/${item.id}`, 'grow'),
        item.needs_textbook_ref
          ? el('span', 'small', '待补定位')
          : el('span', 'small muted', item.unit_title || `第 ${item.unit_no ?? '-'} 单元`),
      );
      listBox.append(row);
    }
  }

  // 筛选回调是 async：失败时没人接就变成静默的 unhandled rejection——
  // 列表停在旧数据，老师只看到「点了没反应」。包一层，失败就说出来（#58）。
  for (const control of [subjectSelect, statusSelect, nodeSelect, pendingBox]) {
    control.addEventListener('change', guard(render, { notify }));
  }

  selectAllButton.addEventListener('click', () => {
    for (const id of visibleIds) selected.add(id);
    for (const box of listBox.querySelectorAll('input[type="checkbox"]')) box.checked = true;
    updateSelectedCount();
  });

  applyButton.addEventListener('click', async () => {
    const ids = [...selected];
    const nodeId = batchNode.value ? Number(batchNode.value) : 0;
    if (!nodeId) {
      notify('先选一个要挂的教材单元', 'error');
      return;
    }
    if (ids.length === 0) {
      notify('先勾选要补定位的题', 'error');
      return;
    }
    applyButton.disabled = true;
    try {
      const result = await api('/api/mistakes/batch-textbook-ref', {
        method: 'POST',
        body: { ids, textbook_node_id: nodeId },
      });
      selected.clear();
      updateSelectedCount();
      notify(`已挂 ${result.updated} 道，跳过 ${result.skipped} 道`);
      await render();
    } catch (error) {
      const message = error.code === 'SUBJECT_MISMATCH'
        ? `挂错科目：${error.message}（整批未写入）`
        : `没能挂上：${error.message}`;
      notify(message, 'error');
    } finally {
      applyButton.disabled = false;
    }
  });

  root.replaceChildren(alert('筛选与计数都来自实时查询；批量挂节点若科目不对，整批会被拒绝。', 'info'));
  await render();
}
