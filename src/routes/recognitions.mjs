// 识别收件箱路由：上传建 job、任务与草稿查询、人工改草稿、软丢弃、重试。
// 红线：AI 结果只落在 recognition_drafts，只有 #15 的 commit 接口能写 mistakes。
import { Router } from 'express';
import { saveRecognitionPair } from '../lib/images.mjs';
import { checkId, checkText, checkSubject, notFound, conflict, ValidationError } from '../lib/validation.mjs';
import { nowIso } from '../lib/dates.mjs';

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

export function createRecognitionsRouter({ db, dataDir, worker = null }) {
  const router = Router();

  router.post('/recognitions', (req, res) => {
    const { image, derived = null, hint = '' } = req.body ?? {};
    const pair = saveRecognitionPair({ original: image, derived, sharedBasename: true }, dataDir);
    const info = db.prepare("INSERT INTO recognition_jobs (image_path, status, created_at) VALUES (?, 'queued', ?)")
      .run(pair.originalPath, nowIso());
    const jobId = Number(info.lastInsertRowid);
    // hint 是保留字段位：第一版提示词固定，老师补充语不落库、不进上游请求。
    void hint;
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

  return router;
}
