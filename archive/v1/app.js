const page = document.body.dataset.page;

const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
const LEVEL_LABEL = { surface: '换数字（表面）', structure: '换角度（结构）', context: '换场景（情境）' };
const EVIDENCE_LABEL = {
  retell: '复述',
  same_structure_variant: '同结构变式',
  spaced_recall: '间隔提取',
  self_check_method: '说出检查方法',
  teach_others: '讲给别人听',
};

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch { /* 非 JSON 响应按空对象处理 */ }
  if (!response.ok) throw new Error(data?.error?.message || `请求失败（${response.status}）`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

let toastTimer;
function toast(message, ok = true) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.className = `toast no-print show ${ok ? 'ok' : 'err'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast no-print'; }, 3500);
}

function imageNode(path) {
  if (!path) return null;
  const img = el('img', 'question-image');
  img.src = `/${path}`;
  img.alt = '错题照片';
  img.loading = 'lazy';
  return img;
}

// ---------- 今日复习 ----------

function renderStats(stats) {
  const box = document.getElementById('stats');
  const cells = [
    ['错题总数', stats.total],
    ['今日逾期', stats.overdue],
    ['复习中', stats.byStatus.reviewing],
    ['已掌握', stats.byStatus.mastered],
    ['待补教材定位', stats.awaitingTextbookRef],
  ];
  box.replaceChildren(...cells.map(([label, value]) => {
    const cell = el('div', 'stat');
    cell.append(el('strong', null, value), el('span', null, label));
    return cell;
  }));
}

async function submitResult(id, result, evidenceType) {
  try {
    const body = { result };
    if (evidenceType) body.evidence_type = evidenceType;
    const out = await api(`/api/reviews/${id}/result`, { method: 'POST', body });
    const message = out.status === 'mastered'
      ? '已有掌握证据，判定为已掌握'
      : result === 'correct'
        ? `已记录做对，下次复习 ${out.next_review}`
        : '已记录做错，打回诊断、轮次归零';
    toast(message);
    await initToday();
  } catch (err) {
    toast(err.message, false);
  }
}

function renderToday(items) {
  const list = document.getElementById('today-list');
  list.replaceChildren();
  document.getElementById('today-count').textContent = items.length;
  if (!items.length) {
    list.append(el('p', 'empty', '今天没有到期的题。系统仍会每天自动检查。'));
    return;
  }
  for (const item of items) {
    const card = el('article', 'card');
    const overdue = item.overdue_days > 0 ? `逾期 ${item.overdue_days} 天` : '今天到期';
    card.append(el('div', 'meta-line', `#${item.id} · ${SUBJECT_LABEL[item.subject]} · 第 ${item.review_round} 轮 · ${overdue}`));
    card.append(el('p', 'prompt', item.prompt));
    const img = imageNode(item.image_path);
    if (img) card.append(img);

    const controls = el('div', 'controls no-print');
    const select = el('select', 'evidence');
    select.append(new Option('本次不补掌握证据', ''));
    for (const [kind, label] of Object.entries(EVIDENCE_LABEL)) {
      select.append(new Option(label, kind));
    }
    const good = el('button', 'btn', '做对');
    const bad = el('button', 'btn btn-danger', '做错');
    good.type = 'button';
    bad.type = 'button';
    good.addEventListener('click', () => submitResult(item.id, 'correct', select.value));
    bad.addEventListener('click', () => submitResult(item.id, 'wrong', null));
    controls.append(select, good, bad);
    card.append(controls);
    list.append(card);
  }
}

function renderPending(items) {
  const box = document.getElementById('pending-list');
  box.replaceChildren();
  document.getElementById('pending-count').textContent = items.length;
  if (!items.length) {
    box.append(el('p', 'empty', '没有待审核的变式。'));
    return;
  }
  for (const item of items) {
    const row = el('div', 'pending-row');
    row.append(el('span', 'tag', `#${item.mistake_id} · ${SUBJECT_LABEL[item.subject]} · ${LEVEL_LABEL[item.level]}`));
    row.append(el('p', 'pending-prompt', item.prompt.slice(0, 100)));
    const actions = el('div', 'controls');
    for (const [label, result] of [['通过', 'pass'], ['未通过', 'fail']]) {
      const btn = el('button', result === 'pass' ? 'btn btn-small' : 'btn btn-small btn-danger', label);
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/variants/${item.id}/review`, { method: 'PATCH', body: { result } });
          toast('审核已记录');
          await initToday();
        } catch (err) { toast(err.message, false); }
      });
      actions.append(btn);
    }
    row.append(actions);
    box.append(row);
  }
}

async function initToday() {
  const [meta, today] = await Promise.all([api('/api/meta'), api('/api/reviews/today')]);
  document.getElementById('date-label').textContent = `${meta.today} · 数字全部实时从数据库统计`;
  renderStats(meta.stats);
  renderPending(meta.pendingVariants);
  renderToday(today.items);
}

// ---------- 录入 ----------

function fillNodes(nodes) {
  const subject = document.getElementById('f-subject').value;
  const select = document.getElementById('f-node');
  const previous = select.value;
  select.replaceChildren(new Option('暂不指定', ''));
  for (const node of nodes.filter((n) => n.subject === subject)) {
    const term = node.semester === 1 ? '上' : '下';
    select.append(new Option(`${node.edition} ${node.grade}年级${term}册 · 第${node.unit_no}单元 ${node.unit_title}`, String(node.id)));
  }
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

function fillSubtypes(dict) {
  const subject = document.getElementById('f-subject').value;
  const datalist = document.getElementById('subtype-options');
  datalist.replaceChildren();
  for (const list of Object.values(dict[subject] || {})) {
    for (const subtype of list) datalist.append(el('option', null, subtype));
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function clearAfterSave() {
  for (const id of ['f-prompt', 'f-student-answer', 'f-correct-answer', 'f-conclusion', 'f-diagnosis', 'f-subtype', 'f-image']) {
    document.getElementById(id).value = '';
  }
  for (const area of document.querySelectorAll('[data-level]')) area.value = '';
}

async function submitCapture(advance) {
  const val = (id) => document.getElementById(id).value.trim();
  const prompt = val('f-prompt');
  if (!prompt) { toast('题干必填', false); return; }
  const conclusion = val('f-conclusion');
  if (advance && !conclusion) { toast('学生没说出关键结论，不能进入纠错中', false); return; }

  const file = document.getElementById('f-image').files[0];
  let image = null;
  try { if (file) image = await readImage(file); } catch (err) { toast(err.message, false); return; }

  const nodeId = document.getElementById('f-node').value;
  const payload = {
    subject: document.getElementById('f-subject').value,
    prompt,
    student_answer: val('f-student-answer') || null,
    correct_answer: val('f-correct-answer') || null,
    lesson_title: val('f-lesson') || null,
    page_no: val('f-page') || null,
    textbook_node_id: nodeId ? Number(nodeId) : null,
    image,
  };
  try {
    const created = await api('/api/mistakes', { method: 'POST', body: payload });
    await api(`/api/mistakes/${created.id}/diagnosis`, {
      method: 'PATCH',
      body: {
        error_category: document.getElementById('f-category').value || null,
        error_subtype: val('f-subtype') || null,
        diagnosis_note: val('f-diagnosis') || null,
        student_conclusion: conclusion || null,
        status: advance ? 'correcting' : 'diagnosing',
      },
    });
    const variants = [...document.querySelectorAll('[data-level]')]
      .map((area) => ({ level: area.dataset.level, prompt: area.value.trim() }))
      .filter((v) => v.prompt);
    if (variants.length) {
      await api(`/api/mistakes/${created.id}/variants`, { method: 'POST', body: { variants } });
    }
    const counter = document.getElementById('batch-count');
    counter.textContent = Number(counter.textContent) + 1;
    clearAfterSave();
    toast(`已录入 #${created.id}${variants.length ? `，${variants.length} 道变式待审核` : ''}，可继续录下一题`);
  } catch (err) {
    toast(err.message, false);
  }
}

async function initCapture() {
  const meta = await api('/api/meta');
  fillNodes(meta.textbookNodes);
  fillSubtypes(meta.errorSubtypes);
  document.getElementById('f-subject').addEventListener('change', () => {
    fillNodes(meta.textbookNodes);
    fillSubtypes(meta.errorSubtypes);
  });
  document.getElementById('capture-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCapture(false);
  });
  document.getElementById('f-advance').addEventListener('click', () => submitCapture(true));
}

// ---------- 打印 ----------

function selectedIds() {
  return [...document.querySelectorAll('#choose-list input:checked')].map((box) => Number(box.value));
}

function updateSelectedCount() {
  document.getElementById('selected-count').textContent = selectedIds().length;
}

function renderCards(cards) {
  const area = document.getElementById('print-area');
  area.replaceChildren();
  cards.forEach((card, index) => {
    const box = el('article', 'print-card');
    const head = `第 ${index + 1} 题 · ${SUBJECT_LABEL[card.subject]}${card.unit_title ? ` · ${card.unit_title}` : ''}`;
    box.append(el('div', 'print-head', head));
    box.append(el('p', 'print-prompt', card.prompt));
    const img = imageNode(card.image_path);
    if (img) { img.className = 'print-image'; box.append(img); }
    if (card.geometry_svg) {
      const holder = el('div', 'print-geometry');
      holder.innerHTML = card.geometry_svg; // 服务端生成且已转义，不含用户输入原文
      box.append(holder);
    }
    if (card.variants.length) {
      box.append(el('h3', null, '变式练习'));
      const list = el('ol', 'variant-list');
      for (const variant of card.variants) {
        const li = el('li');
        li.append(el('span', 'variant-tag', LEVEL_LABEL[variant.level]), el('p', null, variant.prompt));
        list.append(li);
      }
      box.append(list);
    }
    box.append(el('div', 'answer-title', '作答区'));
    for (let i = 0; i < 3; i += 1) box.append(el('div', 'answer-line'));
    area.append(box);
  });
}

async function initPrint() {
  const data = await api('/api/mistakes');
  const box = document.getElementById('choose-list');
  const candidates = data.items.filter((item) => item.status !== 'new');
  box.replaceChildren();
  if (!candidates.length) {
    box.append(el('p', 'empty', '还没有可打印的题。先到「录入」页添加，并审核变式。'));
  }
  for (const item of candidates) {
    const label = el('label', 'check-row');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(item.id);
    checkbox.addEventListener('change', updateSelectedCount);
    label.append(checkbox, el('span', null, `#${item.id} · ${SUBJECT_LABEL[item.subject]} · ${item.prompt.slice(0, 50)}`));
    box.append(label);
  }
  document.getElementById('select-all').addEventListener('click', () => {
    const boxes = [...document.querySelectorAll('#choose-list input[type="checkbox"]')];
    const target = boxes.some((b) => !b.checked);
    for (const b of boxes) b.checked = target;
    updateSelectedCount();
  });
  document.getElementById('build').addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) { toast('请先勾选题目', false); return; }
    try {
      const result = await api(`/api/print?ids=${ids.join(',')}`);
      renderCards(result.cards);
      toast(`已生成 ${result.total} 张 A4 卡片，点「打印」出纸`);
    } catch (err) { toast(err.message, false); }
  });
  document.getElementById('do-print').addEventListener('click', () => window.print());
}

try {
  if (page === 'today') await initToday();
  else if (page === 'capture') await initCapture();
  else if (page === 'print') await initPrint();
} catch (err) {
  toast(err.message, false);
}
