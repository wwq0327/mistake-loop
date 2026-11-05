// 题目详情：一道题的一生。五态进度、缺口提示、四个关联列表、诊断闸门。
// 红线：学生结论由老师记录，系统不代填；结论为空时界面禁止推进到「纠错中」。
import { el, stateTag, alert, empty, link, button, toast } from '../ui.js';
import { describeError } from '../api.js';
import { mistakeIdFromLocation } from '../store.js';

const STEPS = ['待诊断', '诊断中', '纠错中', '复习中', '已掌握'];
const STEP_KEYS = ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered'];
const STATUS_INDEX = { new: 0, diagnosing: 1, correcting: 2, reviewing: 3, mastered: 4 };
const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const LEVELS = ['surface', 'structure', 'context'];
const LEVEL_LABEL = { surface: '换数字（表面）', structure: '换角度（结构）', context: '换场景（情境）' };
const CATEGORY_LABEL = {
  conceptual: '概念不清', procedural: '步骤出错', metacognitive: '策略习惯', factual: '知识遗忘',
};

// 允许做诊断的状态白名单的本地兜底。
// 事实源在服务端（src/state-machine.mjs 的 DIAGNOSABLE_STATUSES，通过 /api/meta 下发），
// 这份只在 /api/meta 拿不到时顶上。两处必须一致——
// test/detail-action-gate.test.mjs 锁住这一点，免得日后只改一处。
export const DIAGNOSABLE_FALLBACK = ['new', 'diagnosing', 'correcting'];

// 不能诊断时要说清为什么，而不是光把按钮藏起来。
const NOT_DIAGNOSABLE_HINT = {
  reviewing: '这题已经在「复习中」了，不能再退回纠错中——要改错因，先看复习留痕。',
  mastered: '这题已经「已掌握」，不能再退回纠错中：推回去会把掌握成果作废。',
};

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

// 五种状态各有一件「现在就该做的事」，别让老师自己在整页里找（#62）。
// 复习中的入口指回看板：真正登记做对做错在那边，本页只留复习留痕。
const NEXT_ACTION = {
  new: { key: 'diagnose', label: '去记诊断与错因', target: 'detail-diagnosis', focus: '#detail-category' },
  diagnosing: { key: 'conclusion', label: '记录学生说出的结论', target: 'detail-diagnosis', focus: '#detail-conclusion' },
  correcting: { key: 'variants', label: '去审核三层变式', target: 'detail-variants', focus: '#detail-variants input' },
  reviewing: { key: 'review', label: '去今日复习', href: '/' },
  mastered: { key: 'evidence', label: '回看掌握证据', target: 'detail-evidence' },
};

// 非表单元素默认不可聚焦，补个 tabindex 才真的能把焦点交过去（键盘用户受益）。
const FOCUSABLE = ['input', 'select', 'textarea', 'button', 'a'];

function focusTarget(node) {
  if (!node || typeof node.focus !== 'function') return;
  if (!FOCUSABLE.includes(node.localName) && !node.hasAttribute?.('tabindex')) {
    node.setAttribute?.('tabindex', '-1');
  }
  node.focus();
}

function goTo({ target, focus }) {
  const section = target ? document.getElementById(target) : null;
  section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  const node = focus ? document.querySelector(focus) : section;
  focusTarget(node);
}

function renderNextAction({ item, stageLabel, requirement }) {
  const host = document.querySelector('#detail-next .card__body');
  if (!host) return;
  host.replaceChildren();

  host.append(el('p', 'detail-next__stage', `当前阶段：${stageLabel}`));
  host.append(el('p', 'detail-next__why', requirement));

  const action = NEXT_ACTION[item.status];
  const row = el('div', 'row');
  if (action) {
    if (action.href) {
      // 类名必须是设计系统里的 .btn：写成 .button 会渲染成一条普通链接，
      // 首屏那个「主入口」在视觉上就消失了（#65 回读时发现）。
      row.append(link(`${action.label} →`, action.href, 'btn btn--primary'));
    } else {
      row.append(button(action.label, {
        variant: 'primary',
        onClick: () => goTo(action),
      }));
    }
    const node = row.firstChild;
    node.setAttribute?.('data-next-action', action.key);
  }
  // 返回看板不需要在这里再来一遍：页头右上角已经有一个常驻入口（#65 回读时去重）。
  host.append(row);
}

export async function mount({ root, api }) {
  const id = mistakeIdFromLocation();
  if (!id) {
    root.replaceChildren(empty('没有指定题号', '从题库或今日复习里点一道题进来。'), link('去题库 →', '/library', 'small'));
    return;
  }

  // 首屏统一由 #detail-next 回答「现在该做什么」，旧横幅不再重复同一句话；
  // 加载与失败也放这块——它在页面顶部，老师第一眼就能看见，
  // 而不是落在页面最底下的 #view 里（#62）。
  const gate = document.getElementById('detail-gate');
  if (gate) gate.hidden = true;

  const notice = (nodes) => {
    const host = document.querySelector('#detail-next .card__body');
    if (host) { host.replaceChildren(...nodes); return; }
    root.replaceChildren(...nodes);
  };

  // 先把「正在读」画出来：一片空白会让人以为页面坏了，等待本身需要被看见。
  notice([el('p', 'detail-next__stage', '正在读取这道题…')]);

  let item;
  try {
    item = await api(`/api/mistakes/${id}`);
  } catch (error) {
    notice([
      alert(`第 ${id} 题没读到：${describeError(error)}`, 'error'),
      button('重试', { variant: 'secondary', onClick: () => { mount({ root, api }); } }),
    ]);
    root.replaceChildren();
    return;
  }
  // 出题方向与错因子字典的唯一事实源在服务端 /api/meta，前端不写死。
  const meta = await api('/api/meta').catch(() => null);
  const index = STATUS_INDEX[item.status] ?? 0;

  // 五态：当前态高亮，之前的态标已完成。
  for (const [i, key] of STEP_KEYS.entries()) {
    const node = document.querySelector(`[data-step="${key}"]`);
    if (!node) continue;
    node.className = i < index ? 'is-done' : i === index ? 'is-current' : '';
    node.textContent = STEPS[i];
  }
  // 首屏先回答「现在该做什么」，具体材料都在下面各区块里（#62）。
  renderNextAction({ item, stageLabel: STEPS[index], requirement: nextRequirement(item) });
  root.replaceChildren(el('div', 'row', `第 ${item.id} 题 · ${SUBJECT_LABEL[item.subject] || item.subject}`));
  const statusTag = stateTag(item.status, STEPS[index]);
  root.firstChild.append(statusTag);

  // 原题与教材定位。
  // 原图节点就长在这个 card__body 里，replaceChildren() 会把它一起清掉——
  // 先取出来再放回去。否则紧接着的 getElementById 拿到 null，
  // 整页从这里往后（教材定位、诊断、变式、留痕、证据）全都渲染不出来。
  const basics = bodyOf('detail-basics');
  const image = document.getElementById('detail-image') ?? el('img', 'qcard__figure');
  image.id = 'detail-image';
  basics.replaceChildren();
  basics.append(el('div', 'qcard__prompt', item.prompt || '（题干待补）'));
  if (item.image_path) {
    image.src = `/${item.image_path}`;
    image.alt = `第 ${item.id} 题原图`;
    image.hidden = false;
  } else image.hidden = true;
  basics.append(image);
  const facts = el('div', 'row');
  facts.append(
    el('span', 'small muted', `教材定位：${item.unit_title || item.lesson_title || '待补'}`),
    el('span', 'small muted', `版本：${item.edition || '按旧库骨架'}`),
    el('span', 'small muted', `册次：${item.grade ?? 4} 年级第 ${item.semester ?? 1} 册`),
    el('span', 'small muted', `错因：${item.error_category ? (CATEGORY_LABEL[item.error_category] ?? item.error_category) : '待归类'}`),
    el('span', 'small muted', `子类型：${item.error_subtype || '待归类'}`),
    el('span', 'small muted', `复习轮次：${item.review_round ?? 0}`),
    el('span', 'small muted', `下次复习：${item.next_review || '未排期'}`),
  );
  basics.append(facts);

  // 诊断与学生结论闸门
  const diagnosis = bodyOf('detail-diagnosis');
  diagnosis.replaceChildren();
  diagnosis.append(el('p', 'small', `学生自己说出的关键结论：${item.student_conclusion || '（尚未填写）'}`));

  // 错因录入：大类、分类按科目分列，选项取自服务端字典，前端不硬编码。
  const categories = meta?.categories ?? ['conceptual', 'procedural', 'metacognitive', 'factual'];
  const subtypes = meta?.errorSubtypes?.[item.subject] ?? {};
  const unclassified = meta?.unclassified ?? '待归类';

  // 状态闸门：只有白名单里的状态能记错因、才能推进到「纠错中」。
  // 后端 PATCH /mistakes/:id/diagnosis 是同一个接口、同一条断言，
  // 界面先把话说清楚，别让老师去撞那个 409（#57）。
  const diagnosable = meta?.diagnosableStatuses ?? DIAGNOSABLE_FALLBACK;
  const canDiagnose = diagnosable.includes(item.status);
  const notDiagnosableHint = NOT_DIAGNOSABLE_HINT[item.status]
    ?? '这道题已不在诊断阶段，不能再记错因或推进状态。';

  const categoryField = el('div', 'field');
  const categoryLabelEl = el('label', '', '错因大类');
  categoryLabelEl.htmlFor = 'detail-category';
  const categorySelect = el('select', 'select');
  categorySelect.id = 'detail-category';
  const categoryBlank = el('option', '', '未选');
  categoryBlank.value = '';
  categorySelect.append(categoryBlank);
  for (const category of categories) {
    const option = el('option', '', CATEGORY_LABEL[category] ?? category);
    option.value = category;
    if (category === item.error_category) option.selected = true;
    categorySelect.append(option);
  }
  categoryField.append(categoryLabelEl, categorySelect);

  const subtypeField = el('div', 'field');
  const subtypeLabelEl = el('label', '', '错因子类型');
  subtypeLabelEl.htmlFor = 'detail-subtype';
  const subtypeSelect = el('select', 'select');
  subtypeSelect.id = 'detail-subtype';
  // 子类跟着大类走；没定大类时只剩「待归类」，与后端校验口径一致。
  const fillSubtypes = (category) => {
    subtypeSelect.replaceChildren();
    const blank = el('option', '', '未选');
    blank.value = '';
    subtypeSelect.append(blank);
    const list = category ? [...(subtypes[category] ?? []), unclassified] : [unclassified];
    for (const value of list) {
      const option = el('option', '', value);
      option.value = value;
      if (value === item.error_subtype) option.selected = true;
      subtypeSelect.append(option);
    }
  };
  fillSubtypes(item.error_category);
  categorySelect.addEventListener('change', () => fillSubtypes(categorySelect.value));
  subtypeField.append(subtypeLabelEl, subtypeSelect);

  const reasonField = el('div', 'field');
  const reasonLabelEl = el('label', '', '错因说明：这题卡在哪（一次只问学生一个点）');
  reasonLabelEl.htmlFor = 'detail-reason';
  const reasonInput = el('textarea', 'textarea');
  reasonInput.id = 'detail-reason';
  reasonInput.rows = 2;
  reasonInput.value = item.error_reason || '';
  reasonField.append(reasonLabelEl, reasonInput);

  // 只送改动过的错因字段，避免只记结论时把已录的错因清空。
  const causePayload = () => {
    const payload = {};
    const category = categorySelect.value;
    const subtype = subtypeSelect.value;
    const reason = reasonInput.value.trim();
    if (category !== (item.error_category ?? '')) payload.error_category = category || null;
    if (subtype !== (item.error_subtype ?? '')) payload.error_subtype = subtype || null;
    if (reason !== String(item.error_reason ?? '').trim()) payload.error_reason = reason || null;
    return payload;
  };

  const saveCause = button('只保存错因', {
    variant: 'secondary',
    onClick: async () => {
      const payload = causePayload();
      if (!Object.keys(payload).length) {
        toast('错因没有改动。');
        return;
      }
      try {
        await api(`/api/mistakes/${id}/diagnosis`, { method: 'PATCH', body: payload });
        toast('错因已保存。');
        await mount({ root, api });
      } catch (error) {
        toast(`没能保存错因：${error.message}`, 'error');
      }
    },
  });
  diagnosis.append(categoryField, subtypeField, reasonField);
  const causeRow = el('div', 'row');
  if (canDiagnose) {
    causeRow.append(saveCause, el('span', 'field__hint', '错因按科目分列：语文只收已验证过的子类，英语先留「待归类」。'));
  } else {
    causeRow.append(el('span', 'field__hint', notDiagnosableHint));
  }
  diagnosis.append(causeRow);

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
          body: { status: 'correcting', student_conclusion: conclusionInput.value, ...causePayload() },
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
  if (canDiagnose) {
    gateRow.append(advance, el('span', 'field__hint', '结论为空则不能进入纠错中；先让学生自己说出来，老师再记录。'));
  } else {
    gateRow.append(el('span', 'field__hint', notDiagnosableHint));
  }
  diagnosis.append(gateRow);

  // 三层变式审核 + 录入。
  // 录入入口是闭环的关键一环：状态机要求三层全部审核通过才进「复习中」，
  // 界面若只能审核不能录入，老师就永远走不到复习。
  // 变式审核的闸门与后端一致：只有「诊断中」与「纠错中」能审核。
  // 不是这两个状态就不给审核按钮——给了也只会被后端 409 拒回来。
  const REVIEW_FROM = ['diagnosing', 'correcting'];
  const canReview = REVIEW_FROM.includes(item.status);

  const variants = bodyOf('detail-variants');
  variants.replaceChildren();
  if (!item.variants?.length) {
    variants.append(empty('还没有变式', '每题补三条：换数字、换角度、换场景。补完逐条审核，三层都通过才进入复习。'));
  }
  if (!canReview && (item.variants || []).some((v) => !v.reviewed)) {
    variants.append(el('p', 'field__hint', '变式审核要在「诊断中」或「纠错中」进行。先完成诊断、把题推进到能审核的状态，才能审核三层变式。'));
  }
  const rules = meta?.variantRules?.[item.subject] ?? {};
  const existing = new Map((item.variants || []).map((v) => [v.level, v]));
  for (const level of LEVELS) {
    const found = existing.get(level);
    if (found) {
      const row = el('div', 'row');
      row.append(
        el('span', 'small', LEVEL_LABEL[level]),
        el('span', 'grow small', found.prompt || '（待补）'),
        el('span', 'small muted', found.reviewed ? `已审核 · ${found.result || ''}` : '待审核'),
      );
      if (!found.reviewed && canReview) {
        row.append(button('审核通过', {
          variant: 'ghost',
          onClick: async () => {
            try {
              await api(`/api/variants/${found.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
              toast('变式已审核，生效并进入打印范围。');
              await mount({ root, api });
            } catch (error) { toast(`审核失败：${error.message}`, 'error'); }
          },
        }));
      }
      variants.append(row);
      continue;
    }

    // 还没录这一层：给一个录入框。方向提示只给教师看，不上学生版打印页。
    const box = el('div', 'stack');
    const promptField = el('div', 'field');
    const promptLabel = el('label', '', `${LEVEL_LABEL[level]}变式的题干`);
    promptLabel.htmlFor = `variant-prompt-${level}`;
    const promptInput = el('input', 'input');
    promptInput.id = `variant-prompt-${level}`;
    promptInput.type = 'text';
    promptInput.placeholder = '例：把数字换掉，题型与解法不变';
    promptField.append(promptLabel, promptInput);

    const answerField = el('div', 'field');
    const answerLabel = el('label', '', `${LEVEL_LABEL[level]}变式的参考答案`);
    answerLabel.htmlFor = `variant-answer-${level}`;
    const answerInput = el('input', 'input');
    answerInput.id = `variant-answer-${level}`;
    answerInput.type = 'text';
    answerInput.placeholder = '只有老师看得到';
    answerField.append(answerLabel, answerInput);

    const submit = button(`补这一层：${LEVEL_LABEL[level]}`, {
      variant: 'secondary',
      onClick: async () => {
        const prompt = promptInput.value.trim();
        if (!prompt) {
          toast('先写一句变式题干。', 'error');
          return;
        }
        try {
          await api(`/api/mistakes/${id}/variants`, {
            method: 'POST',
            body: { variants: [{ level, prompt, correct_answer: answerInput.value.trim() || null }] },
          });
          toast('已录入这一层变式，审核通过后才生效。');
          await mount({ root, api });
        } catch (error) {
          toast(`没能录入变式：${error.message}`, 'error');
        }
      },
    });

    box.append(promptField, answerField, submit);
    if (rules[level]) box.append(el('p', 'field__hint', `出题方向：${rules[level]}`));
    variants.append(box);
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
