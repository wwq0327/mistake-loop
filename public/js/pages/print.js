// 打印：默认带今日复习，可增删；预览与出纸共用同一份题卡数据。
// 学生版字段白名单在这里收口：答案、学生作答、诊断记录与引导提示永不落纸。
import { el, button, empty, alert, questionCard, toast } from '../ui.js';

export const STUDENT_FIELDS = [
  'id', 'subject', 'subject_label', 'unit_title', 'prompt', 'image_path', 'geometry_svg',
];

export function pickStudentFields(card) {
  const clean = {};
  for (const key of STUDENT_FIELDS) {
    if (card && card[key] !== undefined) clean[key] = card[key];
  }
  clean.variants = Array.isArray(card?.variants)
    ? card.variants.map((item) => ({ level: item.level, prompt: item.prompt }))
    : [];
  return clean;
}

// 出纸时不再取数：打印的就是屏幕上已经渲染好的那份 sheetData。
function printSheet() {
  window.print();
}

const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const STATUS_LABEL = { new: '待诊断', diagnosing: '诊断中', correcting: '纠错中', reviewing: '复习中', mastered: '已掌握' };

export async function mount({ root, api, toast: notify = toast }) {
  const candidatesBox = document.getElementById('print-candidates');
  const previewBox = document.getElementById('print-preview-body');
  const countNode = document.getElementById('print-selected-count');
  const actionsBox = document.getElementById('print-actions');
  const titleNode = document.getElementById('print-preview-title');
  const searchInput = document.getElementById('print-q');
  if (!candidatesBox || !previewBox || !countNode || !actionsBox) {
    root.replaceChildren(alert('打印页骨架不完整，请刷新页面。', 'error'));
    return;
  }

  // 默认选题来自今日复习，候选题池来自实时题库；两者都只读，不写任何记录。
  const [today, pool] = await Promise.all([
    api('/api/reviews/today'),
    api('/api/mistakes'),
  ]);
  const todayIds = today.items.map((item) => Number(item.id));
  const selected = new Set(todayIds);
  let sheetData = { total: 0, cards: [] };

  function renderPreview(sheet) {
    previewBox.replaceChildren();
    if (!sheet.cards || sheet.cards.length === 0) {
      previewBox.append(empty('没有可打印的题', '今天没有到期的复习题，也可以在上面勾选几道。'));
      return;
    }
    for (const item of sheet.cards) {
      previewBox.append(questionCard(pickStudentFields(item), { withLines: true }));
    }
  }

  async function refreshSheet() {
    countNode.textContent = String(selected.size);
    if (selected.size === 0) {
      sheetData = { total: 0, cards: [] };
    } else {
      const ids = [...selected].sort((a, b) => a - b).join(',');
      sheetData = await api(`/api/print?ids=${ids}`);
    }
    renderPreview(sheetData);
    if (titleNode) titleNode.textContent = `A4 预览 · ${sheetData.total} 张卡片`;
  }

  function syncBoxes() {
    for (const box of candidatesBox.querySelectorAll('input[type="checkbox"]')) {
      box.checked = selected.has(Number(box.dataset.id));
    }
  }

  async function withRefresh(fn) {
    fn();
    try {
      await refreshSheet();
    } catch (error) {
      notify(`没能刷新预览：${error.message}`, 'error');
    }
  }

  actionsBox.replaceChildren(
    button('只留今日复习', {
      variant: 'primary',
      onClick: () => withRefresh(() => {
        selected.clear();
        for (const id of todayIds) selected.add(id);
        syncBoxes();
      }),
    }),
    button('清空选题', {
      variant: 'ghost',
      onClick: () => withRefresh(() => {
        selected.clear();
        syncBoxes();
      }),
    }),
    button('打印 / 另存 PDF', { variant: 'secondary', onClick: printSheet }),
  );

  const candidateRows = [];
  candidatesBox.replaceChildren();
  for (const item of pool.items) {
    const id = Number(item.id);
    const row = el('div', 'row');
    const box = el('input', 'checkbox');
    box.type = 'checkbox';
    box.id = `print-pick-${id}`;
    box.dataset.id = String(id);
    box.checked = selected.has(id);
    const searchable = `${item.prompt || ''} ${item.unit_title || ''} ${SUBJECT_LABEL[item.subject] || ''}`.toLowerCase();
    const label = el('label', '', `${SUBJECT_LABEL[item.subject] || item.subject} · ${STATUS_LABEL[item.status] || item.status} · ${(item.prompt || '（题干待补）').slice(0, 40)}`);
    label.htmlFor = box.id;
    box.addEventListener('change', () => withRefresh(() => {
      if (box.checked) selected.add(id);
      else selected.delete(id);
    }));
    row.append(box, label, el('span', 'small muted', item.next_review ? `到期 ${item.next_review}` : ''));
    candidatesBox.append(row);
    candidateRows.push({ node: row, searchable });
  }
  if (candidateRows.length === 0) {
    candidatesBox.append(empty('题库还是空的', '先去识别收件箱收一道题。'));
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      for (const { node, searchable } of candidateRows) {
        node.style.display = !query || searchable.includes(query) ? '' : 'none';
      }
    });
  }

  root.replaceChildren(alert('上面的勾选只改这一份预览；点「打印」出来的就是下面这块，学生版不含答案与引导提示。', 'info'));
  await refreshSheet();
}
