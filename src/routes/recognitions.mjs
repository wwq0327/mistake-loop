// 识别收件箱路由：上传建 job、任务与草稿查询、人工改草稿、软丢弃、重试。
// 红线：AI 结果只落在 recognition_drafts，只有 #15 的 commit 接口能写 mistakes。
import { Router } from 'express';
import { saveRecognitionPair } from '../lib/images.mjs';
import { withTransaction } from '../db.mjs';
import { EDITIONS } from '../lib/subjects.mjs';
import { SUBJECTS } from '../state-machine.mjs';
import { ensureManualDraft } from '../ai/jobs.mjs';
import { checkId, checkText, checkSubject, notFound, conflict, ValidationError } from '../lib/validation.mjs';
import { nowIso, today } from '../lib/dates.mjs';

const TEXT_FIELDS = {
  prompt: 2000,
  student_answer_draft: 500,
  correct_answer_draft: 500,
  question_type: 500,
  knowledge_hint: 500,
  figure_desc: 500,
};

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicJob(row) {
  return {
    id: row.id,
    image_path: row.image_path,
    status: row.status,
    provider: row.provider,
    model: row.model,
    attempts: row.attempts,
    error_code: row.error_code,
    token_estimate: row.token_estimate,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

// 明确不回 raw_excerpt（上游原文摘要）、不回图片 base64、不回任何密钥。
function publicDraft(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    seq: row.seq,
    bbox: parseJson(row.bbox, null),
    subject: row.subject,
    prompt: row.prompt,
    options: parseJson(row.options, []),
    student_answer_draft: row.student_answer_draft,
    correct_answer_draft: row.correct_answer_draft,
    question_type: row.question_type,
    knowledge_hint: row.knowledge_hint,
    has_figure: row.has_figure,
    figure_desc: row.figure_desc,
    confidence: parseJson(row.confidence, {}),
    uncertain: parseJson(row.uncertain, []),
    status: row.status,
    mistake_id: row.mistake_id,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function withDrafts(db, jobRows) {
  const stmt = db.prepare('SELECT * FROM recognition_drafts WHERE job_id = ? ORDER BY seq');
  return jobRows.map((job) => ({ ...publicJob(job), drafts: stmt.all(job.id).map(publicDraft) }));
}

// 唯一允许 AI 草稿变成错题的地方：老师点确认才调用。
// 事务内插 mistakes(status='new') 并回写 draft.mistake_id；重复确认幂等。
// 教学法红线：correct_answer / student_conclusion 永不来自草稿，掌握证据与复习事件一概不写。
function commitDraft(db, id, overrides = {}) {
  const draft = db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
  if (!draft) notFound('草稿不存在');
  if (draft.status === 'committed' && draft.mistake_id) {
    const existing = db.prepare('SELECT id FROM mistakes WHERE id = ?').get(draft.mistake_id);
    if (existing) return { idempotent: true, mistakeId: existing.id, status: 200 };
  }
  if (draft.status !== 'pending') conflict('该草稿已处理，不能重复入库');

  const subject = overrides.subject ?? draft.subject;
  if (!SUBJECTS.includes(subject)) {
    throw new ValidationError('请先选定科目再确认入库', 'SUBJECT_REQUIRED');
  }
  const prompt = String(overrides.prompt ?? draft.prompt ?? '').trim();
  if (!prompt) {
    throw new ValidationError('题干为空，AI 没把握的字段请手填后再确认', 'PROMPT_REQUIRED');
  }
  if (prompt.length > 2000) throw new ValidationError('题干超过 2000 字', 'TOO_LONG');

  const job = db.prepare('SELECT image_path FROM recognition_jobs WHERE id = ?').get(draft.job_id);
  const student = db.prepare('SELECT id FROM students ORDER BY id LIMIT 1').get();
  const now = nowIso();
  const mistakeId = withTransaction(db, () => {
    const info = db.prepare(`
      INSERT INTO mistakes (
        student_id, subject, edition, grade, semester, question_type, prompt,
        student_answer, image_path, recognition_draft_id, status, review_round,
        needs_textbook_ref, created_at, updated_at
      ) VALUES (?, ?, ?, 4, 1, ?, ?, ?, ?, ?, 'new', 0, 1, ?, ?)
    `).run(
      student?.id ?? null,
      subject,
      EDITIONS[subject],
      draft.question_type,
      prompt,
      draft.student_answer_draft || null,
      job?.image_path ?? null,
      id,
      now,
      now,
    );
    const newId = Number(info.lastInsertRowid);
    db.prepare("UPDATE recognition_drafts SET status = 'committed', mistake_id = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'")
      .run(newId, now, id);
    return newId;
  });
  return { idempotent: false, mistakeId, status: 201 };
}

// 拆分一条草稿：AI 把一题切成两半时，老师在题干里选中要拆出去的那一段，掰成两题。
// 教学法红线：拆分只改草稿，绝不写 mistakes；两条都仍是草稿，入库仍需逐题确认。
// seq 有 UNIQUE(job_id, seq) 约束：新草稿紧跟原草稿，后续草稿整体后移。
function splitDraft(db, id, start, end) {
  const draft = db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
  if (!draft) notFound('草稿不存在');
  if (draft.status !== 'pending') conflict('只对待确认草稿可拆分');
  const prompt = String(draft.prompt ?? '');
  if (!prompt.trim()) {
    throw new ValidationError('题干为空，没有可拆的内容', 'PROMPT_EMPTY');
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end > prompt.length || start >= end) {
    throw new ValidationError('请先在题干里选中要拆出去的一段文字', 'SPLIT_RANGE_INVALID');
  }
  // 拆出去的是选中段，留在原草稿的是其余部分（去掉选段，不是从中间一刀两断）。
  const picked = prompt.slice(start, end);
  const kept = prompt.slice(0, start) + prompt.slice(end);
  if (!picked.trim()) {
    throw new ValidationError('选中的部分没有内容，换一处再试', 'SPLIT_RANGE_INVALID');
  }
  if (!kept.trim()) {
    throw new ValidationError('整段题干都被选中了，拆出去就没有剩下的题了', 'SPLIT_RANGE_INVALID');
  }

  const now = nowIso();
  const newId = withTransaction(db, () => {
    // 后面的草稿先整体让位：UNIQUE(job_id, seq) 是逐行检查的，直接 seq+1 会当场撞号，
    // 所以先推到远离原区间的高位，再整体回落 1 格。
    db.prepare('UPDATE recognition_drafts SET seq = seq + 10000 WHERE job_id = ? AND seq > ?').run(draft.job_id, draft.seq);
    db.prepare('UPDATE recognition_drafts SET seq = seq - 9999 WHERE job_id = ? AND seq > ?').run(draft.job_id, draft.seq);
    db.prepare('UPDATE recognition_drafts SET prompt = ?, reviewed_at = ? WHERE id = ?').run(kept, now, id);
    // 拆出来的那条不画框：选中的文字与原框的对应关系不可靠，硬画会框错位置。
    const info = db.prepare(`INSERT INTO recognition_drafts
      (job_id, seq, bbox, subject, prompt, options, student_answer_draft, correct_answer_draft,
       question_type, knowledge_hint, has_figure, figure_desc, confidence, uncertain, raw_excerpt, status, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(
        draft.job_id, draft.seq + 1,
        draft.subject, picked, draft.options, draft.student_answer_draft, draft.correct_answer_draft,
        draft.question_type, draft.knowledge_hint, draft.has_figure, draft.figure_desc,
        draft.confidence, draft.uncertain, draft.raw_excerpt, now,
      );
    return Number(info.lastInsertRowid);
  });

  return {
    first: publicDraft(db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id)),
    second: publicDraft(db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(newId)),
  };
}

// 状态接口只回非敏感聚合数据；密钥、端点、模型名、上游响应一概不出服务端。
function fallbackAiStatus(db, worker) {
  const startIso = new Date(`${today()}T00:00:00+08:00`).toISOString();
  return {
    enabled: Boolean(worker?.aiEnabled),
    configured: Boolean(worker?.aiEnabled),
    todayUsed: db.prepare('SELECT COUNT(*) c FROM recognition_jobs WHERE attempts > 0 AND created_at >= ?').get(startIso).c,
    dailyLimit: 30,
    lastError: worker?.state?.lastError ?? null,
    pendingDrafts: db.prepare("SELECT COUNT(*) c FROM recognition_drafts WHERE status = 'pending'").get().c,
  };
}

export function createRecognitionsRouter({ db, dataDir, worker = null, aiStatus = null }) {
  const router = Router();

  router.post('/recognitions', (req, res) => {
    const { image, derived = null, hint = '' } = req.body ?? {};
    const pair = saveRecognitionPair({ original: image, derived, sharedBasename: true }, dataDir);
    const info = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, 'queued', ?)")
      .run(pair.originalPath, nowIso());
    const jobId = Number(info.lastInsertRowid);
    // hint 是保留字段位：第一版提示词固定，老师补充语不落库、不进上游请求。
    void hint;
    // AI 未启用（或未注入 worker）时立即给一张可手填的空白草稿，功能等价。
    if (!worker || worker.aiEnabled === false) ensureManualDraft(db, jobId, nowIso());
    // 长连接不等识别结果：返回 202，worker 自己扫 queued。
    if (worker) setImmediate(() => void worker.drain());
    res.status(202).json({ jobId, status: 'queued', imagePath: pair.originalPath });
  });

  router.get('/recognitions', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM recognition_jobs ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ total: rows.length, items: withDrafts(db, rows) });
  });

  router.get('/recognitions/:id', (req, res) => {
    const id = checkId(req.params.id);
    const job = db.prepare('SELECT * FROM recognition_jobs WHERE id = ?').get(id);
    if (!job) notFound('识别任务不存在');
    res.json({ job: publicJob(job), drafts: db.prepare('SELECT * FROM recognition_drafts WHERE job_id = ? ORDER BY seq').all(id).map(publicDraft) });
  });

  router.post('/recognitions/:id/retry', (req, res) => {
    const id = checkId(req.params.id);
    const job = db.prepare('SELECT * FROM recognition_jobs WHERE id = ?').get(id);
    if (!job) notFound('识别任务不存在');
    if (job.status !== 'failed') conflict('只有失败任务可以重试');
    db.prepare("UPDATE recognition_jobs SET status = 'queued', attempts = 0, error_code = NULL, finished_at = NULL WHERE id = ?").run(id);
    res.json({ id, status: 'queued', attempts: 0 });
  });

  router.patch('/recognition-drafts/:id', (req, res) => {
    const id = checkId(req.params.id);
    const row = db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
    if (!row) notFound('草稿不存在');
    if (row.status !== 'pending') conflict('只对待确认草稿可修改');

    const body = req.body ?? {};
    const updates = {};
    for (const [field, max] of Object.entries(TEXT_FIELDS)) {
      if (Object.hasOwn(body, field)) updates[field] = checkText(body[field], field, { max });
    }
    if (Object.hasOwn(body, 'subject')) {
      updates.subject = body.subject === null || body.subject === '' ? null : checkSubject(body.subject);
    }
    if (Object.hasOwn(body, 'options')) {
      if (!Array.isArray(body.options) || body.options.length > 8) {
        throw new ValidationError('options 必须是至多 8 项的数组', 'INVALID_OPTIONS');
      }
      updates.options = JSON.stringify(body.options.map((v) => String(v).slice(0, 200)));
    }
    if (Object.hasOwn(body, 'bbox')) {
      const value = body.bbox;
      const valid = value === null || (Array.isArray(value) && value.length === 4
        && value.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && value[2] > value[0] && value[3] > value[1]);
      if (!valid) throw new ValidationError('bbox 必须是 4 个 0-1 的数字且 x2>x1、y2>y1', 'INVALID_BBOX');
      updates.bbox = value === null ? null : JSON.stringify(value);
    }
    if (Object.hasOwn(body, 'has_figure')) {
      updates.has_figure = body.has_figure ? 1 : 0;
    }
    const keys = Object.keys(updates);
    if (keys.length === 0) throw new ValidationError('没有可修改的白名单字段', 'NO_UPDATABLE_FIELD');
    const sql = `UPDATE recognition_drafts SET ${keys.map((k) => `${k} = ?`).join(', ')}, reviewed_at = ? WHERE id = ?`;
    db.prepare(sql).run(...keys.map((k) => updates[k]), nowIso(), id);
    res.json({ draft: publicDraft(db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id)) });
  });

  router.delete('/recognition-drafts/:id', (req, res) => {
    const id = checkId(req.params.id);
    const row = db.prepare('SELECT * FROM recognition_drafts WHERE id = ?').get(id);
    if (!row) notFound('草稿不存在');
    if (row.status !== 'pending') conflict('只对待确认草稿可丢弃');
    db.prepare("UPDATE recognition_drafts SET status = 'discarded', reviewed_at = ? WHERE id = ?").run(nowIso(), id);
    res.json({ id, status: 'discarded' });
  });

  // 拆分：把一条草稿按题干的切分位置掰成两条，仍是草稿。
  router.post('/recognition-drafts/:id/split', (req, res) => {
    const id = checkId(req.params.id);
    const start = Number(req.body?.start);
    const end = Number(req.body?.end);
    const result = splitDraft(
      db, id,
      Number.isInteger(start) ? start : Number.NaN,
      Number.isInteger(end) ? end : Number.NaN,
    );
    res.json(result);
  });

  // 批量确认：每条独立事务，一条失败不影响其余；重复项返回幂等结果。
  router.post('/recognition-drafts/batch-commit', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length > 50) throw new ValidationError('一次最多确认 50 条草稿', 'TOO_MANY');
    const results = ids.map((raw) => {
      try {
        const result = commitDraft(db, checkId(raw));
        return { id: raw, ok: true, mistakeId: result.mistakeId, idempotent: result.idempotent };
      } catch (error) {
        return { id: raw, ok: false, reason: error.code || 'FAILED' };
      }
    });
    res.json({ committed: results.filter((r) => r.ok && !r.idempotent).length, results });
  });

  router.post('/recognition-drafts/:id/commit', (req, res) => {
    const result = commitDraft(db, checkId(req.params.id), req.body ?? {});
    res.status(result.status).json({
      mistakeId: result.mistakeId,
      idempotent: result.idempotent,
      status: 'new',
    });
  });

  router.get('/ai/status', (req, res) => {
    res.json(aiStatus ? aiStatus() : fallbackAiStatus(db, worker));
  });

  return router;
}
