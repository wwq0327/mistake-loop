// 打印：默认带今日复习，学生版永不出现答案与引导提示。
import { el, card, button, empty, alert, questionCard } from '../ui.js';

export async function mount({ root, api }) {
  root.replaceChildren(alert('预览区就是最终出纸内容。每张卡片不跨页断题，答案与引导提示不进学生版。', 'info'));

  const actions = el('div', 'row');
  actions.append(
    button('全选今日复习', { variant: 'primary', onClick: () => location.reload() }),
    button('打印 / 另存 PDF', { variant: 'secondary', onClick: () => window.print() }),
  );

  const data = await api('/api/print');
  const preview = card(`A4 预览 · ${data.total} 张卡片`);
  if (data.cards.length === 0) {
    preview.body.append(empty('没有可打印的题', '今日复习为空时，先去收件箱录一道题。'));
  } else {
    for (const item of data.cards) preview.body.append(questionCard(item, { withLines: true }));
  }

  root.replaceChildren(actions, preview);
}
