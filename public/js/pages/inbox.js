// 识别收件箱：左看原图（带相对坐标识别框），右逐题核对草稿。
// 红线：AI 只把字填进草稿；任何入库动作都必须由老师点确认，走 commit 接口。
import { el, card, stateTag, button, empty, alert, toast, link } from '../ui.js';
import { guard } from '../errors.js';

const SUBJECTS = [['', '请选择科目'], ['math', '数学'], ['chinese', '语文'], ['english', '英语']];
const STATUS_LABEL = { pending: '待确认', committed: '已入库', discarded: '已丢弃' };
const FIELD_CONF = {
  prompt: 'prompt',
  student_answer_draft: 'student_answer',
  subject: 'subject_hint',
  options: 'options',
  question_type: 'question_type',
  knowledge_hint: 'knowledge_hint',
  figure_desc: 'figure_desc',
  bbox: 'bbox',
};
const FIELDS = [
  ['prompt', '题干（必填）', 'textarea'],
  ['subject', '科目（必填）', 'select'],
  ['question_type', '题型', 'input'],
  ['knowledge_hint', '知识点', 'input'],
  ['student_answer_draft', '照片上的学生答案（草稿）', 'input'],
  ['options', '选项（逗号分隔）', 'input'],
  ['figure_desc', '图形或表格描述', 'input'],
];

function isUncertain(draft, field) {
  const key = FIELD_CONF[field];
  if (!key) return false;
  if ((draft.uncertain || []).includes(key)) return true;
  const score = (draft.confidence || {})[key];
  return typeof score === 'number' && score > 0 && score < 0.6;
}

function confidenceMark(draft) {
  const low = Object.keys(FIELD_CONF).some((field) => isUncertain(draft, field));
  const level = low ? 'confidence--low' : 'confidence--high';
  const box = el('span', `confidence ${level}`);
  box.append(el('span', 'confidence__dot'), el('span', '', low ? '请核对 / 请手填' : 'AI 起草'));
  return box;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取照片失败'));
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

export async function mount({ root, api, state }) {
  const input = document.getElementById('inbox-file');
  const image = document.getElementById('inbox-image');
  const bboxes = document.getElementById('inbox-bboxes');
  const draftsBox = document.getElementById('inbox-drafts');
  const picker = document.getElementById('inbox-job-picker');
  const manualButton = document.getElementById('inbox-manual');
  let jobs = [];
  let currentId = null;
  const inFlight = new Set();
  const queueBox = document.getElementById('inbox-queue');
  // 多张照片共用一个队列：files 待传，total/done/ok 计进度，failed 记失败的。
  const queue = { files: [], total: 0, done: 0, ok: 0, pending: 0, failed: [] };
  let pumping = false;

  root.replaceChildren(alert(state.aiEnabled
    ? 'AI 识别已开启。识别结果只写进草稿，逐题确认后才成为错题。'
    : 'AI 当前关闭，照片不会离开这台设备。上传后会出现一张空白草稿，手填即可入库。',
  state.aiEnabled ? 'info' : 'warn'));

  function notify(message, kind = 'info') {
    toast(message, kind === 'error' ? 'error' : 'info');
    root.replaceChildren(alert(message, kind));
  }

  function makeControl(draft, field, kind) {
    const low = isUncertain(draft, field);
    let control;
    if (kind === 'textarea') {
      control = el('textarea', 'textarea');
      control.rows = 3;
    } else if (kind === 'select') {
      control = el('select', 'select');
      for (const [value, label] of SUBJECTS) {
        const option = el('option', '', label);
        option.value = value;
        control.append(option);
      }
    } else {
      control = el('input', 'input');
      control.type = 'text';
    }
    control.id = `f-${draft.id}-${field}`;
    control.dataset.field = field;
    const raw = field === 'options' && Array.isArray(draft.options) ? draft.options.join('、') : draft[field];
    if (low) control.value = '';
    else control.value = raw ?? '';
    if (low) control.setAttribute('aria-invalid', 'true');
    if (draft.status !== 'pending') control.disabled = true;
    return control;
  }

  function collectEdits(box, draft) {
    const body = {};
    for (const control of box.querySelectorAll('[data-field]')) {
      const field = control.dataset.field;
      if (field === 'options') {
        body.options = control.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      } else if (field === 'subject') {
        body.subject = control.value || null;
      } else {
        body[field] = control.value;
      }
      if (isUncertain(draft, field)) control.setAttribute('aria-invalid', control.value ? 'false' : 'true');
    }
    return body;
  }

  async function saveDraft(draft, box) {
    try {
      await api(`/api/recognition-drafts/${draft.id}`, { method: 'PATCH', body: collectEdits(box, draft) });
      notify('修改已保存，确认后才会入库。');
    } catch (error) {
      notify(`保存失败：${error.message}`, 'error');
    }
  }

  async function commitDraft(draft, box, resultBox) {
    if (inFlight.has(draft.id)) {
      notify('这道题正在提交，请稍候，不会重复入库。', 'warn');
      return;
    }
    inFlight.add(draft.id);
    const buttons = [...box.querySelectorAll('button')];
    for (const control of buttons) control.disabled = true;
    try {
      const edits = collectEdits(box, draft);
      await api(`/api/recognition-drafts/${draft.id}`, { method: 'PATCH', body: edits });
      const result = await api(`/api/recognition-drafts/${draft.id}/commit`, { method: 'POST' });
      resultBox.replaceChildren(
        el('span', 'draft-result', result.idempotent ? `已入库，无需重复确认 · 第 ${result.mistakeId} 题` : `入库成功 · 第 ${result.mistakeId} 题`),
        link('看这道题 →', `/mistake/${result.mistakeId}`, 'small'),
      );
      notify(`第 ${result.mistakeId} 题已入库，状态为待诊断。`);
    } catch (error) {
      resultBox.replaceChildren(el('span', 'field__error', `${error.message}（可修改后重试）`));
      notify(`确认失败：${error.message}，按钮已恢复，可重试。`, 'error');
    } finally {
      inFlight.delete(draft.id);
      for (const control of buttons) control.disabled = false;
    }
  }

  // 拆分：在题干里选中要拆出去的一段文字，拆成另一题。
  // 先把当前编辑存回去，再按选区拆——否则服务端看到的还是旧题干，选区下标会对不上。
  async function splitDraft(draft, box) {
    const control = box.querySelector(`#f-${draft.id}-prompt`);
    if (!control) {
      notify('找不到题干输入框，无法拆分。', 'error');
      return;
    }
    const start = control.selectionStart;
    const end = control.selectionEnd;
    if (start === end) {
      notify('先在题干里选中要拆出去的一段文字，再点「拆成另一题」。', 'warn');
      return;
    }
    try {
      await api(`/api/recognition-drafts/${draft.id}`, { method: 'PATCH', body: { prompt: control.value } });
      const result = await api(`/api/recognition-drafts/${draft.id}/split`, {
        method: 'POST', body: { start, end },
      });
      notify(`已拆成两题：第 ${result.first.seq} 题与第 ${result.second.seq} 题，都还要你确认才入库。`);
      await refresh();
      const target = document.getElementById(`draft-${result.second.id}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.focus();
      }
    } catch (error) {
      notify(`拆分失败：${error.message}`, 'error');
    }
  }

  // 新增一条空白草稿：老师手写一道题，不必等 AI 识别。
  async function addDraft() {
    if (!currentId) {
      notify('先上传一张照片，再新增草稿。', 'warn');
      return;
    }
    try {
      const result = await api('/api/recognition-drafts', { method: 'POST', body: { jobId: currentId } });
      notify('已新增一条空白草稿，填完照常确认入库。');
      await refresh();
      const target = document.getElementById(`draft-${result.draft.id}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.focus();
      }
    } catch (error) {
      notify(`新增失败：${error.message}`, 'error');
    }
  }

  async function retryFailed(ids) {
    if (!ids.length) return;
    try {
      const result = await api('/api/recognition-drafts/batch-commit', { method: 'POST', body: { ids } });
      const stillFailed = result.results.filter((item) => !item.ok);
      notify(stillFailed.length
        ? `重试后新入库 ${result.committed} 题，仍有 ${stillFailed.length} 题需补充信息。`
        : `重试完成，新入库 ${result.committed} 题。`);
      await refresh();
    } catch (error) {
      notify(`重试失败：${error.message}，可逐题再试。`, 'error');
    }
  }

  async function discardDraft(draft) {
    try {
      await api(`/api/recognition-drafts/${draft.id}`, { method: 'DELETE' });
      notify('草稿已丢弃，原图仍保留。');
      await refresh();
    } catch (error) {
      notify(`丢弃失败：${error.message}`, 'error');
    }
  }

  async function mergeDrafts(draft, box) {
    const index = currentDrafts().findIndex((item) => item.id === draft.id);
    const next = currentDrafts()[index + 1];
    if (!next || next.status !== 'pending') {
      notify('下面没有可合并的待确认草稿。', 'warn');
      return;
    }
    const merged = [draft.prompt, next.prompt].filter(Boolean).join('\n');
    try {
      await api(`/api/recognition-drafts/${draft.id}`, { method: 'PATCH', body: { prompt: merged } });
      await api(`/api/recognition-drafts/${next.id}`, { method: 'DELETE' });
      notify('两条草稿已合并，请核对后再确认。');
      await refresh();
    } catch (error) {
      notify(`合并失败：${error.message}`, 'error');
    }
  }

  // 人工重试：把失败任务排回队列，重新走一遍识别。
  // 识别结果仍然只进草稿，老师照样要逐题确认——重试不等于自动入库。
  async function retryJob(job) {
    try {
      await api(`/api/recognitions/${job.id}/retry`, { method: 'POST' });
      notify(`照片 #${job.id} 已重新排队，识别出来后照样要你逐题确认。`);
      await refresh();
    } catch (error) {
      notify(`没能重试：${error.message}`, 'error');
      await refresh();
    }
  }

  async function cropAndRetry(draft) {
    if (!Array.isArray(draft.bbox) || !image.naturalWidth) {
      notify('这道题没有可用的识别框，请改用手工录入。', 'warn');
      return;
    }
    const [x1, y1, x2, y2] = draft.bbox;
    const sx = Math.round(x1 * image.naturalWidth);
    const sy = Math.round(y1 * image.naturalHeight);
    const sw = Math.max(1, Math.round((x2 - x1) * image.naturalWidth));
    const sh = Math.max(1, Math.round((y2 - y1) * image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const cropped = canvas.toDataURL('image/jpeg', 0.82);
    try {
      const created = await api('/api/recognitions', { method: 'POST', body: { image: cropped, derived: cropped } });
      notify(`已按识别框建新任务 #${created.jobId}，稍后刷新查看。`);
      currentId = created.jobId;
      await refresh();
    } catch (error) {
      notify(`重识别失败：${error.message}，可继续手工录入。`, 'error');
    }
  }

  let drafts = [];
  const currentDrafts = () => drafts;

  // 识别框可拖动：按住框拖动即可改它的位置，松手才写回一次。
  // 只平移不改大小——老师要修正的是「框歪了」，不是「框画小了」。
  function startDrag(event, draft, box) {
    const rect = bboxes.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const [x1, y1, x2, y2] = draft.bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    const startX = event.clientX;
    const startY = event.clientY;
    let next = [x1, y1, x2, y2];

    const paint = () => {
      box.style.left = `${next[0] * 100}%`;
      box.style.top = `${next[1] * 100}%`;
      box.style.width = `${(next[2] - next[0]) * 100}%`;
      box.style.height = `${(next[3] - next[1]) * 100}%`;
    };

    const onMove = (moveEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      // 夹紧在 0–1 内，保证 x2>x1、y2>y1 恒成立，不会拖出非法框。
      const nx = Math.min(Math.max(0, x1 + dx), 1 - w);
      const ny = Math.min(Math.max(0, y1 + dy), 1 - h);
      next = [nx, ny, nx + w, ny + h];
      paint();
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      box.classList.remove('is-dragging');
      const moved = next.some((value, index) => value !== draft.bbox[index]);
      if (!moved) return;
      try {
        await api(`/api/recognition-drafts/${draft.id}`, { method: 'PATCH', body: { bbox: next } });
        draft.bbox = next;
        notify('识别框已挪到新位置。');
      } catch (error) {
        notify(`挪框没成功：${error.message}`, 'error');
        paint();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function renderBboxes(items) {
    bboxes.replaceChildren();
    for (const draft of items) {
      if (!Array.isArray(draft.bbox) || draft.bbox.length !== 4) continue;
      const [x1, y1, x2, y2] = draft.bbox;
      const box = el('div', 'bbox');
      box.style.left = `${x1 * 100}%`;
      box.style.top = `${y1 * 100}%`;
      box.style.width = `${(x2 - x1) * 100}%`;
      box.style.height = `${(y2 - y1) * 100}%`;
      box.append(el('span', 'bbox__label', `第 ${draft.seq} 题`));
      box.addEventListener('click', () => {
        const target = document.getElementById(`draft-${draft.id}`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.focus();
        for (const other of draftsBox.querySelectorAll('.card')) other.classList.remove('is-focused');
        target.classList.add('is-focused');
      });
      // 框上的删除入口：AI 画错了框，删掉它（连同这条草稿）。
      const remove = button('×', { variant: 'danger', onClick: () => discardDraft(draft) });
      remove.classList.add('bbox__remove');
      remove.setAttribute('aria-label', `删除第 ${draft.seq} 题的识别框与草稿`);
      box.append(remove);
      // 拖动把手：只有把手能拖，避免和「点框定位草稿」打架。
      const handle = el('span', 'bbox__handle');
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        box.classList.add('is-dragging');
        startDrag(event, draft, box);
      });
      box.append(handle);
      bboxes.append(box);
    }
  }

  function renderDraft(draft) {
    const box = card(`第 ${draft.seq} 题`, { actions: [stateTag(draft.status, STATUS_LABEL[draft.status] || draft.status), confidenceMark(draft)] });
    const form = el('div', 'stack');
    for (const [field, label, kind] of FIELDS) {
      const fieldBox = el('div', 'field');
      const labelNode = el('label', '', label + (isUncertain(draft, field) ? ' · 请手填' : ''));
      labelNode.htmlFor = `f-${draft.id}-${field}`;
      fieldBox.append(labelNode, makeControl(draft, field, kind));
      if (isUncertain(draft, field)) fieldBox.append(el('p', 'field__hint', 'AI 没把握，字段已留空，请老师手填后再确认。'));
      form.append(fieldBox);
    }
    box.body.append(form);

    if (draft.correct_answer_draft) {
      box.body.append(alert('模型给出的参考答案不会被采纳，也不会进学生版打印纸。', 'warn'));
    }
    const resultBox = el('div', 'row');
    if (draft.status === 'committed' && draft.mistake_id) {
      resultBox.append(el('span', 'draft-result', `已入库 · 第 ${draft.mistake_id} 题`), link('看这道题 →', `/mistake/${draft.mistake_id}`, 'small'));
    }
    box.body.append(resultBox);

    if (draft.status === 'pending') {
      const actions = el('div', 'row');
      actions.append(
        button('保存修改', { variant: 'ghost', onClick: () => saveDraft(draft, box.body) }),
        button('确认入库', { variant: 'primary', onClick: () => commitDraft(draft, box.body, resultBox) }),
        button('裁剪重识别', { variant: 'ghost', onClick: () => cropAndRetry(draft) }),
        button('合并下一条', { variant: 'ghost', onClick: () => mergeDrafts(draft, box.body) }),
        button('拆成另一题', { variant: 'ghost', onClick: () => splitDraft(draft, box.body) }),
        button('丢弃', { variant: 'danger', onClick: () => discardDraft(draft) }),
      );
      box.body.append(actions);
    }
    box.node.id = `draft-${draft.id}`;
    box.node.tabIndex = -1;
    return box.node;
  }

  function renderJobPicker() {
    picker.replaceChildren();
    for (const job of jobs.slice(0, 8)) {
      const mark = job.id === currentId ? ' [当前]' : '';
      picker.append(button(`照片 #${job.id}${mark}`, {
        variant: job.id === currentId ? 'primary' : 'ghost',
        // 切换照片是 async：失败时没人接，界面就停在旧照片上，像没点过（#58）。
        onClick: guard(async () => { currentId = job.id; await refresh(); }, { notify }),
      }));
    }
  }

  function renderJob(job) {
    image.src = `/${job.image_path}`;
    image.alt = `照片 #${job.id} 的原图`;
    image.hidden = false;
    drafts = job.drafts || [];
    renderBboxes(drafts);
    draftsBox.replaceChildren();
    if (drafts.length === 0) {
      draftsBox.append(empty('这张照片还没有草稿', '识别进行中，或点「改为手工录入」补一张空白表单。'));
      return;
    }
    const head = el('div', 'row');
    head.append(el('h2', '', `待核对 ${drafts.filter((d) => d.status === 'pending').length} 题`));
    head.append(button('全部确认', { variant: 'primary', onClick: batchCommit }));
    head.append(button('新增一条草稿', { variant: 'ghost', onClick: addDraft }));
    draftsBox.append(head);
    for (const draft of drafts) draftsBox.append(renderDraft(draft));
  }

  async function batchCommit() {
    const ids = drafts.filter((d) => d.status === 'pending').map((d) => d.id);
    if (ids.length === 0) { notify('没有待确认的草稿。', 'warn'); return; }
    try {
      const result = await api('/api/recognition-drafts/batch-commit', { method: 'POST', body: { ids } });
      const failed = result.results.filter((r) => !r.ok);
      notify(failed.length
        ? `已入库 ${result.committed} 题，${failed.length} 题需补充信息后重试。`
        : `已入库 ${result.committed} 题。`);
      if (failed.length) {
        const failedIds = failed.map((item) => item.id);
        root.append(button(`重试未成功的 ${failed.length} 题`, {
          variant: 'ghost', onClick: () => retryFailed(failedIds),
        }));
      }
      await refresh();
    } catch (error) {
      notify(`批量确认失败：${error.message}，可逐题重试。`, 'error');
    }
  }

  async function refresh() {
    const data = await api('/api/recognitions');
    jobs = data.items || [];
    if (!currentId && jobs.length) currentId = jobs[0].id;
    renderJobPicker();
    const job = jobs.find((item) => item.id === currentId);
    if (!job) {
      bboxes.replaceChildren();
      draftsBox.replaceChildren(empty('还没有照片', '先拍一张卷子，或直接手工录入一道题。'));
      image.hidden = true;
      return;
    }
    renderJob(job);
    if (job.status === 'failed') {
      // 失败不是死路：重试与手工录入是两条并行的路（AI 规格 failed → queued，人工重试）。
      const box = el('div', 'stack');
      // 人工重试最多 2 次（规格第 86 行）。用满之后按钮置灰而不是消失：
      // 消失会让老师以为界面坏了，置灰 + 说明才告诉他「这条路走到头了，换手工录入」。
      const used = Number(job.manual_retries) || 0;
      const limit = Number(job.manual_retry_limit) || 2;
      const exhausted = used >= limit;
      const usedText = used > 0 ? `（已重试 ${used} 次，上限 ${limit} 次）` : '';
      box.append(alert(
        `识别失败（${job.error_code || '未知原因'}）。原图仍在这里：可以重试识别，也可以改为手工录入。${usedText}`,
        'warn',
      ));
      box.append(button(exhausted ? `已重试 ${used} 次，不能再重试` : '重试识别', {
        variant: 'primary',
        disabled: exhausted,
        onClick: () => retryJob(job),
      }));
      root.replaceChildren(box);
    }
  }

  // 单张收件：只负责把这张照片送进收件箱，失败由调用方决定怎么处理。
  async function submitImage(file) {
    const original = await readFileAsDataUrl(file);
    const derived = await compressImage(original);
    const created = await api('/api/recognitions', {
      method: 'POST',
      body: { image: original, derived: derived || null },
    });
    return created;
  }

  // 队列进度：已收件 N / 共 M 张，失败的几张单独点名。
  function renderQueue() {
    if (!queueBox) return;
    if (!queue.total) {
      queueBox.replaceChildren();
      return;
    }
    const parts = [`已收件 ${queue.done} / 共 ${queue.total} 张`];
    if (queue.failed.length) parts.push(`${queue.failed.length} 张失败`);
    if (queue.pending) parts.push(`排队中 ${queue.pending} 张`);
    queueBox.replaceChildren(el('span', 'small muted', parts.join(' · ')));
  }

  // 多张照片排队：一次多选或连续拍都进同一个队列，逐张上传。
  // 一张失败不拖累其余——失败的张单独记下来，其余照常收件。
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.files.length) {
      const file = queue.files.shift();
      queue.pending = queue.files.length;
      renderQueue();
      try {
        const created = await submitImage(file);
        currentId = created.jobId;
        queue.ok += 1;
      } catch (error) {
        queue.failed.push(file.name || '未命名文件');
      }
      queue.done += 1;
      renderQueue();
    }
    queue.pending = 0;
    pumping = false;
    renderQueue();
    await refresh();
    const failed = queue.failed.length;
    notify(
      `本批收件 ${queue.ok} 张${failed ? `，${failed} 张失败（${queue.failed.join('、')}）` : ''}。`
      + (state.aiEnabled ? '识别在后台进行，稍后自动刷新。' : 'AI 未启用，已生成空白草稿。'),
      failed ? 'warn' : 'info',
    );
    if (state.aiEnabled) {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const detail = await api(`/api/recognitions/${currentId}`);
        if (['done', 'partial', 'failed'].includes(detail.job.status)) { await refresh(); break; }
      }
    }
  }

  function enqueueFiles(fileList) {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    queue.files.push(...picked);
    queue.total += picked.length;
    renderQueue();
    void pump();
  }

  input.addEventListener('change', (event) => {
    const picked = event.target.files;
    enqueueFiles(picked);
    // 清空：否则同一批文件再选一次，value 没变就不会触发 change。
    input.value = '';
  });
  manualButton.addEventListener('click', () => {
    const first = draftsBox.querySelector('.card');
    if (first) { first.scrollIntoView({ behavior: 'smooth' }); first.querySelector('textarea')?.focus(); }
    else notify('请先上传照片，系统会立即给一张空白草稿。', 'warn');
  });
  await refresh();
}
