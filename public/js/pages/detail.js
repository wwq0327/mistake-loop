// 题目详情：一道题的一生。五态进度、原图、变式、复习历史、掌握证据。
import { el, card, stateTag, progress, alert, empty, link } from '../ui.js';
import { mistakeIdFromLocation } from '../store.js';

const STEPS = ['待诊断', '诊断中', '纠错中', '复习中', '已掌握'];
const STATUS_INDEX = { new: 0, diagnosing: 1, correcting: 2, reviewing: 3, mastered: 4 };
const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };

export async function mount({ root, api }) {
  const id = mistakeIdFromLocation();
  if (!id) {
    root.replaceChildren(empty('没有指定题号', '从题库或今日复习里点一道题进来。'), link('去题库 →', '/library', 'small'));
    return;
  }

  const item = await api(`/api/mistakes/${id}`);
  const index = STATUS_INDEX[item.status] ?? 0;

  const head = card(`第 ${item.id} 题 · ${SUBJECT_LABEL[item.subject] || item.subject}`, {
    actions: [stateTag(item.status, STEPS[index])],
  });
  head.body.append(progress(STEPS, index));
  head.body.append(el('div', 'qcard__prompt', item.prompt || '（题干待补）'));
  if (item.image_path) {
    const img = el('img', 'qcard__figure');
    img.src = `/${item.image_path}`;
    img.alt = '错题原图';
    head.body.append(img);
  }
  const facts = el('div', 'row');
  facts.append(
    el('span', 'small muted', `教材定位：${item.unit_title || '待补'}`),
    el('span', 'small muted', `错因：${item.error_type || item.category || '待归类'}`),
    el('span', 'small muted', `复习轮次：${item.review_round ?? 0}`),
    el('span', 'small muted', `下次复习：${item.next_review || '未排期'}`),
  );
  head.body.append(facts);
  head.body.append(el('p', 'small muted', '学生自己说出的关键结论：' + (item.student_conclusion || '（尚未填写）')));

  const variants = card(`三层变式 · ${item.variants.length} 条`);
  if (item.variants.length === 0) variants.body.append(empty('还没有变式', '变式需老师审核后才生效、才上打印纸。'));
  else for (const v of item.variants) {
    variants.body.append(el('p', 'small', `${v.level} · ${v.reviewed ? '已审核' : '待审核'}：${v.prompt || '（待补）'}`));
  }

  const history = card(`复习留痕 · ${item.review_events.length} 次`);
  if (item.review_events.length === 0) history.body.append(el('p', 'muted small', '暂无复习记录。'));
  else for (const e of item.review_events.slice(-8)) {
    history.body.append(el('p', 'small', `${e.created_at || ''} · 第 ${e.round} 轮 · ${e.result}`));
  }

  const evidence = card(`掌握证据 · ${item.mastery_evidence.length} 条`);
  if (item.mastery_evidence.length === 0) evidence.body.append(alert('进入第 4 轮前，必须有学生自己的证据，不能由系统代填。', 'warn'));
  else for (const e of item.mastery_evidence) {
    evidence.body.append(el('p', 'small', `${e.kind}：${e.note || ''}`));
  }

  root.replaceChildren(head, variants, history, evidence);
}
