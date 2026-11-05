// 打印：默认带今日复习，可增删；预览与出纸共用同一份题卡数据。
// 学生版字段白名单在这里收口：答案、学生作答、诊断记录与引导提示永不落纸。
import { el, button, empty, alert, questionCard, toast } from '../ui.js';
import { describeError } from '../api.js';

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
  // previewIds：当前屏幕上的预览对应哪几道题。
  // 它只在取数成功时更新——取数失败就保持上一份，屏幕上的计数与预览始终是一对。
  let previewIds = [];

  // 屏幕上的预览是不是还在对应当前选题。
  // 对不上就说明预览已过期：这时印出来的是旧题，不能放行。
  function previewMatchesSelection() {
    const wanted = [...selected].sort((a, b) => a - b);
    if (wanted.length !== previewIds.length) return false;
    return wanted.every((id, i) => id === previewIds[i]);
  }

  function renderPreview(sheet, expired = false) {
    previewBox.replaceChildren();
    if (expired) {
      previewBox.append(alert(
        `预览没更新成功：下面还是上一次的 ${sheet.cards.length} 张卡片，跟当前选题对不上。`
        + '打印已锁住，刷新成功才能印。',
        'error',
      ));
    }
    if (!sheet.cards || sheet.cards.length === 0) {
      previewBox.append(empty('没有可打印的题', '今天没有到期的复习题，也可以在上面勾选几道。'));
      return;
    }
    for (const item of sheet.cards) {
      previewBox.append(questionCard(pickStudentFields(item), { withLines: true }));
    }
  }

  // 把当前状态一次性画到屏幕上：计数、预览、标题、打印按钮同步更新。
  // 计数直接取自预览里的卡片数，所以「计数」与「预览」在结构上就不可能对不上。
  function paint() {
    const expired = !previewMatchesSelection();
    countNode.textContent = String(sheetData.cards.length);
    if (titleNode) {
      titleNode.textContent = expired
        ? `A4 预览 · 未更新（还是上一次的 ${sheetData.cards.length} 张）`
        : `A4 预览 · ${sheetData.total} 张卡片`;
    }
    renderPreview(sheetData, expired);
    printBtn.disabled = expired;
    printNote.textContent = expired ? '预览没更新成功，先别印：刷新成功才能印。' : '';
  }

  async function refreshSheet() {
    const wanted = [...selected].sort((a, b) => a - b);
    try {
      // 先取数，取成了才换预览：中间不会出现「计数是新的、预览还是旧的」。
      const next = wanted.length
        ? await api(`/api/print?ids=${wanted.join(',')}`)
        : { total: 0, cards: [] };
      sheetData = next;
      previewIds = wanted;
    } catch (error) {
      // 取数失败：sheetData 与 previewIds 保持上一份，屏幕上的计数与预览仍然是一对。
      // 真正要拦的是「印出旧题」——paint() 会把打印按钮锁住。
      notify(`没能刷新预览：${describeError(error)}`, 'error');
    }
    paint();
  }

  function syncBoxes() {
    for (const box of candidatesBox.querySelectorAll('input[type="checkbox"]')) {
      box.checked = selected.has(Number(box.dataset.id));
    }
  }

  async function withRefresh(fn) {
    fn();
    await refreshSheet();
  }

  // 出纸前再核一次：屏幕上的预览必须还对应当前选题，对不上就不印。
  function printSheet() {
    if (!previewMatchesSelection()) {
      notify('预览和当前选题对不上，先把预览刷新成功再印。', 'error');
      return;
    }
    window.print();
  }

  const printBtn = button('打印 / 另存 PDF', { variant: 'secondary', onClick: printSheet });
  const printNote = el('span', 'small muted', '');
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
    printBtn,
    printNote,
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
