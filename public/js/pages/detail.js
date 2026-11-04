// 题目详情：一道题的一生。五态进度、缺口提示、四个关联列表、诊断闸门。
// 红线：学生结论由老师记录，系统不代填；结论为空时界面禁止推进到「纠错中」。
import { el, stateTag, alert, empty, link, button, toast } from '../ui.js';
import { mistakeIdFromLocation } from '../store.js';

const STEPS = ['待诊断', '诊断中', '纠错中', '复习中', '已掌握'];
const STEP_KEYS = ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered'];
const STATUS_INDEX = { new: 0, diagnosing: 1, correcting: 2, reviewing: 3, mastered: 4 };
const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const LEVEL_LABEL = { surface: '换数字（表面）', structure: '换角度（结构）', context: '换场景（情境）' };

function nextRequirement(item) {
  const evidenceCount = item.mastery_evidence?.length ?? 0;
  const conclusion = String(item.student_conclusion || '').trim();
  if (item.status === 'new') return '还差：老师完成诊断并记下错因，才能进入「诊断中」。';
  if (item.status === 'diagnosing' && !conclusion) return '还差：学生自己说出的关键结论。没填之前不能进入「纠错中」，系统不会代填。';
  if (item.status === 'diagnosing') return '还差：确认学生结论后，才能推进到「纠错中」。';
  if (item.status === 'correcting') {
    const pending = (item.variants || []).filter((v) => !v.reviewed).length;
    return pending ? `还差：${pending} 条变式未经老师审核，审核通过后才进入复习。` : '还差：三层变式审核全部通过后，才能进入复习。';
  }
  if (item.status === 'reviewing') {
    if ((item.review_round ?? 0) < 4) return `还差：第 ${4 - (item.review_round ?? 0)} 轮复习，按 1-3-7-30 节奏推进。`;
    if (!evidenceCount) return '还差：第 4 轮之后还需一条学生自己的掌握证据（复述 / 同结构变式 / 间隔提取 / 说出检查方法 / 讲给别人听）。';
  }
  return '已掌握。复习留痕与掌握证据仍会完整保留，随时可回看。';
}

function bodyOf(id) {
  return document.querySelector(`#${id} .card__body`);
}

export async function mount({ root, api }) {
  const id = mistakeIdFromLocation();
  if (!id) {
    root.replaceChildren(empty('没有指定题号', '从题库或今日复习里点一道题进来。'), link('去题库 →', '/library', 'small'));
    return;
  }

  const item = await api(`/api/mistakes/${id}`);
  const index = STATUS_INDEX[item.status] ?? 0;
  const gate = document.getElementById('detail-gate');

  // 五态：当前态高亮，之前的态标已完成。
  for (const [i, key] of STEP_KEYS.entries()) {
    const node = document.querySelector(`[data-step="${key}"]`);
    if (!node) continue;
    node.className = i < index ? 'is-done' : i === index ? 'is-current' : '';
    node.textContent = STEPS[i];
  }
  gate.textContent = `当前：${STEPS[index]}。${nextRequirement(item)}`;
  gate.className = item.status === 'mastered' ? 'alert alert--info' : 'alert alert--warn';
  root.replaceChildren(el('div', 'row', `第 ${item.id} 题 · ${SUBJECT_LABEL[item.subject] || item.subject}`));
  const statusTag = stateTag(item.status, STEPS[index]);
  root.firstChild.append(statusTag);

  // 原题与教材定位
  const basics = bodyOf('detail-basics');
  basics.replaceChildren();
  basics.append(el('div', 'qcard__prompt', item.prompt || '（题干待补）'));
  const image = document.getElementById('detail-image');
  if (item.image_path) {
    image.src = `/${item.image_path}`;
    image.alt = `第 ${item.id} 题原图`;
    image.hidden = false;
  } else image.hidden = true;
  const facts = el('div', 'row');
  facts.append(
    el('span', 'small muted', `教材定位：${item.unit_title || item.lesson_title || '待补'}`),
    el('span', 'small muted', `版本：${item.edition || '按旧库骨架'}`),
    el('span', 'small muted', `册次：${item.grade ?? 4} 年级第 ${item.semester ?? 1} 册`),
    el('span', 'small muted', `错因：${item.error_category || '待归类'}`),
    el('span', 'small muted', `复习轮次：${item.review_round ?? 0}`),
    el('span', 'small muted', `下次复习：${item.next_review || '未排期'}`),
  );
  basics.append(facts);

  // 诊断与学生结论闸门
  const diagnosis = bodyOf('detail-diagnosis');
  diagnosis.replaceChildren();
  diagnosis.append(el('p', 'small', `学生自己说出的关键结论：${item.student_conclusion || '（尚未填写）'}`));
  const conclusionField = el('div', 'field');
  const label = el('label', '', '记录学生说出的关键结论（不能由系统代填）');
  label.htmlFor = 'detail-conclusion';
  const conclusionInput = el('textarea', 'textarea');
  conclusionInput.id = 'detail-conclusion';
  conclusionInput.rows = 2;
  conclusionInput.value = item.student_conclusion || '';
  conclusionField.append(label, conclusionInput);
  diagnosis.append(conclusionField);

  const gateRow = el('div', 'row');
  const advance = button('保存并进入纠错中', {
    variant: 'primary',
    onClick: async () => {
      try {
        await api(`/api/mistakes/${id}/diagnosis`, {
          method: 'PATCH',
          body: { status: 'correcting', student_conclusion: conclusionInput.value },
        });
        toast('已保存学生结论并进入纠错中。');
        await mount({ root, api });
      } catch (error) {
        toast(`未能推进：${error.message}`, 'error');
      }
    },
  });
  // 结论为空时按钮不可用；后端 409 是同一条闸门的第二道。
  if (!String(item.student_conclusion || '').trim()) advance.disabled = true;
  conclusionInput.addEventListener('input', () => {
    advance.disabled = !conclusionInput.value.trim();
  });
  gateRow.append(advance, el('span', 'field__hint', '结论为空则不能进入纠错中；先让学生自己说出来，老师再记录。'));
  diagnosis.append(gateRow);

  // 三层变式审核
  const variants = bodyOf('detail-variants');
  variants.replaceChildren();
  if (!item.variants?.length) variants.append(empty('还没有变式', '变式需老师审核后才生效、才上打印纸。'));
  for (const v of item.variants) {
    const row = el('div', 'row');
    row.append(
      el('span', 'small', `${LEVEL_LABEL[v.level] || v.level}`),
      el('span', 'grow small', v.prompt || '（待补）'),
      el('span', 'small muted', v.reviewed ? `已审核 · ${v.result || ''}` : '待审核'),
    );
    if (!v.reviewed) {
      row.append(button('审核通过', {
        variant: 'ghost',
        onClick: async () => {
          try {
            await api(`/api/variants/${v.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
            toast('变式已审核，生效并进入打印范围。');
            await mount({ root, api });
          } catch (error) { toast(`审核失败：${error.message}`, 'error'); }
        },
      }));
    }
    variants.append(row);
  }

  // 复习事件 + 调度会话留痕
  const reviews = bodyOf('detail-reviews');
  reviews.replaceChildren();
  if (!item.review_events?.length && !item.sessions?.length) reviews.append(el('p', 'muted small', '暂无复习与调度留痕。'));
  for (const e of item.review_events || []) {
    reviews.append(el('p', 'small', `${e.created_at || e.reviewed_at || ''} · 第 ${e.round ?? '-'} 轮 · ${e.result || ''}`));
  }
  for (const s of item.sessions || []) {
    reviews.append(el('p', 'small muted', `调度：${s.kind} · ${s.due_on || ''}`));
  }

  // 掌握证据
  const evidence = bodyOf('detail-evidence');
  evidence.replaceChildren();
  if (!item.mastery_evidence?.length) {
    evidence.append(alert('还差：进入已掌握前必须有学生自己的证据，不能由系统代填。', 'warn'));
  } else {
    for (const e of item.mastery_evidence) {
      evidence.append(el('p', 'small', `${e.kind}：${e.note || ''}`));
    }
  }
}
