// 工作台：只回答「今天该做什么」，四个数字都能直接点到对应动作。
import { el, card, stat, stateTag, link, skeleton, alert, button } from '../ui.js';

const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const STATUS_LABEL = { new: '待诊断', diagnosing: '诊断中', correcting: '纠错中', reviewing: '复习中', mastered: '已掌握' };

export async function mount({ root, api, state }) {
  root.replaceChildren(skeleton(4));
  const [meta, reviews] = await Promise.all([api('/api/meta'), api('/api/reviews/today')]);
  const s = meta.stats;

  const grid = el('div', 'grid grid--stats');
  grid.append(
    stat(state.pendingDrafts || 0, '待确认识别草稿', '/inbox'),
    stat(reviews.total, '今日该复习', '/print'),
    stat(s.overdue, '逾期未练', '/print'),
    stat(s.awaitingTextbookRef, '待补教材定位', '/library'),
  );

  const actions = el('div', 'row');
  actions.append(
    button('收一道新题', { variant: 'primary', onClick: () => { location.href = '/inbox'; } }),
    button('出今日练习纸', { variant: 'secondary', onClick: () => { location.href = '/print'; } }),
    button('翻题库', { variant: 'ghost', onClick: () => { location.href = '/library'; } }),
  );

  const todayCard = card(`今日复习 · ${reviews.date}`, { actions: [link('去打印 →', '/print', 'small')] });
  if (reviews.items.length === 0) {
    todayCard.body.append(alert('今天没有到期的题。逾期不会自动清零，到期了就会出现在这里。', 'info'));
  } else {
    const list = el('div', 'stack');
    for (const item of reviews.items.slice(0, 12)) {
      const row = el('div', 'row');
      row.append(
        stateTag('reviewing', STATUS_LABEL.reviewing),
        el('span', 'small muted', `${SUBJECT_LABEL[item.subject] || item.subject} · 第 ${item.review_round} 轮`),
        link(item.prompt?.slice(0, 44) || `第 ${item.id} 题`, `/mistake/${item.id}`, 'grow'),
        el('span', 'small', item.overdue_days > 0 ? `逾期 ${item.overdue_days} 天` : '今天到期'),
      );
      list.append(row);
    }
    todayCard.body.append(list);
  }

  const pendingCard = card('待审核变式');
  if (meta.pendingVariants.length === 0) {
    pendingCard.body.append(el('p', 'muted small', '暂无待审核变式。'));
  } else {
    for (const item of meta.pendingVariants.slice(0, 8)) {
      pendingCard.body.append(el('p', 'small', `#${item.mistake_id} ${item.level}：${item.prompt?.slice(0, 50) || '（待补题干）'}`));
    }
  }

  root.replaceChildren(grid, actions, todayCard, pendingCard);
}
